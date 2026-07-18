/**
 * App home / start screen.
 *
 * A full-window view shown when the app launches without a
 * document, when the last open doc is closed, or via the Home
 * affordance in the chrome. Keeps the start surface close to Word:
 * a small sidebar with primary actions, a file search box, recent
 * files, and active collaboration sessions.
 *
 * Visibility is driven by the `pmd-home-active` class on
 * `documentElement`: CSS hides the ribbon / nav pane / editor /
 * status bar while it's set, and reveals `.pmd-home-screen`.
 * The screen itself is mounted once and toggled.
 *
 * All actions are host-agnostic callbacks supplied by the
 * renderer (index.ts), which owns the actual new-doc / open /
 * load-in-place logic.
 */

import {
  listRecents,
  subscribeRecents,
  clearRecents,
  type RecentFile,
} from './recents-store.js';
import {
  baseName,
  dirName,
  fileFormat,
  searchFiles,
  stripFileExt,
  type FileEntry,
} from './file-search.js';
import { isAnyOverlayOpen } from './overlay-stack.js';
import { isEditableTarget } from './editable-target.js';
import { collabEnabled } from './collab/collab-gate.js';
import {
  listSessionRecords,
  deleteSessionRecord,
  subscribeSessionRecords,
  type PersistedSessionRecord,
} from './collab/collab-store.js';
import { endRoomOnRelay } from './collab/collab-relay.js';
import { promptForRouteChoice } from './text-prompt.js';
import { showToast } from './toast.js';

export interface HomeSearchListing {
  path: string;
  relPath: string;
  mtimeMs: number;
  size?: number;
}

export interface HomeScreenCallbacks {
  newDoc: () => void;
  /** Kept for older callers; no longer shown on the home screen. */
  newSpeechDoc: () => void;
  /** Create a native Flow workspace. */
  newFlow: () => void;
  open: () => void;
  /** Reopen a recent file in-place. The renderer reads the
   *  handle, mounts the doc, and prunes the entry on failure. */
  openRecent: (recent: RecentFile) => void;
  /** Open the Quick Cards manage overlay. */
  manageQuickCards: () => void;
  /** Open a listed file by absolute path. */
  openFilePath?: (path: string, name: string) => void;
  /** List searchable `.docx` / `.cmir` files. Electron supplies the
   *  cached recursive folder index; tests can inject a small list. */
  listSearchFiles?: () => Promise<HomeSearchListing[]>;
  /** Open the .docx style cleaner. Electron-only (recursive folder I/O +
   *  write-to-path), like bulkConvert; omitted on the web edition. */
  clean?: () => void;
  /** Open the bulk .docx↔.cmir converter. Omitted (undefined) on
   *  hosts that can't do recursive folder I/O (the web edition), in
   *  which case the button isn't shown. */
  bulkConvert?: () => void;
  /** Open the (temporary) bulk-compress migration tool. Electron-only,
   *  same as bulkConvert. */
  bulkCompress?: () => void;
  /** Resume a persisted collaboration session in this window (M3).
   *  Only consulted while the collab gate is open. */
  resumeSession?: (roomId: string) => void;
}

class HomeScreen {
  private root!: HTMLDivElement;
  private recentsEl!: HTMLDivElement;
  private flowsSection!: HTMLElement;
  private flowsEl!: HTMLDivElement;
  private sessionsSection!: HTMLElement;
  private sessionsEl!: HTMLDivElement;
  private backBtn!: HTMLButtonElement;
  private searchInput!: HTMLInputElement;
  private searchResultsEl!: HTMLDivElement;
  private searchStatusEl!: HTMLDivElement;
  private callbacks: HomeScreenCallbacks | null = null;
  private unsubscribe: (() => void) | null = null;
  private visible = false;
  private searchFiles: FileEntry[] | null = null;
  private searchLoading = false;
  private searchToken = 0;
  /** Whether the current showing was opened over a live document
   *  (Home button) vs. over a blank starter (launch / close-doc).
   *  Drives the "Back to document" affordance + Esc dismissal. */
  private canReturnToDoc = false;
  /** Index-aligned action runners for the numbered home shortcuts. */
  private actionRunners: Array<() => void> = [];

  mount(parent: HTMLElement, callbacks: HomeScreenCallbacks): void {
    this.callbacks = callbacks;
    this.resetSearch();

    this.root = document.createElement('div');
    this.root.className = 'pmd-home-screen';
    this.root.hidden = true;

    const inner = document.createElement('div');
    inner.className = 'pmd-home-inner';
    this.root.appendChild(inner);

    const shell = document.createElement('div');
    shell.className = 'pmd-home-shell';
    inner.appendChild(shell);

    const sidebar = document.createElement('aside');
    sidebar.className = 'pmd-home-sidebar';
    shell.appendChild(sidebar);

    // "Back to document" is only meaningful when home opened over a live doc.
    this.backBtn = document.createElement('button');
    this.backBtn.type = 'button';
    this.backBtn.className = 'pmd-home-back pmd-home-back-small';
    this.backBtn.setAttribute('aria-label', 'Back to document');
    const backArrow = document.createElement('span');
    backArrow.className = 'pmd-home-back-arrow';
    backArrow.setAttribute('aria-hidden', 'true');
    backArrow.textContent = '←';
    this.backBtn.appendChild(backArrow);
    const backLabel = document.createElement('span');
    backLabel.className = 'pmd-home-back-label';
    backLabel.textContent = 'Back to document';
    this.backBtn.appendChild(backLabel);
    this.backBtn.hidden = true;
    this.backBtn.addEventListener('click', () => this.hide());
    sidebar.appendChild(this.backBtn);

    this.actionRunners = [
      () => this.callbacks?.open(),
      () => this.callbacks?.newDoc(),
      () => this.callbacks?.manageQuickCards(),
      () => this.callbacks?.newFlow(),
      () => this.callbacks?.bulkConvert?.(),
    ];
    const actions = document.createElement('nav');
    actions.className = 'pmd-home-actions';
    actions.setAttribute('aria-label', 'Home actions');
    actions.appendChild(this.actionCard('OPEN', '', this.actionRunners[0]!, { icon: 'pmd-icon-open' }));
    actions.appendChild(this.actionCard('NEW', '', this.actionRunners[1]!, { icon: 'pmd-icon-new' }));
    actions.appendChild(this.actionCard('CARDS', '', this.actionRunners[2]!, { icon: 'pmd-icon-bookmark' }));
    actions.appendChild(this.actionCard('FLOW', '', this.actionRunners[3]!, { icon: 'pmd-icon-grid' }));
    actions.appendChild(this.actionCard('CONVERT', '', this.actionRunners[4]!, { icon: 'pmd-icon-reset' }));
    sidebar.appendChild(actions);

    const main = document.createElement('main');
    main.className = 'pmd-home-main';
    shell.appendChild(main);

    const searchSection = document.createElement('section');
    searchSection.className = 'pmd-home-search-section';
    const searchLabel = document.createElement('label');
    searchLabel.className = 'pmd-home-file-search-label';
    searchSection.appendChild(searchLabel);
    const searchIcon = document.createElement('span');
    searchIcon.className = 'pmd-icon pmd-icon-search pmd-home-file-search-icon';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchLabel.appendChild(searchIcon);
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'pmd-home-file-search-input';
    this.searchInput.placeholder = 'Search everything';
    this.searchInput.setAttribute('aria-label', 'Search everything');
    this.searchInput.autocomplete = 'off';
    searchLabel.appendChild(this.searchInput);
    this.searchStatusEl = document.createElement('div');
    this.searchStatusEl.className = 'pmd-home-search-status';
    searchSection.appendChild(this.searchStatusEl);
    this.searchResultsEl = document.createElement('div');
    this.searchResultsEl.className = 'pmd-home-search-results';
    searchSection.appendChild(this.searchResultsEl);
    this.searchInput.addEventListener('focus', () => this.ensureSearchLoaded());
    this.searchInput.addEventListener('input', () => {
      this.ensureSearchLoaded();
      this.renderSearch();
    });
    main.appendChild(searchSection);

    // Recent files.
    const recentsSection = document.createElement('section');
    recentsSection.className = 'pmd-home-recents-section';
    const recentsHeader = document.createElement('div');
    recentsHeader.className = 'pmd-home-recents-header';
    const recentsTitle = document.createElement('h2');
    recentsTitle.className = 'pmd-home-section-title';
    recentsTitle.textContent = 'Recent';
    recentsHeader.appendChild(recentsTitle);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pmd-home-recents-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear the recent-files list';
    clearBtn.addEventListener('click', () => clearRecents());
    recentsHeader.appendChild(clearBtn);
    recentsSection.appendChild(recentsHeader);

    this.recentsEl = document.createElement('div');
    this.recentsEl.className = 'pmd-home-recents';
    recentsSection.appendChild(this.recentsEl);
    main.appendChild(recentsSection);

    // Collaboration sessions — a DEDICATED section right below Recent,
    // deliberately NOT merged into the recents list: normal doc churn
    // caps recents at 6 and would displace a shared session, and a
    // session someone shared with you must never get lost. The list
    // scrolls when long (CSS max-height). Hidden entirely when the
    // collab gate is closed or no session records exist.
    this.sessionsSection = document.createElement('section');
    this.sessionsSection.className = 'pmd-home-sessions-section';
    this.sessionsSection.hidden = true;
    const sessionsTitle = document.createElement('h2');
    sessionsTitle.className = 'pmd-home-section-title';
    sessionsTitle.textContent = 'Sessions';
    this.sessionsSection.appendChild(sessionsTitle);
    this.sessionsEl = document.createElement('div');
    this.sessionsEl.className = 'pmd-home-sessions';
    this.sessionsSection.appendChild(this.sessionsEl);
    main.appendChild(this.sessionsSection);

    this.flowsSection = document.createElement('section');
    this.flowsSection.className = 'pmd-home-flows-section';
    this.flowsSection.hidden = true;
    const flowsTitle = document.createElement('h2');
    flowsTitle.className = 'pmd-home-section-title';
    flowsTitle.textContent = 'Flows';
    this.flowsSection.appendChild(flowsTitle);
    this.flowsEl = document.createElement('div');
    this.flowsEl.className = 'pmd-home-recents pmd-home-flows';
    this.flowsSection.appendChild(this.flowsEl);
    main.appendChild(this.flowsSection);

    parent.appendChild(this.root);

    this.unsubscribe = subscribeRecents(() => {
      this.renderRecents();
      this.renderFlowRecents();
    });
    subscribeSessionRecords(() => void this.renderSessions());
    this.renderRecents();
    this.renderFlowRecents();
    void this.renderSessions();
    this.renderSearch();
  }

  /** Show the home screen. `canReturnToDoc` (default false) is set
   *  when invoked over a live document (the Home button) so the
   *  user can dismiss back to that doc via the Back button or Esc.
   *  On launch / close-doc there's nothing behind home, so it's
   *  left false and home is the only way forward. */
  show(opts: { canReturnToDoc?: boolean } = {}): void {
    // No-op when never mounted (multi-pane mode doesn't mount the
    // home screen). Lets the goHome ribbon command be a safe
    // no-op there rather than throwing on an undefined root.
    if (!this.root) return;
    this.canReturnToDoc = !!opts.canReturnToDoc;
    this.backBtn.hidden = !this.canReturnToDoc;
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    document.documentElement.classList.add('pmd-home-active');
    document.addEventListener('keydown', this.onKeyDown);
    this.resetSearch();
    // Recents may have changed since last shown (another window
    // opened a file); re-read. Same for the learn counts (cards may
    // have been created while a doc was open).
    this.renderRecents();
    this.renderFlowRecents();
    void this.renderSessions();
    this.renderSearch();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    document.documentElement.classList.remove('pmd-home-active');
    document.removeEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Stand down when a modal is layered over the home screen (the shared
    // overlay stack) or focus is in a text field (the command bar, a dialog
    // input). Otherwise the Esc / 1-9 shortcuts fire over the modal and swallow
    // number input the user meant for it.
    if (isAnyOverlayOpen() || isEditableTarget(e.target)) return;
    // Esc dismisses back to the document only when there's one to
    // return to. Otherwise Esc does nothing (home is the hub).
    if (e.key === 'Escape' && this.canReturnToDoc) {
      e.preventDefault();
      this.hide();
      return;
    }
    // Number keys trigger the sidebar actions: 1 Open, 2 New, 3 Quick Cards, 4 Convert.
    // Bare keys only. Text fields are already filtered above.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8 }[e.key];
    if (idx === undefined) return;
    const run = this.actionRunners[idx];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  isVisible(): boolean {
    return this.visible;
  }

  private resetSearch(): void {
    this.searchToken++;
    this.searchFiles = null;
    this.searchLoading = false;
    if (this.searchInput) this.searchInput.value = '';
    this.renderSearch();
  }

  // ---- Rendering ----------------------------------------------------

  private actionCard(
    title: string,
    sub: string,
    onClick: () => void,
    opts?: { disabled?: boolean; icon?: string },
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-home-action';
    if (opts?.icon) {
      const icon = document.createElement('span');
      icon.className = `pmd-icon ${opts.icon} pmd-home-action-icon`;
      icon.setAttribute('aria-hidden', 'true');
      btn.appendChild(icon);
    }
    const text = document.createElement('span');
    text.className = 'pmd-home-action-text';
    const t = document.createElement('span');
    t.className = 'pmd-home-action-title';
    t.textContent = title;
    text.appendChild(t);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'pmd-home-action-sub';
      s.textContent = sub;
      text.appendChild(s);
    }
    btn.appendChild(text);
    if (opts?.disabled) {
      btn.classList.add('pmd-home-action-disabled');
      btn.disabled = true;
    } else {
      btn.addEventListener('click', onClick);
    }
    return btn;
  }

  private ensureSearchLoaded(): void {
    if (this.searchFiles !== null || this.searchLoading) return;
    if (!this.callbacks?.listSearchFiles) {
      this.renderSearch();
      return;
    }
    this.searchLoading = true;
    const token = ++this.searchToken;
    void this.callbacks
      .listSearchFiles()
      .then((list) => {
        if (token !== this.searchToken) return;
        this.searchFiles = toFileEntries(list);
      })
      .catch(() => {
        if (token !== this.searchToken) return;
        this.searchFiles = [];
      })
      .finally(() => {
        if (token !== this.searchToken) return;
        this.searchLoading = false;
        this.renderSearch();
      });
  }

  private renderSearch(): void {
    if (!this.searchResultsEl || !this.searchStatusEl) return;
    this.searchResultsEl.innerHTML = '';
    const query = this.searchInput?.value.trim() ?? '';
    if (!this.callbacks?.listSearchFiles || !this.callbacks?.openFilePath) {
      this.searchStatusEl.textContent = '';
      return;
    }
    if (this.searchLoading) {
      this.searchStatusEl.textContent = 'Searching...';
      return;
    }
    if (this.searchFiles === null) {
      this.searchStatusEl.textContent = '';
      return;
    }
    const matched = searchFiles(this.searchFiles, query, 'recency').slice(0, 12);
    if (matched.length === 0) {
      this.searchStatusEl.textContent = this.searchFiles.length === 0 ? 'No files found.' : 'No matches.';
      return;
    }
    this.searchStatusEl.textContent = '';
    for (const file of matched) {
      this.searchResultsEl.appendChild(this.searchRow(file));
    }
  }

  private searchRow(file: FileEntry): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pmd-home-search-result';
    row.title = file.path;

    const fmt = document.createElement('span');
    fmt.className = `pmd-home-recent-format pmd-home-recent-format-${fileFormat(file.path)}`;
    fmt.textContent = fileFormat(file.path).toUpperCase();
    row.appendChild(fmt);

    const name = document.createElement('span');
    name.className = 'pmd-home-search-name';
    name.textContent = file.name;
    row.appendChild(name);

    const dir = document.createElement('span');
    dir.className = 'pmd-home-search-dir';
    dir.textContent = dirName(file.relPath);
    row.appendChild(dir);

    row.addEventListener('click', () => {
      this.callbacks?.openFilePath?.(file.path, baseName(file.path));
    });
    return row;
  }

  private renderRecents(): void {
    const recents = listRecents().filter((r) => r.format !== 'cmflow');
    this.recentsEl.innerHTML = '';
    if (recents.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-home-recents-empty';
      empty.textContent = 'No recent files yet.';
      this.recentsEl.appendChild(empty);
      return;
    }
    for (const r of recents) {
      this.recentsEl.appendChild(this.recentRow(r));
    }
  }

  private renderFlowRecents(): void {
    if (!this.flowsSection || !this.flowsEl) return;
    const recents = listRecents().filter((r) => r.format === 'cmflow');
    this.flowsSection.hidden = recents.length === 0;
    this.flowsEl.innerHTML = '';
    for (const r of recents) {
      this.flowsEl.appendChild(this.recentRow(r));
    }
  }

  /** Rebuild the Sessions section from the collab store. Hidden when
   *  the gate is closed or no records exist; otherwise one row per
   *  persisted session, newest first (the list scrolls via CSS). */
  private async renderSessions(): Promise<void> {
    if (!this.sessionsSection) return;
    if (!collabEnabled()) {
      this.sessionsSection.hidden = true;
      return;
    }
    const records = (await listSessionRecords()).filter((r) => r.durableRoom !== true);
    this.sessionsSection.hidden = records.length === 0;
    this.sessionsEl.innerHTML = '';
    for (const r of records) {
      this.sessionsEl.appendChild(this.sessionRow(r));
    }
  }

  private sessionRow(record: PersistedSessionRecord): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-home-session';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pmd-home-session-open';
    row.title = 'Resume this collaboration session';

    const chip = document.createElement('span');
    chip.className = 'pmd-home-recent-format pmd-home-session-role';
    chip.textContent = record.role === 'host' ? 'HOST' : 'JOINED';
    row.appendChild(chip);

    const name = document.createElement('span');
    name.className = 'pmd-home-recent-name';
    name.textContent = record.docTitle || 'Collaboration session';
    name.title = name.textContent;
    row.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'pmd-home-recent-path';
    // "saved", not "synced": updatedAt is the local persist-write time, which
    // advances while fully offline.
    meta.textContent = `saved ${relativeTime(record.updatedAt)}`;
    row.appendChild(meta);

    row.addEventListener('click', () => this.callbacks?.resumeSession?.(record.roomId));
    wrap.appendChild(row);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'pmd-home-session-forget';
    forget.textContent = '✕';
    forget.title =
      record.role === 'host'
        ? 'End this session (or just forget your copy)'
        : 'Forget this session (your partner is unaffected)';
    forget.setAttribute(
      'aria-label',
      record.role === 'host' ? 'End or forget this session' : 'Forget this session',
    );
    forget.addEventListener('click', (e) => {
      e.stopPropagation();
      // Participant: purely local — abandoning your copy leaves the room (and
      // everyone in it) untouched.
      if (record.role !== 'host') {
        void deleteSessionRecord(record.roomId);
        return;
      }
      // Host: X should be able to actually END the session. Just deleting the
      // record left the room alive on the relay — previously-invited partners
      // could silently rejoin a session the host thought was gone (field bug,
      // 2026-07-10) — and threw away the host's only handle for ending it.
      void (async (): Promise<void> => {
        const title = record.docTitle || 'this session';
        const choice = await promptForRouteChoice({
          message: `End the session for “${title}”?`,
          choices: [
            {
              value: 'end',
              label: 'End Session',
              tone: 'danger',
              description:
                'Ends it for every participant — they keep their current copies but can no longer sync or rejoin.',
            },
            {
              value: 'forget',
              label: 'Forget My Copy',
              description: 'Removes it from this list only. Others in the session can keep editing.',
            },
          ],
        });
        if (choice === 'end') {
          try {
            await endRoomOnRelay(record.roomId);
          } catch (err) {
            // Keep the record so the host can retry — deleting it without the
            // tombstone would recreate the silent-rejoin bug.
            showToast(
              `Couldn't end the session — check your connection and try again. (${err instanceof Error ? err.message : err})`,
            );
            return;
          }
          await deleteSessionRecord(record.roomId);
          showToast('Session ended for everyone');
        } else if (choice === 'forget') {
          await deleteSessionRecord(record.roomId);
        }
      })();
    });
    wrap.appendChild(forget);

    return wrap;
  }

  private recentRow(recent: RecentFile): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pmd-home-recent';
    // Web entries (handle === null) can't be reopened directly —
    // dim them and disable the click.
    const reopenable = recent.handle != null;
    if (!reopenable) {
      row.classList.add('pmd-home-recent-unavailable');
      row.disabled = true;
      row.title = 'This file was opened in the browser edition and can\'t be reopened from here.';
    } else {
      row.title = recent.handle ?? recent.filename;
    }

    const fmt = document.createElement('span');
    fmt.className = `pmd-home-recent-format pmd-home-recent-format-${recent.format ?? 'unknown'}`;
    fmt.textContent = (recent.format ?? '?').toUpperCase();
    row.appendChild(fmt);

    const name = document.createElement('span');
    name.className = 'pmd-home-recent-name';
    // The format chip already shows .cmir / .docx, so drop the
    // extension from the displayed name to reduce redundancy.
    name.textContent = stripKnownExt(recent.filename);
    name.title = recent.filename;
    row.appendChild(name);

    const path = document.createElement('span');
    path.className = 'pmd-home-recent-path';
    path.textContent = recent.handle ?? '';
    row.appendChild(path);

    if (reopenable) {
      row.addEventListener('click', () => this.callbacks?.openRecent(recent));
    }
    return row;
  }
}

/** Compact "3m ago" / "2h ago" / "5d ago" for session rows. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function toFileEntries(list: readonly HomeSearchListing[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const it of list) {
    if (!it.path || !it.relPath) continue;
    if (byPath.has(it.path)) continue;
    byPath.set(it.path, {
      path: it.path,
      relPath: it.relPath,
      name: stripFileExt(baseName(it.relPath)),
      mtimeMs: Number.isFinite(it.mtimeMs) ? it.mtimeMs : 0,
    });
  }
  return [...byPath.values()];
}

/** Drop a trailing openable extension for display. */
function stripKnownExt(name: string): string {
  return name.replace(/\.(cmir|docx|cmflow)$/i, '');
}

export const homeScreen = new HomeScreen();
