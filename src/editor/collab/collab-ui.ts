/**
 * Collaboration-session UI flows: start / join / copy-code / end,
 * wired to the ribbon commands, plus the status-bar chip. Lazily
 * imported (this module pulls the Loro wasm via collab-session).
 *
 * One session per window at a time, bound to the single-doc view. The
 * flows own the editor's collab seams (collab-hooks): while a session
 * is live they register the plugin source (Loro sync + undo manager),
 * the transaction tagger (stamps sync-origin on the binding's remote
 * transactions so read mode and the AI coordinator admit them), and
 * refresh the plugin stack through the injected reconfigure capability.
 *
 * Invite transport: the share code (clipboard) and, on desktop, sealed
 * pairing-mailbox invites (inviteStarredFlow / joinSessionWithCode via
 * the Receive pill's Join).
 */

import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin, loroSyncPluginKey, loroUndoPluginKey, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { promptForText, promptForRouteChoice, confirmDialog } from '../text-prompt.js';
import { markSyncOrigin } from '../sync-origin.js';
import { readModePlugin } from '../read-mode-plugin.js';
import {
  registerCollabPluginSource,
  unregisterCollabPluginSource,
  setCollabTransactionTagger,
  setCollabCopresenceProvider,
  notifyCollabCopresenceChange,
  setCollabCloseActions,
  setCollabHandoffProvider,
  setCollabSessionCountProvider,
  setCollabLiveRoomProbe,
  setCollabFocusChangeHandler,
  collabRoomClaimKey,
} from './collab-hooks.js';
import { RoomsError } from './room-client.js';
import { getElectronHost, getHost } from '../host/index.js';
import { ensureBakedRelay, relayClient, endRoomOnRelay } from './collab-relay.js';
import { relayClient as pairingRelayClient } from '../pairing/relay-client.js';
import { resolveStarredTarget } from '../pairing/send-to-starred.js';
import { buildRoomInviteItem, ROOM_INVITE_MIN_VERSION } from '../pairing/room-invite.js';
import { collabInvariantHealPlugin } from './collab-invariants.js';
import {
  installCommentsSync,
  COMMENTS_COMMIT_ORIGIN,
  type CommentsSyncHandle,
} from './collab-comments.js';
import { UndoManager } from 'loro-crdt';
import { attachSessionPersistence, type PersistHandle } from './collab-persist.js';
import { installCursorPresence, type CursorsHandle } from './collab-cursors.js';
import { collabRepairPlugin, lowestPeerIsLeader } from './collab-repair.js';
import {
  deleteSessionRecord,
  loadSessionRecord,
  loadPrefetch,
  deletePrefetch,
} from './collab-store.js';
import { importRoomKey, decryptBlob } from './collab-crypto.js';
import { resetSessionCommentIds } from '../comments-plugin.js';
import { collabEnabled } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { CollabSession, type SharedDocMetadata } from './collab-session.js';
import {
  createSoloSessionWatch,
  observeSoloSessionPresence,
  type SoloSessionWatch,
} from './solo-session.js';

export interface CollabUiDeps {
  getView(): EditorView | null;
  refreshPlugins(): void;
  /** The `DocRecord.uid` of the document this session is being started/joined
   *  for — captured at install so the binding plugins only ever attach to that
   *  one doc's view (multi-pane fusion guard). */
  getOwnerUid?(): string | null;
  /** Resolve a doc uid to its live view. A session binds its cursors/comments to
   *  its OWNER's view via this (not the focused view), so in multi-pane each
   *  doc's presence renders in its own pane. Falls back to the focused view. */
  getViewForUid?(uid: string): EditorView | null;
  /** Rebuild the plugin stack of the doc with `uid` (its own view — NOT the
   *  focused one). Session-END paths use this so an unfocused owner pane
   *  doesn't keep dead collab plugins. Falls back to refreshPlugins(). */
  refreshPluginsForUid?(uid: string): void;
  setSharedDocForUid?(uid: string, sharedDoc: SharedDocMetadata | null): void;
  /** Persist a newly-created shared-document pointer into the owning `.cmir`
   *  file. Auto-collab depends on this: the second computer can only auto-join
   *  after the shared file carries the persistent room metadata. */
  persistSharedDocForUid?(uid: string, sharedDoc: SharedDocMetadata): void | Promise<void>;
  markDirtyForUid?(uid: string): void;
  /** Swap THIS window's editor to a fresh unsaved doc for a joined
   *  session — must never spawn a window (the binding installs into the
   *  current view; a spawned window would never get it — field bug on
   *  desktop, 2026-07-03). Resolves false if the user cancelled out of
   *  overwriting unsaved edits. */
  newSessionDoc(): boolean | Promise<boolean>;
  /** Name the (unsaved) session doc in this window: window title, the
   *  filename chip, and the save-as default. Joiners get the host's
   *  title through the room's meta map — without this the window and
   *  the Sessions list just say "collaboration session" (field bug,
   *  2026-07-03). */
  setDocTitle?(title: string): void;
  /** Desktop multi-window: when the current window has a real doc open (not
   *  the disposable starter), spawn a NEW window to host the joined session
   *  and return true — the caller then aborts, and the spawned window runs
   *  the full join itself (so the session + Loro binding land together,
   *  never stranded). Returns false to join in THIS window (starter open, or
   *  single-window / web). */
  spawnJoinWindow?(shareCode: string): boolean;
}

/** One live co-editing session, owned by a single open doc (the map key). A
 *  multi-pane window can hold several — one per doc. */
interface ActiveSession {
  session: CollabSession;
  shareCode: string;
  ownerUid: string;
  cursors: CursorsHandle;
  commentsSync: CommentsSyncHandle;
  persist: PersistHandle;
  wakeCleanup: () => void;
  clearSharedDoc: () => void;
  /** Latest connection status for THIS session. The shared status-bar chip only
   *  ever reflects the focused doc's session; storing status per session lets
   *  each multi-pane slot footer render its own visible doc's state. */
  lastStatus: { connected: boolean; queuedUpdates: number } | null;
  soloWatch: SoloSessionWatch;
  autoEndingSolo: boolean;
  refreshOwnerPlugins: () => void;
}

const sessions = new Map<string, ActiveSession>();

type CollabUiStatus = {
  connected: boolean;
  queuedUpdates: number;
  /** Relay answers REST even though live push is unavailable — the doc is
   *  still syncing (by polling), so don't report it as offline. */
  relayReachable?: boolean;
};

interface SharedDocOpenState {
  sharedDoc: SharedDocMetadata;
  status: 'connecting' | 'local';
  detail?: string;
}

const sharedDocOpenStates = new Map<string, SharedDocOpenState>();

interface SharedDocReconnect {
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  /** Last failure toast shown for this doc — repeated retry failures with
   *  the same cause stay silent instead of re-toasting every cycle. */
  lastToast?: string;
}

const sharedDocReconnects = new Map<string, SharedDocReconnect>();
const SHARED_DOC_RECONNECT_MIN_MS = 500;
const SHARED_DOC_RECONNECT_MAX_MS = 8_000;

/** Commit origin for session meta-map writes (title publishing) — excluded
 *  from the session UndoManager alongside comment writes, so Ctrl+Z never
 *  un-publishes the shared title. */
const META_COMMIT_ORIGIN = 'cm-meta';

/** Focused doc's uid — set by the editor host so no-deps UI helpers (chip,
 *  presence, copy-code, invite) can find the session the user is looking at. */
let focusedUidResolver: (() => string | null) | null = null;
export function setCollabFocusResolver(fn: (() => string | null) | null): void {
  focusedUidResolver = fn;
}

/** Resolve a doc uid → its display filename, set by the host so no-deps helpers
 *  (invite, persist label) and the start flow name a session after its OWNER
 *  doc rather than `document.title` — which in multi-pane is every open doc
 *  joined by " · ". */
let docTitleResolver: ((uid: string) => string | null) | null = null;
export function setCollabDocTitleResolver(fn: ((uid: string) => string | null) | null): void {
  docTitleResolver = fn;
}

/** The session owned by `uid`, or null. */
function sessionFor(uid: string | null | undefined): ActiveSession | null {
  return uid != null ? sessions.get(uid) ?? null : null;
}

function depsForOwner(deps: CollabUiDeps, ownerUid: string): CollabUiDeps {
  return {
    ...deps,
    getView: () => deps.getViewForUid?.(ownerUid) ?? deps.getView(),
    getOwnerUid: () => ownerUid,
    refreshPlugins: () => {
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(ownerUid);
      else deps.refreshPlugins();
    },
  };
}

function clearSharedDocReconnect(ownerUid: string): void {
  const retry = sharedDocReconnects.get(ownerUid);
  if (!retry) return;
  if (retry.timer !== null) clearTimeout(retry.timer);
  sharedDocReconnects.delete(ownerUid);
}

// Feed the multi-pane shell's per-slot footers: each slot paints the copresence
// of ITS visible doc's session (or nothing when that doc isn't in a session).
setCollabCopresenceProvider((uid) => {
  const sess = sessionFor(uid);
  if (!sess) return null;
  return {
    role: sess.session.role,
    // Before the first onStatus, assume connected (start() flushes immediately);
    // the flows also stamp lastStatus so an offline join/resume reads correctly.
    connected: sess.lastStatus?.connected ?? true,
    queued: sess.lastStatus?.queuedUpdates ?? 0,
    peers: sess.cursors
      .presence()
      .map((p) => ({ peer: p.peer, name: p.name, color: p.color, self: p.self })),
  };
});

// Close-time actions for a co-edited doc, called by the always-loaded close
// paths (multi-pane shell + single-doc) via collab-hooks. Registered once here.
setCollabCloseActions({
  keepResumable: (uid) => closeKeepResumableSession(uid),
  endOrLeave: (uid) => closeEndOrLeaveSession(uid),
});

// Mode-switch hand-off: flush every live session's record (so unsynced edits
// survive the toggle's reload) and report {uid, roomId} so the post-reload flow
// can auto-resume each into the doc that reopens under its uid.
setCollabHandoffProvider(async () => {
  const list = [...sessions.values()].map((s) => ({
    uid: s.ownerUid,
    roomId: s.session.roomId,
    durableRoom: s.session.durableRoom,
  }));
  await Promise.all([...sessions.values()].map((s) => s.persist.flush()));
  return list;
});
setCollabSessionCountProvider(() => sessions.size);
setCollabLiveRoomProbe((roomId) =>
  [...sessions.values()].some((s) => s.session.roomId === roomId),
);
setCollabFocusChangeHandler(() => refreshChipForFocus());

let copresenceNotifyQueued = false;
function queueCollabCopresenceChange(): void {
  if (copresenceNotifyQueued) return;
  copresenceNotifyQueued = true;
  const flush = (): void => {
    copresenceNotifyQueued = false;
    notifyCollabCopresenceChange();
  };
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
}

// Cross-window live-session claims ride the duplicate-open path registry.
// All three are best-effort and swallow everything: an old preload (or a
// test harness) without the openPath API must not break session flows.
function claimRoom(roomId: string): void {
  try {
    void getElectronHost()?.openPathRegister(collabRoomClaimKey(roomId)).catch(() => {});
  } catch {
    /* API absent — no cross-window guard, sessions still work */
  }
}
function releaseRoomClaim(roomId: string): void {
  try {
    void getElectronHost()?.openPathRelease(collabRoomClaimKey(roomId)).catch(() => {});
  } catch {
    /* API absent */
  }
}
async function roomLiveElsewhere(roomId: string): Promise<boolean> {
  try {
    return (await getElectronHost()?.openPathCheck(collabRoomClaimKey(roomId)))?.takenByOther ?? false;
  } catch {
    return false;
  }
}

/** The session the shared chip / no-deps flows act on: the focused doc's, or —
 *  when focus isn't resolvable (or that doc has no session) — the sole session
 *  if there's exactly one. (A later step adds a per-slot footer so every
 *  session's status shows at once; until then the single chip follows focus.) */
function chipSession(): ActiveSession | null {
  const focused = focusedUidResolver?.() ?? null;
  if (focused) return sessionFor(focused);
  return sessions.size === 1 ? [...sessions.values()][0]! : null;
}

/** The session UI ACTIONS act on (copy code, invite starred): STRICTLY the
 *  focused doc's session. The sole-session fallback applies only when focus is
 *  unresolvable (no resolver registered — bare single-pane); falling back while
 *  the user is LOOKING at a session-less doc invited partners into a different
 *  doc's session (audit find, 2026-07-10). Display (chipSession) keeps the
 *  fallback — showing the one live session is fine; acting on it is not. */
function actionSession(): ActiveSession | null {
  const focused = focusedUidResolver?.() ?? null;
  if (focused != null) return sessionFor(focused);
  return sessions.size === 1 ? [...sessions.values()][0]! : null;
}

function chipSharedDocState(): SharedDocOpenState | null {
  const focused = focusedUidResolver?.() ?? null;
  if (focused != null) return sharedDocOpenStates.get(focused) ?? null;
  return sharedDocOpenStates.size === 1 ? [...sharedDocOpenStates.values()][0]! : null;
}

function actionSharedDocState(): SharedDocOpenState | null {
  const focused = focusedUidResolver?.() ?? null;
  if (focused != null) return sharedDocOpenStates.get(focused) ?? null;
  return sharedDocOpenStates.size === 1 ? [...sharedDocOpenStates.values()][0]! : null;
}

function setSharedDocOpenState(ownerUid: string, state: SharedDocOpenState | null): void {
  if (state) sharedDocOpenStates.set(ownerUid, state);
  else {
    sharedDocOpenStates.delete(ownerUid);
    clearSharedDocReconnect(ownerUid);
  }
  if (!sessionFor(ownerUid)) refreshChipForFocus();
}

function sameSharedDocState(
  state: SharedDocOpenState | null | undefined,
  sharedDoc: SharedDocMetadata,
): boolean {
  return state?.sharedDoc.roomId === sharedDoc.roomId && state.sharedDoc.shareCode === sharedDoc.shareCode;
}

function scheduleSharedDocReconnect(
  deps: CollabUiDeps,
  sharedDoc: SharedDocMetadata,
  ownerUid: string,
): void {
  if (!ownerUid) return;
  const existing = sharedDocReconnects.get(ownerUid);
  if (existing?.timer) return;
  const lastToast = existing?.lastToast;
  const attempt = (existing?.attempt ?? 0) + 1;
  const base = Math.min(
    SHARED_DOC_RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 4),
    SHARED_DOC_RECONNECT_MAX_MS,
  );
  const jitter = 0.8 + Math.random() * 0.4;
  const timer = setTimeout(() => {
    const state = sharedDocReconnects.get(ownerUid);
    if (state) state.timer = null;
    if (sessionFor(ownerUid)) {
      clearSharedDocReconnect(ownerUid);
      return;
    }
    if (!sameSharedDocState(sharedDocOpenStates.get(ownerUid), sharedDoc)) {
      clearSharedDocReconnect(ownerUid);
      return;
    }
    void connectSharedDocFlow(depsForOwner(deps, ownerUid), sharedDoc);
  }, base * jitter);
  sharedDocReconnects.set(ownerUid, { attempt, timer, ...(lastToast ? { lastToast } : {}) });
}

function keepSharedDocConnecting(
  deps: CollabUiDeps,
  sharedDoc: SharedDocMetadata,
  ownerUid: string,
  detail?: string,
  toast?: string,
): false {
  if (toast) {
    // One toast per distinct failure cause — the retry loop re-enters this
    // path every few seconds, and re-toasting the same message each cycle
    // buries the editor under an endless "session has ended" stream.
    const entry = sharedDocReconnects.get(ownerUid);
    if (entry?.lastToast !== toast) showToast(toast);
    if (entry) entry.lastToast = toast;
    else sharedDocReconnects.set(ownerUid, { timer: null, attempt: 0, lastToast: toast });
  }
  setSharedDocOpenState(ownerUid, {
    sharedDoc,
    status: 'connecting',
    ...(detail ? { detail } : {}),
  });
  scheduleSharedDocReconnect(deps, sharedDoc, ownerUid);
  return false;
}

/** True when the relay is reachable and answers that this durable room no
 *  longer exists (redeployed relay, wiped storage, an ended/archived doc).
 *  Network-level failures and auth problems return false — those are
 *  retryable outages, not proof the room is gone. */
async function durableRoomGone(
  client: NonNullable<ReturnType<typeof relayClient>>,
  sharedDoc: SharedDocMetadata,
): Promise<boolean> {
  try {
    // Cheap metadata probe — the designed endpoint for exactly this
    // question. (An updates-tail probe was fragile: a relay that validates
    // its `after` cursor rejects a beyond-tail value, and probing from 0
    // downloaded the whole backlog twice.)
    const info = await client.getPersistentDoc(sharedDoc.docId);
    return info.archived || info.ended;
  } catch (err) {
    return err instanceof RoomsError && (err.status === 404 || err.status === 410);
  }
}

/** A live durable session whose room has been 404/410 for a stretch: confirm
 *  it is truly gone (not a transient blip), then tear it down and re-host a
 *  fresh room from the local view. The view holds the current content
 *  (including any offline edits — the Loro binding keeps it in sync), and the
 *  dead room has no surviving peers to merge with, so seeding the new room
 *  from the view is correct. Converts "stuck reconnecting forever" into a
 *  live session on a fresh room. */
const rehostingOwners = new Set<string>();
async function rehostGoneDurableRoom(deps: CollabUiDeps, sess: ActiveSession): Promise<void> {
  const ownerUid = sess.ownerUid;
  if (rehostingOwners.has(ownerUid)) return;
  rehostingOwners.add(ownerUid);
  try {
    await ensureBakedRelay();
    const client = relayClient();
    // For persistent document rooms roomId === docId, so the roomId probes
    // the doc's liveness. If the relay says it's actually still there, keep
    // the existing session retrying — this was only a transient outage.
    const roomId = sess.session.roomId;
    if (
      client &&
      !(await durableRoomGone(client, {
        docId: roomId,
        roomId,
        shareCode: sess.shareCode,
        createdAt: '',
      }))
    ) {
      return;
    }
    if (!sessions.has(ownerUid)) return; // ended/closed meanwhile
    showToast('The co-editing room was gone — created a fresh one for this document');
    await replaceDurableRoom(deps, sess);
  } catch (err) {
    console.warn('Re-host of a gone durable room failed:', err);
  } finally {
    rehostingOwners.delete(ownerUid);
  }
}

/** Tear down a durable session and host a FRESH room seeded from the local
 *  view. The view carries the current content, so nothing local is lost.
 *
 *  Reports failure instead of swallowing it: the auto-start path stays quiet
 *  on error by design, so a failed re-host used to leave the file silently
 *  pointing at the OLD (unreachable) room — the user saw nothing change and
 *  reopening went straight back to "reconnecting" (field bug 2026-07-20). */
async function replaceDurableRoom(deps: CollabUiDeps, sess: ActiveSession): Promise<boolean> {
  const ownerUid = sess.ownerUid;
  // Kill any pending retry for the OLD pointer first — otherwise its timer
  // fires mid-rehost and races the new session onto the dead room.
  clearSharedDocReconnect(ownerUid);
  setSharedDocOpenState(ownerUid, null);
  await sess.session.stop();
  await teardownSession(sess); // clears the resume record + shared-doc pointer
  const ok = await autoStartSharedDocFlow(depsForOwner(deps, ownerUid));
  if (!ok) {
    showToast(
      'Could not create a fresh co-editing room — this document stays local for now. ' +
        'Check Settings → Collaboration, then reopen the file to retry.',
    );
  }
  return ok;
}

/** A durable room that keeps answering 409 "full". The usual cause is this
 *  app's OWN leaked streams from earlier quits/crashes (the relay counts a
 *  socket until it reaps it), which wedges the file on "reconnecting"
 *  indefinitely. Offer the escape that always works — a fresh room — instead
 *  of retrying silently forever. Asked, not automatic: if the room really is
 *  full of live partners, replacing it would split the group. */
async function offerRehostForFullRoom(deps: CollabUiDeps, sess: ActiveSession): Promise<void> {
  const ownerUid = sess.ownerUid;
  if (rehostingOwners.has(ownerUid)) return;
  rehostingOwners.add(ownerUid);
  try {
    const ok = await confirmDialog(
      "This document's co-editing room is refusing new connections (it reports being full). " +
        'That is usually left over from an earlier crash or quit rather than real partners. ' +
        'Creating a fresh room reconnects this document immediately — your copy is kept as-is, ' +
        'and anyone else editing it picks up the new room when they reopen the file.',
      {
        title: 'Stuck reconnecting — start a fresh room?',
        okLabel: 'Create Fresh Room',
        cancelLabel: 'Keep Retrying',
      },
    );
    if (!ok) return;
    if (!sessions.has(ownerUid)) return; // ended/closed while the dialog was up
    await replaceDurableRoom(deps, sess);
  } catch (err) {
    console.warn('Re-host of a full durable room failed:', err);
  } finally {
    rehostingOwners.delete(ownerUid);
  }
}

function chipEl(): HTMLElement | null {
  return document.getElementById('collab-chip');
}

function clearChipVisualState(chip: HTMLElement): void {
  delete chip.dataset.collabState;
}

function hideBottomChip(): void {
  const chip = chipEl();
  if (!chip) return;
  chip.hidden = true;
  chip.replaceChildren();
  chip.removeAttribute('title');
  clearChipVisualState(chip);
}

function isMultiDocWorkspace(): boolean {
  return document.body.classList.contains('pmd-multi-doc');
}

type BottomCollabState = 'synced' | 'sending' | 'polling' | 'reconnecting' | 'offline';

function bottomCollabState(status: CollabUiStatus): BottomCollabState {
  if (status.connected && status.queuedUpdates === 0) return 'synced';
  if (status.connected) return 'sending';
  // Stream down but the relay answers REST: the document IS syncing, just by
  // polling instead of live push (e.g. the room's stream slots are exhausted).
  // Calling that "offline" was simply wrong — edits were flowing (field bug
  // 2026-07-20).
  if (status.relayReachable) return 'polling';
  return status.queuedUpdates > 0 ? 'offline' : 'reconnecting';
}

function bottomCollabTitle(status: CollabUiStatus): string {
  const state = bottomCollabState(status);
  if (state === 'synced') return 'Live: synced';
  if (state === 'sending') {
    const n = status.queuedUpdates;
    return `Live: sending ${n} update${n === 1 ? '' : 's'}`;
  }
  if (state === 'polling') {
    const n = status.queuedUpdates;
    return n > 0
      ? `Syncing ${n} change${n === 1 ? '' : 's'} (no live connection — updates every few seconds)`
      : 'Syncing (no live connection — updates every few seconds)';
  }
  if (state === 'offline') return 'Live: offline, retrying unsent changes';
  return 'Live: reconnecting';
}

function renderBottomLiveChip(status: CollabUiStatus): void {
  const chip = chipEl();
  if (!chip) return;
  if (isMultiDocWorkspace()) {
    hideBottomChip();
    return;
  }
  chip.hidden = false;
  chip.replaceChildren();
  chip.dataset.collabState = bottomCollabState(status);
  chip.title = bottomCollabTitle(status);

  const dot = document.createElement('span');
  dot.className = 'pmd-collab-live-dot';
  dot.setAttribute('aria-hidden', 'true');
  chip.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'pmd-collab-chip-label';
  label.textContent = 'Live';
  chip.appendChild(label);
}

function updateChip(status: CollabUiStatus | null): void {
  if (!status) {
    hideBottomChip();
    renderTopPresence([], null);
    return;
  }
  renderBottomLiveChip(status);
  renderTopPresence(currentPresence(), status);
}

function updateSharedDocChip(_state: SharedDocOpenState | null): void {
  hideBottomChip();
  renderTopPresence([], null);
}

interface PresencePerson {
  peer: string;
  name: string;
  color: string;
  self: boolean;
}

function currentPresence(): PresencePerson[] {
  return chipSession()?.cursors.presence() ?? [];
}

function personDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed || 'Anonymous';
}

function personInitial(name: string): string {
  const display = personDisplayName(name);
  if (display === 'Anonymous') return 'A';
  const words = display.split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('');
  return (letters || Array.from(display)[0] || 'A').toUpperCase();
}

function jumpToPresencePeer(peer: string): void {
  const sess = chipSession();
  if (!sess) return;
  if (!sess.cursors.jumpToPeer(peer)) showToast('No active cursor for that person yet');
}

function renderTopPresence(
  peers: PresencePerson[],
  _status: CollabUiStatus | null,
  onJump: (peer: string) => void = jumpToPresencePeer,
): void {
  const strip = document.getElementById('collab-top-presence');
  if (!(strip instanceof HTMLElement)) return;
  const hasPartner = peers.some((p) => !p.self);
  if (!hasPartner) {
    strip.hidden = true;
    strip.replaceChildren();
    strip.removeAttribute('title');
    return;
  }
  strip.hidden = false;
  strip.replaceChildren();

  for (const p of peers) {
    const displayName = personDisplayName(p.name);
    const avatar = document.createElement('span');
    avatar.className = 'pmd-collab-avatar' + (p.self ? ' pmd-collab-avatar-self' : '');
    avatar.dataset['peer'] = p.peer;
    avatar.style.background = p.color;
    avatar.textContent = personInitial(p.name);
    avatar.title = p.self ? `${displayName} (you)` : displayName;
    if (!p.self) {
      avatar.tabIndex = 0;
      avatar.setAttribute('role', 'button');
      avatar.setAttribute('aria-label', `Jump to ${displayName}'s cursor`);
      const jump = (): void => onJump(p.peer);
      avatar.addEventListener('click', jump);
      avatar.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        jump();
      });
    }
    strip.appendChild(avatar);
  }
  const names = peers.map((p) => {
    const displayName = personDisplayName(p.name);
    return p.self ? `${displayName} (you)` : displayName;
  });
  strip.title = `Editing now: ${names.join(', ')}. Partner colored cursors show where they are editing.`;
}

export function renderTopPresenceForTests(
  peers: PresencePerson[],
  status: CollabUiStatus | null = null,
  onJump?: (peer: string) => void,
): void {
  renderTopPresence(peers, status, onJump);
}

/** Re-render just the dots (peers join/leave/expire between chip updates). */
function refreshPresenceDots(): void {
  const sess = chipSession();
  const peers = sess?.cursors.presence() ?? [];
  const status = sess?.lastStatus ?? (sess ? { connected: true, queuedUpdates: 0 } : null);
  if (status) renderBottomLiveChip(status);
  else hideBottomChip();
  renderTopPresence(peers, status);
  checkSoloSessions();
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;

function sessionStatusForSolo(sess: ActiveSession): { connected: boolean; queuedUpdates: number } {
  return {
    connected: sess.lastStatus?.connected ?? true,
    queuedUpdates: sess.session.queuedUpdates,
  };
}

function checkSoloSessions(now = Date.now()): void {
  for (const sess of sessions.values()) {
    checkSoloSession(sess, now);
  }
}

function checkSoloSession(sess: ActiveSession, now = Date.now()): void {
  if (sess.session.durableRoom) return;
  if (sess.autoEndingSolo) return;
  const shouldEnd = observeSoloSessionPresence(
    sess.soloWatch,
    sess.cursors.presence(),
    sessionStatusForSolo(sess),
    now,
  );
  if (!shouldEnd) return;
  sess.autoEndingSolo = true;
  void autoEndSoloSession(sess).finally(() => {
    const live = sessionFor(sess.ownerUid);
    if (live === sess) sess.autoEndingSolo = false;
  });
}

async function discardRecoveryJournal(sess: ActiveSession): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    await host.deleteJournal(sess.ownerUid);
  } catch (err) {
    console.warn(`Failed to drop synced co-edit journal for ${sess.ownerUid}:`, err);
  }
}

async function discardRecoveryJournalIfSynced(sess: ActiveSession): Promise<void> {
  if (sess.session.queuedUpdates > 0) return;
  await discardRecoveryJournal(sess);
}

async function autoEndSoloSession(sess: ActiveSession): Promise<void> {
  if (!sessions.has(sess.ownerUid)) return;
  const ownerUid = sess.ownerUid;
  const wasHost = sess.session.role === 'host';
  if (!(await endOrLeaveSession(sess))) return;
  if (sessions.has(ownerUid)) return;
  sess.refreshOwnerPlugins();
  if (sess.session.role === 'host' && wasHost) {
    showToast('Co-editing ended because only you were left in the session');
  } else {
    showToast('Co-editing stopped because only you were left in the session');
  }
}


/** Stamp the Loro binding's own transactions as sync-origin: both the
 *  remote-update imports and the init-time content replace carry the
 *  binding's meta, and neither is a user edit — read mode and the AI
 *  coordinator must admit them (rejection desyncs editor from CRDT). */
function collabTagger(tr: Parameters<typeof markSyncOrigin>[0]): void {
  if (tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined) {
    markSyncOrigin(tr);
  }
}


/** Wake-from-sleep / network-return hooks (M3): a resumed laptop's
 *  stream socket is silently dead until timeouts notice — restart it
 *  the moment the OS tells us. Desktop: powerMonitor via the host
 *  seam; both editions: the browser 'online' event. */
function installWakeHooks(session: CollabSession): () => void {
  const onOnline = (): void => session.restart();
  window.addEventListener('online', onOnline);
  const offResume = getElectronHost()?.onPowerResumed?.(() => session.restart()) ?? null;
  // Returning to the window is the moment a user notices a dead session —
  // check liveness right then instead of waiting for the stall watchdog.
  // ensureLive() is a no-op while the stream is healthy, so this stays
  // free on ordinary tab/window switches.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') session.ensureLive();
  };
  document.addEventListener('visibilitychange', onVisible);
  // Free the relay's participant slot on teardown. Without this every quit
  // leaked a stream the relay kept counting, until the room answered 409
  // "full" to its own owner and the file stuck on "reconnecting" forever.
  const onPageHide = (): void => session.releaseForUnload();
  window.addEventListener('pagehide', onPageHide);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', onPageHide);
    offResume?.();
  };
}

/** Build a session's seams, register it, and return the ActiveSession. The
 *  cursors/comments bind to the OWNER's view (not focus) so each doc's presence
 *  renders in its own pane. Window-level seams (tagger, presence timer, comment-
 *  id mode) are shared across every live session and retired in `teardownSession`
 *  when the last one ends. `ownerUid` is the map key (the focused doc at start). */
/** `ownerUid` is the map key and the doc the seams bind into. It is passed in
 *  (not re-read from `deps.getOwnerUid()` here) because every caller has already
 *  awaited a confirm dialog and/or a relay round-trip by this point: re-reading
 *  focus now would bind the session onto whatever doc the user has since clicked
 *  into. Callers capture it at the moment that fixes the target — start: the
 *  focused doc when Start was chosen; join/resume: the freshly-created session
 *  doc right after newSessionDoc(). */
function installSeams(
  session: CollabSession,
  deps: CollabUiDeps,
  shareCode: string,
  ownerUid: string,
): ActiveSession {
  setSharedDocOpenState(ownerUid, null);
  const ownerView = (): EditorView | null =>
    (ownerUid ? deps.getViewForUid?.(ownerUid) ?? null : null) ?? deps.getView();
  // One shared tagger stamps ANY binding transaction (keyed off the Loro plugin
  // meta), so it serves every session; installed while ≥1 is live.
  setCollabTransactionTagger(collabTagger);
  const wakeCleanup = installWakeHooks(session);
  const commentsSync = installCommentsSync(session.loroDoc, ownerView);
  // M3: crash-surviving session record (home-screen Sessions list resumes it).
  const persist = attachSessionPersistence(session, shareCode, () =>
    sessionDocTitle(ownerUid) || sharedDocTitle(session),
  );
  const cursors = installCursorPresence(session, ownerView);
  // One shared timer refreshes the focused session's chip dots AND every slot
  // footer's copresence (peers join/leave/expire between status updates).
  if (presenceTimer === null)
    presenceTimer = setInterval(() => {
      refreshPresenceDots();
      notifyCollabCopresenceChange();
    }, 3000);
  // Comment-id allocation is per-doc now (the host's resolver tests each doc's
  // session state), so nothing to toggle on here — a co-edited doc's new
  // comments get random ids to avoid two peers colliding on the counter.
  const sess: ActiveSession = {
    session,
    shareCode,
    ownerUid,
    cursors,
    commentsSync,
    persist,
    wakeCleanup,
    clearSharedDoc: () => {
      deps.setSharedDocForUid?.(ownerUid, null);
      deps.markDirtyForUid?.(ownerUid);
    },
    lastStatus: null,
    soloWatch: createSoloSessionWatch(),
    autoEndingSolo: false,
    refreshOwnerPlugins: () => {
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(ownerUid);
      else deps.refreshPlugins();
    },
  };
  sessions.set(ownerUid, sess);
  // Cross-window live-session claim: while this session is live, other
  // windows' Sessions rows (and join-by-code) refuse the same room and focus
  // this window instead — same registry as the duplicate-file-open guard.
  // Best-effort; released in teardownSession (and by main when this window
  // dies).
  claimRoom(session.roomId);
  // A session just appeared — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  registerCollabPluginSource({
    ownerUid,
    plugins: () => [
      ...session.plugins(),
      // A pre-configured manager (the plugin otherwise builds its own):
      // comment-mirror and meta writes commit with excluded origins, so the
      // undo stack holds ONLY document edits — Ctrl+Z was silently deleting
      // comments/replies session-wide when a comment op sat on top of it
      // (audit find, 2026-07-10). The plugin still adds 'sys:init' and wires
      // its own cursor-restore hooks onto this manager.
      LoroUndoPlugin({
        doc: session.loroDoc,
        undoManager: new UndoManager(session.loroDoc, {
          excludeOriginPrefixes: [COMMENTS_COMMIT_ORIGIN, META_COMMIT_ORIGIN],
        }),
      }),
      collabInvariantHealPlugin(),
      collabRepairPlugin(() =>
        lowestPeerIsLeader(session.loroDoc.peerIdStr, cursors.visiblePeers()),
      ),
      commentsSync.plugin,
      ...cursors.plugins(),
    ],
    ownsUndo: () => true,
    // Read-mode clamp (M4): swallow undo/redo entirely while reading — the Loro
    // undo transactions carry the binding meta (→ sync-origin) and would
    // otherwise sail through the read-mode lock and revert real edits.
    undo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroUndo(state, dispatch, view),
    redo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroRedo(state, dispatch, view),
  });
  return sess;
}

/** Dispose one session's seams + drop it from the registry. Window-level shared
 *  seams (tagger / presence timer / comment-id mode) are retired only when the
 *  LAST session ends. `keepRecord` keeps the resumable persisted record (a
 *  cancelled RESUME, or a close-but-keep); terminal paths clear it. Returns the
 *  record-clear promise so terminal callers can await deletion (so a re-read of
 *  the Sessions list doesn't flash a stale row); most callers ignore it. */
function teardownSession(
  sess: ActiveSession,
  keepRecord = false,
  preserveSharedDoc = false,
): Promise<void> {
  unregisterCollabPluginSource(sess.ownerUid);
  sessions.delete(sess.ownerUid);
  // Release the cross-window live-session claim (registered in installSeams).
  releaseRoomClaim(sess.session.roomId);
  // A session went away — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  sess.wakeCleanup();
  sess.commentsSync.dispose();
  sess.cursors.dispose();
  let cleared: Promise<void> = Promise.resolve();
  if (keepRecord) sess.persist.dispose();
  else {
    if (!preserveSharedDoc) sess.clearSharedDoc();
    cleared = sess.persist.clear();
  }
  if (sessions.size === 0) {
    setCollabTransactionTagger(null);
    // Last session gone — drop the random-id dedup set so it doesn't grow.
    resetSessionCommentIds();
    if (presenceTimer !== null) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }
  return cleared;
}

/** Whether `ownerUid`'s session is the one the shared chip reflects. MUST
 *  match chipSession()'s selection exactly: the two used to disagree on the
 *  sole-session fallback (chipSession applied it whenever the focused doc had
 *  no session; this predicate only when focus was unresolvable), so the chip
 *  label froze — and ghosted after that session ended — while its dots kept
 *  rendering from chipSession (audit find, 2026-07-10). */
function isChipSession(ownerUid: string): boolean {
  return chipSession()?.ownerUid === ownerUid;
}

/** Repaint the shared chip from the CURRENT chip session's last status —
 *  called (via collab-hooks) when focus moves between docs; the chip
 *  otherwise held the previous doc's label until its next status event. */
export function refreshChipForFocus(): void {
  const sess = chipSession();
  if (sess) updateChip(sess.lastStatus ?? { connected: true, queuedUpdates: 0 });
  else updateSharedDocChip(chipSharedDocState());
}

// `getSess` resolves THIS session's ActiveSession lazily — for join/resume the
// entry isn't created (and its owning uid isn't known) until after newSessionDoc
// creates the fresh doc, which is after the CollabSession (and these callbacks)
// exist. Returns null before install / after teardown; callbacks then no-op.
function sessionCallbacks(deps: CollabUiDeps, getSess: () => ActiveSession | null) {
  return {
    onStatus: (s: { connected: boolean; queuedUpdates: number }) => {
      const sess = getSess();
      if (!sess) return;
      // Every session records its own status (each slot footer renders its
      // own); the shared chip still reflects only the focused doc's.
      sess.lastStatus = s;
      if (isChipSession(sess.ownerUid)) updateChip(s);
      queueCollabCopresenceChange();
      checkSoloSession(sess);
    },
    onPresence: (bytes: Uint8Array) => {
      const sess = getSess();
      if (!sess) return;
      const rosterChanged = sess.cursors.applyRemote(bytes);
      if (rosterChanged) {
        if (isChipSession(sess.ownerUid)) refreshPresenceDots();
        queueCollabCopresenceChange();
        checkSoloSession(sess);
      }
    },
    onAuthRejected: () => {
      // Mid-session 401/403 — without this the endless retry loop reads
      // exactly like being offline (audit find, 2026-07-10). Fired once
      // per session by CollabSession.
      showToast(
        'The session relay rejected your credentials — reconnect your Debate ' +
          'Decoded account or check your relay settings (Settings → Collaboration). ' +
          'Your edits are saved locally and keep retrying. (During the beta the ' +
          'official relay requires no account.)',
      );
    },
    onMissingRoomPersisting: () => {
      // A durable room has been 404/410 long enough to be gone for good —
      // re-host from the local file so the doc stops sitting on
      // "reconnecting" forever (field bug 2026-07-19).
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid) || !sess.session.durableRoom) return;
      void rehostGoneDurableRoom(deps, sess);
    },
    onBacklogMerged: (count: number) => {
      // Merge-visibility (M3): a travel-day backlog just landed — say
      // so, instead of the doc silently reshaping under the user.
      showToast(`Synced ${count} offline updates from the session — recent sections may have moved`);
    },
    onEnded: () => {
      // The explicit end/leave flows clean up themselves before the
      // session's onEnded fires; only a REMOTELY ended session (host
      // ended it, room GC'd) reaches past this guard.
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) return;
      const wasHost = sess.session.role === 'host';
      const wasChip = isChipSession(sess.ownerUid);
      void teardownSession(sess);
      if (wasChip) updateChip(null);
      // Rebuild the OWNER doc's plugin stack — refreshing the focused view
      // left an unfocused owner pane holding dead session plugins (audit
      // find, 2026-07-10).
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
      else deps.refreshPlugins();
      showToast(
        wasHost
          ? 'Collaboration session ended'
          : 'Session ended — this copy is now yours alone',
      );
    },
    onFullPersisting: () => {
      // Durable rooms retry a 409 silently, which reads as "stuck
      // reconnecting" forever. The usual cause is this app's own leaked
      // streams from earlier crashes/quits, and the room may never clear on
      // its own — so offer the escape rather than just narrating.
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid) || !sess.session.durableRoom) {
        showToast(
          'Still connecting — the relay is clearing older connections for this document.',
        );
        return;
      }
      void offerRehostForFullRoom(deps, sess);
    },
    onFull: () => {
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) {
        showToast('That session is full (10 participants)');
        return;
      }
      // The join/resume half-succeeded over REST before the stream's 409:
      // leaving the session mounted showed "Joined the session" + a dead
      // offline chip forever (audit find, 2026-07-10). Tear down but KEEP
      // the record so the user can rejoin from the Sessions list when
      // someone leaves.
      const wasChip = isChipSession(sess.ownerUid);
      void teardownSession(sess, /* keepRecord */ true);
      if (wasChip) updateChip(null);
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
      else deps.refreshPlugins();
      showToast(
        'The session is full (10 people) — your copy is saved; rejoin from the ' +
          'Sessions list when someone leaves.',
      );
    },
  };
}

/** Turn a relay failure into a user-actionable message. A 401 is the
 *  gating/auth signal — for INITIATING a session (send-gated per §5.4:
 *  paid initiates, free joins) that means a subscription is required;
 *  for join/resume it means the relay rejected the credentials. The
 *  401 is inherently ambiguous between "hosted relay, needs a paid
 *  account" and "self-host, wrong token", so the message names both
 *  without asserting which. Any non-401 keeps its raw reason. */
export function relayFailureMessage(err: unknown, opts: { initiating: boolean; verb: string }): string {
  if (err instanceof RoomsError && err.status === 401) {
    return opts.initiating
      ? 'The relay rejected your token. Check Settings -> Collaboration: the relay URL and token must match on both computers.'
      : 'The session relay rejected your token. Check Settings -> Collaboration: the relay URL and token must match on both computers.';
  }
  // 410 = the room was ended (host); 404 = the room itself is gone (relay
  // idle GC). Not errors the user can retry into — tell them the session is
  // over rather than leaking the raw "rooms request failed: NNN".
  if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
    return 'That co-editing session has ended — ask for a fresh invite to start a new one.';
  }
  if (err instanceof RoomsError && err.status === 405) {
    return 'Co-editing failed. Install the latest build on both computers, then try again.';
  }
  return `Could not ${opts.verb}: ${(err as Error).message}`;
}

type HostedSession =
  Awaited<ReturnType<typeof CollabSession.host>> & { sharedDoc?: SharedDocMetadata };

async function hostSessionWithPersistentFallback(
  opts: Parameters<typeof CollabSession.hostPersistent>[0],
): Promise<HostedSession> {
  try {
    return await CollabSession.hostPersistent(opts);
  } catch (err) {
    if (err instanceof RoomsError && err.status === 405) {
      return CollabSession.host(opts);
    }
    throw err;
  }
}

/** Start-session gate: a session is started FOR a focused document, so a
 *  live view is required (join/resume create their own doc and do not use
 *  this). The message holds in both modes — single-pane always has a doc;
 *  multi-pane hits this only with every slot empty/unfocused. */
function guardReady(deps: CollabUiDeps): EditorView | null {
  if (!collabEnabled()) return null;
  const view = deps.getView();
  if (!view) {
    showToast('Open and focus a document to start a co-editing session');
    return null;
  }
  return view;
}

/** Docs with a Start flow mid-confirm/mid-relay: a double-click (or a second
 *  Start command racing the first's awaits) minted TWO rooms for one doc
 *  (audit find, 2026-07-10). */
const startsInFlight = new Set<string>();

export async function startSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  const view = guardReady(deps);
  if (!view) return;
  const ownerUid = deps.getOwnerUid?.() ?? '';
  if (sessionFor(ownerUid)) {
    showToast('This document already has a session — end or leave it first');
    return;
  }
  if (startsInFlight.has(ownerUid)) return;
  startsInFlight.add(ownerUid);
  try {
    await startSessionFlowInner(deps, view, ownerUid, { manual: true });
  } finally {
    startsInFlight.delete(ownerUid);
  }
}

/** Saved `.cmir` files should behave like shared working documents: once a
 *  relay is configured, the first opener silently creates the persistent room
 *  and writes that pointer into the file; later openers auto-connect through
 *  `connectSharedDocFlow` without a share code. */
export async function autoStartSharedDocFlow(deps: CollabUiDeps): Promise<boolean> {
  if (!collabEnabled()) return false;
  const view = deps.getView();
  if (!view) return false;
  const ownerUid = deps.getOwnerUid?.() ?? '';
  if (!ownerUid) return false;
  if (sessionFor(ownerUid)) return true;
  if (startsInFlight.has(ownerUid)) return false;
  startsInFlight.add(ownerUid);
  try {
    return await startSessionFlowInner(deps, view, ownerUid, { manual: false });
  } finally {
    startsInFlight.delete(ownerUid);
  }
}

async function startSessionFlowInner(
  deps: CollabUiDeps,
  view: EditorView,
  ownerUid: string,
  opts: { manual: boolean },
): Promise<boolean> {
  // Confirm, naming the doc the session will be created for — removes any
  // ambiguity about which doc is being shared (multi-pane: the focused one).
  const startName = sessionDocTitle(ownerUid);
  // A plain yes/no — two equal buttons (confirmDialog), NOT the big
  // route-choice cards, which are reserved for genuine multi-option
  // decisions (field feedback, 2026-07-11).
  if (opts.manual) {
    const startConfirm = await confirmDialog(
      'Anyone you share the code with can edit this document with you in real time.',
      {
        title: `Start a co-editing session for ${startName ? `"${startName}"` : 'this document'}?`,
        okLabel: 'Start Session',
      },
    );
    if (!startConfirm) return false;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    if (opts.manual) showToast('Set the relay URL and token in Settings -> Collaboration first');
    return false;
  }
  try {
    // Host on the CURRENT (focused) doc — no doc swap, so its uid is the owner.
    let sessRef: ActiveSession | null = null;
    const { session, shareCode, sharedDoc } = await hostSessionWithPersistentFallback({
      pmDoc: view.state.doc,
      client,
      callbacks: sessionCallbacks(deps, () => sessRef),
    });
    if (sharedDoc) {
      deps.setSharedDocForUid?.(ownerUid, sharedDoc);
      deps.markDirtyForUid?.(ownerUid);
      await deps.persistSharedDocForUid?.(ownerUid, sharedDoc);
    }
    if (!opts.manual && !sharedDoc) {
      await session.stop();
      return false;
    }
    // ownerUid captured at flow start (line ~427), under the doc that was
    // focused when Start was chosen — host() shared THAT doc's content, so the
    // seams must bind to it even if focus has since moved.
    const sess = installSeams(session, deps, shareCode, ownerUid);
    sessRef = sess;
    // Seed before start(): the first flush then carries the host's
    // existing comment threads alongside the seeded doc — and the doc
    // title, so joiners can name their unsaved copy.
    sess.commentsSync.seedFromView(view);
    session.loroDoc.getMap('meta').set('title', sessionDocTitle(ownerUid));
    session.loroDoc.commit({ origin: META_COMMIT_ORIGIN });
    deps.refreshPlugins();
    session.start();
    sess.lastStatus = { connected: true, queuedUpdates: 0 };
    updateChip({ connected: true, queuedUpdates: 0 });
    const copied = opts.manual
      ? await navigator.clipboard?.writeText(shareCode).then(
          () => true,
          () => false,
        )
      : false;
    if (opts.manual) {
      showToast(
        copied
          ? sharedDoc
            ? 'Co-editing started — shared .cmir files will auto-connect'
            : 'Session started — share code copied, send it to your partner'
          : sharedDoc
            ? 'Co-editing started — shared .cmir files will auto-connect'
            : 'Session started — use "Copy Session Share Code" to invite',
      );
    }
    return true;
  } catch (err) {
    if (opts.manual) {
      showToast(relayFailureMessage(err, { initiating: true, verb: 'start the session' }));
    } else {
      console.warn('[collab] auto-start failed:', err);
    }
    return false;
  }
}

export async function joinSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return;
  const code = await promptForText({
    message: 'Paste the share code from your partner',
    placeholder: 'cmshare1.…',
    okLabel: 'Join',
  });
  if (!code) return;
  await joinSessionWithCode(deps, code);
}

/** Join with a code in hand — the prompt flow above and the Receive
 *  pill's invite Join both land here. Returns true when the join actually
 *  landed (or was handed to a spawned window) — the Receive pill consumes
 *  the invite only then, so a cancelled slot pick or an unreachable relay
 *  doesn't burn the share code. No view is required up front: the flow
 *  creates its own doc via deps.newSessionDoc (multi-pane may be an empty
 *  workspace at this point). */
export async function joinSessionWithCode(deps: CollabUiDeps, code: string): Promise<boolean> {
  if (!collabEnabled()) return false;
  // Don't overwrite the doc you're working in — or bump the session you're
  // already in: unless this window holds the disposable starter, hand the
  // join to a fresh window (which re-enters here with the starter open, so it
  // joins in place). Runs BEFORE the `active` guard and the session creation,
  // so an active-session window opens the new join elsewhere instead of
  // refusing, and the session + binding are born in the window that keeps them.
  // (Single-pane desktop only; the multi-pane deps have no spawnJoinWindow.)
  // Counts as consumed: the join continues in the spawned window.
  if (deps.spawnJoinWindow?.(code.trim())) return true;
  // Don't overwrite a doc that's ITSELF in a session (spawnJoinWindow already
  // redirected windows holding a real doc; this guards the edge case).
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it before joining here');
    return false;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Collaboration first');
    return false;
  }
  const decoded = decodeShareCode(code);
  if (!decoded) {
    showToast('That does not look like a share code');
    return false;
  }
  // A resumable record for this room means WE'VE been in it before — resume
  // instead of fresh-joining, so the record's unsynced local edits flush to
  // the room. A fresh join minted a second copy from the relay state, and a
  // later Leave deleted the old record, making those edits unrecoverable
  // (audit find, 2026-07-10).
  if (await loadSessionRecord(decoded.roomId)) {
    return resumeSessionFlow(deps, decoded.roomId);
  }
  // Resolved after newSessionDoc/installSeams; callbacks read it lazily.
  let sessRef: ActiveSession | null = null;
  try {
    let session: CollabSession;
    let joinedOffline = false;
    try {
      session = await CollabSession.join({
        ...decoded,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
    } catch (err) {
      // An ENDED (410) or expired/GC'd (404) room is not an offline
      // condition — the seed would resume a session that no longer exists.
      // Surface it as ended.
      if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) throw err;
      // Offline (or relay unreachable): fall back to the invite's
      // prefetched seed (§4.1). Everything in it came FROM the room,
      // so resume() with no sentVersion is exact; start() syncs at the
      // next connectivity window.
      const pre = await loadPrefetch(decoded.roomId);
      if (!pre) throw err;
      const key = await importRoomKey(decoded.keyBytes);
      const blobs = await Promise.all(pre.blobs.map((b) => decryptBlob(key, b)));
      session = await CollabSession.resume({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: 'participant',
        snapshot: blobs[0]!,
        increments: blobs.slice(1),
        lastSeq: pre.lastSeq,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
      joinedOffline = true;
    }
    // Create the fresh unsaved session doc — its uid is the session owner
    // (single-pane swaps this window's doc; multi-pane slot-picks). A false
    // return = the user balked (overwrite prompt / slot picker) — unwind
    // without touching the room AND keep the prefetched seed: the invite
    // stays retryable.
    if (!(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Join cancelled');
      return false;
    }
    // The session owner is the doc newSessionDoc() just created — capture its
    // uid NOW, before any later focus change, so the seams bind into it.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, code.trim(), ownerUid);
    // Add the binding to the fresh doc's view — its init replaces the empty
    // content with the session's CRDT state.
    deps.refreshPlugins();
    // The join snapshot already carries the host's thread map — land it
    // in the fresh pane's plugin state; same for the published title.
    sessRef.commentsSync.pull();
    adoptSharedTitle(deps, session);
    session.start();
    sessRef.lastStatus = { connected: !joinedOffline, queuedUpdates: 0 };
    updateChip({ connected: !joinedOffline, queuedUpdates: 0 });
    // Only NOW is the seed spent — the join is committed (for the offline
    // path the seed's content lives on in the session + its persist record).
    void deletePrefetch(decoded.roomId);
    showToast(
      joinedOffline
        ? 'Joined from the prefetched copy — will sync when you reconnect'
        : 'Joined the session',
    );
    deps.getView()?.focus();
    return true;
  } catch (err) {
    if (sessRef) void teardownSession(sessRef);
    // A dead room's invite and seed are useless — purge the seed and report
    // consumed so the Receive pill clears the row. Every other failure keeps
    // both, so the user can retry once the network/slot situation changes.
    const ended = err instanceof RoomsError && (err.status === 410 || err.status === 404);
    if (ended) void deletePrefetch(decoded.roomId);
    showToast(relayFailureMessage(err, { initiating: false, verb: 'join' }));
    return ended;
  }
}

/** Connect an already-open `.cmir` that carries persistent shared-doc
 *  metadata. Unlike invite joins, this binds into the current document
 *  instead of creating a new session document: the opened file is the
 *  durable handle, and the room state becomes authoritative once online. */
export async function connectSharedDocFlow(
  deps: CollabUiDeps,
  sharedDoc: SharedDocMetadata,
): Promise<boolean> {
  if (!collabEnabled()) return false;
  const decoded = decodeShareCode(sharedDoc.shareCode);
  if (!decoded || decoded.roomId !== sharedDoc.roomId) {
    showToast('This shared document has unreadable collaboration metadata');
    return false;
  }

  const ownerUid = deps.getOwnerUid?.() ?? '';
  const ownerDeps = depsForOwner(deps, ownerUid);
  if (!ownerDeps.getView()) return false;
  setSharedDocOpenState(ownerUid, { sharedDoc, status: 'connecting' });
  const current = sessionFor(ownerUid);
  if (current) {
    if (current.session.roomId === decoded.roomId) {
      setSharedDocOpenState(ownerUid, null);
      return true;
    }
    return keepSharedDocConnecting(
      ownerDeps,
      sharedDoc,
      ownerUid,
      'This document is already in another live collaboration session.',
      'This document is already in another session',
    );
  }
  for (const s of sessions.values()) {
    if (s.session.roomId === decoded.roomId) {
      return keepSharedDocConnecting(
        ownerDeps,
        sharedDoc,
        ownerUid,
        'This shared document is already active elsewhere in this window.',
        'That shared document is already active in this window',
      );
    }
  }
  // Stale duplicate-open room claims are common after sleep/crash. A saved
  // shared .cmir should still join its durable relay room; the relay stream is
  // the source of truth, and the room client handles real capacity/backoff.

  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings â†’ Collaboration first');
    return false;
  }

  // A durable pointer can outlive its room (relay redeploy, wiped storage, an
  // archived doc). Joining a truly-gone room can never succeed — without this
  // probe the retry loop toasts "session has ended" forever, and the stale
  // pointer blocks ever starting a fresh session for this file. When the relay
  // is REACHABLE and says the room is gone, drop the pointer + stale record
  // and silently re-host a fresh persistent room seeded from the local file;
  // the new pointer autosaves into the .cmir so other openers pick it up.
  if (await durableRoomGone(client, sharedDoc)) {
    clearSharedDocReconnect(ownerUid);
    setSharedDocOpenState(ownerUid, null);
    await deleteSessionRecord(decoded.roomId).catch(() => {});
    ownerDeps.setSharedDocForUid?.(ownerUid, null);
    showToast('The previous co-editing room was gone — created a fresh one for this document');
    return autoStartSharedDocFlow(ownerDeps);
  }

  const record = await loadSessionRecord(decoded.roomId);
  if (record) {
    const ok = await resumeSessionFlow(ownerDeps, decoded.roomId, {
      existingDoc: true,
      durableRoom: true,
    });
    if (ok) {
      setSharedDocOpenState(ownerUid, null);
      ownerDeps.setSharedDocForUid?.(ownerUid, sharedDoc);
    } else {
      keepSharedDocConnecting(
        ownerDeps,
        sharedDoc,
        ownerUid,
        'Saved session data is available, but reconnect did not complete.',
      );
    }
    return ok;
  }

  let sessRef: ActiveSession | null = null;
  try {
    const session = await CollabSession.join({
      ...decoded,
      client,
      durableRoom: true,
      callbacks: sessionCallbacks(ownerDeps, () => sessRef),
    });
    sessRef = installSeams(session, ownerDeps, sharedDoc.shareCode, ownerUid);
    ownerDeps.setSharedDocForUid?.(ownerUid, sharedDoc);
    ownerDeps.refreshPlugins();
    sessRef.commentsSync.pull();
    session.start();
    sessRef.lastStatus = { connected: true, queuedUpdates: 0 };
    updateChip({ connected: true, queuedUpdates: 0 });
    showToast('Shared document connected');
    ownerDeps.getView()?.focus();
    return true;
  } catch (err) {
    if (sessRef) void teardownSession(sessRef, /* keepRecord */ true);
    const msg = relayFailureMessage(err, { initiating: false, verb: 'connect shared document' });
    return keepSharedDocConnecting(
      ownerDeps,
      sharedDoc,
      ownerUid,
      msg,
      `${msg}. Co-editing will keep retrying.`,
    );
  }
}

/** Resume a persisted session (home-screen Sessions list, M3). The
 *  persisted CRDT carries this peer's full history — including edits
 *  that never reached the relay before the app died — so start()'s
 *  first flush sends exactly the unsent diff and catch-up resumes from
 *  the stored cursor. A tombstoned room degrades through the normal
 *  onEnded path ("this copy is now yours alone") and clears the record.
 *  Returns true when the session is live in this window afterwards (also
 *  when it already was) — joinSessionWithCode delegates here for rooms
 *  with a resumable record, and the Receive pill consumes the invite on
 *  true. */
export async function resumeSessionFlow(
  deps: CollabUiDeps,
  roomId: string,
  opts?: { existingDoc?: boolean; durableRoom?: boolean },
): Promise<boolean> {
  if (!collabEnabled()) return false; // desktop-only; inert on the web edition
  // No up-front view requirement: unless resuming into an existing doc, the
  // flow creates its own via deps.newSessionDoc (multi-pane may be an empty
  // workspace reached from the home screen's Sessions list).
  if (opts?.existingDoc && !deps.getView()) return false;
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it first');
    return false;
  }
  for (const s of sessions.values()) {
    if (s.session.roomId === roomId) {
      showToast('That session is already active in this window');
      // Already live here — an invite for it is redundant, so report success.
      return true;
    }
  }
  // Cross-WINDOW guard: another window holding this room live claims its
  // synthetic key in the duplicate-open registry; probing it also focuses
  // that window (so the user lands on the live session, not an error).
  if (!opts?.durableRoom && await roomLiveElsewhere(roomId)) {
    showToast('That session is already open in another CardMirror window.');
    return true; // live elsewhere — an invite/row for it is redundant here
  }
  const record = await loadSessionRecord(roomId);
  if (!record) {
    showToast('No saved session to resume');
    return false;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Collaboration first');
    return false;
  }
  const decoded = decodeShareCode(record.shareCode);
  if (!decoded) {
    showToast('Saved session record is unreadable');
    return false;
  }
  let sessRef: ActiveSession | null = null;
  try {
    const session = await CollabSession.resume({
      roomId: record.roomId,
      keyBytes: decoded.keyBytes,
      role: record.role,
      snapshot: record.snapshot,
      increments: record.increments,
      lastSeq: record.lastSeq,
      sentVersion: record.sentVersion,
      durableRoom: opts?.durableRoom ?? record.durableRoom === true,
      client,
      callbacks: sessionCallbacks(deps, () => sessRef),
    });
    // Fresh doc first — its uid owns the session. A false return keeps the
    // record (still resumable) — no seams installed yet, so nothing to unwind.
    // EXCEPT `existingDoc`: bind into an ALREADY-open doc under its uid instead
    // of creating one (the binding replaces its content with the CRDT's —
    // same doc). A capability for resuming in place; no caller today.
    if (!opts?.existingDoc && !(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Resume cancelled');
      return false;
    }
    // Owner = the doc that will hold the session: for existingDoc it is the
    // already-open doc under its uid; otherwise the fresh doc newSessionDoc()
    // just made (single-pane swap, or multi-pane slot). Capture past the awaits.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, record.shareCode, ownerUid);
    deps.refreshPlugins();
    sessRef.commentsSync.pull();
    adoptSharedTitle(deps, session);
    session.start();
    sessRef.lastStatus = { connected: false, queuedUpdates: session.queuedUpdates };
    updateChip({ connected: false, queuedUpdates: session.queuedUpdates });
    showToast('Session resumed — syncing');
    deps.getView()?.focus();
    return true;
  } catch (err) {
    // KEEP the record on a failed resume: it existed before this attempt and
    // may hold unsynced edits — the default teardown would delete it (audit
    // find, 2026-07-10). Still resumable from the Sessions list.
    if (sessRef) void teardownSession(sessRef, /* keepRecord */ true);
    showToast(relayFailureMessage(err, { initiating: false, verb: 'resume' }));
    return false;
  }
}

export async function copyShareCodeFlow(): Promise<void> {
  const sess = actionSession();
  const shareCode = sess?.shareCode ?? actionSharedDocState()?.sharedDoc.shareCode ?? '';
  if (!shareCode) {
    showToast('This document has no active session');
    return;
  }
  const ok = await navigator.clipboard?.writeText(shareCode).then(
    () => true,
    () => false,
  );
  showToast(
    ok
      ? sess
        ? 'Share code copied'
        : 'Shared document share code copied'
      : 'Could not copy the share code',
  );
}

/** The host-published doc title from the room's meta map ('' when the
 *  host predates title publishing or hasn't named the doc). */
function sharedDocTitle(session: CollabSession): string {
  const t = session.loroDoc.getMap('meta').get('title');
  return typeof t === 'string' ? t.trim() : '';
}

/** Adopt the shared title in this window (joiner/resume paths). */
function adoptSharedTitle(deps: CollabUiDeps, session: CollabSession): void {
  const title = sharedDocTitle(session);
  if (title) deps.setDocTitle?.(title);
}

/** The name to publish/label a session with: the OWNER doc's own filename (via
 *  the host-set resolver), NOT `document.title` — in multi-pane that's every
 *  open doc joined by " · ", so a joiner would inherit a window title naming all
 *  of the host's open docs. Falls back to parsing the single-doc window title
 *  when no resolver is set (tests / pre-wire) or the uid can't be resolved. */
function sessionDocTitle(ownerUid: string | null | undefined): string {
  const byUid = ownerUid ? docTitleResolver?.(ownerUid) : null;
  if (byUid != null) return byUid.trim();
  const t = document.title;
  const cut = t.lastIndexOf(' — CardMirror');
  if (cut > 0) return t.slice(0, cut);
  return t === 'CardMirror' ? '' : t;
}

/** Shared invite-send tail: sealed pairing message, version-floored so
 *  pre-invite clients get the update-required toast instead of a dead
 *  card row. Assumes an active session. */
async function sendInviteTo(
  target: { codes: string[]; label: string; via?: string },
  shareCode: string,
  ownerUid: string | null | undefined,
): Promise<void> {
  const item = buildRoomInviteItem({
    shareCode,
    title: sessionDocTitle(ownerUid),
  });
  const res = await pairingRelayClient.send(target.codes, item, {
    via: target.via,
    minReceiverVersion: ROOM_INVITE_MIN_VERSION,
  });
  if (res.fail === 0) showToast(`Invited ${target.label} ✓`);
  else if (res.ok === 0) showToast(`Couldn't reach ${target.label}`);
  else showToast(`Invited ${target.label} (${res.fail} failed)`);
}

/** Send a session invite to the starred partner/group. */
export async function inviteStarredFlow(): Promise<void> {
  if (!collabEnabled()) return;
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session — start one first');
    return;
  }
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  const target = resolveStarredTarget(
    settings.get('pairingStarred'),
    settings.get('pairingPartners'),
    settings.get('pairingGroups'),
  );
  if (!target) {
    showToast('Star a partner or group in the Send pill first');
    return;
  }
  if (target.codes.length === 0) {
    showToast('The starred group has no recipients yet');
    return;
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** The Send pill's click-to-invite (§6 picker-first flow): with no
 *  active session, START one on the current doc, then invite the
 *  picked partner/group; with one active, just invite. */
export async function inviteTargetFlow(
  deps: CollabUiDeps,
  target: { codes: string[]; label: string; via?: string },
): Promise<void> {
  if (!collabEnabled()) return;
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  if (target.codes.length === 0) {
    showToast('That group has no recipients yet');
    return;
  }
  let sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    await startSessionFlow(deps);
    sess = sessionFor(deps.getOwnerUid?.());
    if (!sess) return; // start failed/cancelled — its toast explains
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** Terminate/leave a session and clear its resumable record — the shared core
 *  of the explicit End command and the close dialog's End/Leave choice (no
 *  prompt; the caller already confirmed). Host ends for everyone (tombstones the
 *  room); a participant just disconnects. */
/** End (host) or leave (guest) a session. Returns false when a host End
 *  couldn't tombstone the room (offline / filtered network) — the session is
 *  left LIVE and nothing is torn down, so the caller must abort whatever
 *  close it was driving. Reporting success without the tombstone let invited
 *  peers keep editing a room the host believed was over, with the local
 *  record (the host's only handle for ending it) already deleted (audit +
 *  field find, 2026-07-10). A guest Leave has no server side and always
 *  succeeds. */
async function endOrLeaveSession(sess: ActiveSession): Promise<boolean> {
  const isHost = sess.session.role === 'host';
  const wasChip = isChipSession(sess.ownerUid);
  // Disconnect first (final drain attempt), THEN tombstone for a host end —
  // and only tear down once the room is actually gone. endRoomOnRelay treats
  // an already-ended/expired room (410/404) as success.
  await sess.session.stop();
  if (isHost) {
    try {
      await endRoomOnRelay(sess.session.roomId);
    } catch (err) {
      // Reconnect and keep the session (and its record) intact — the user
      // retries once the relay is reachable.
      sess.session.start();
      showToast(
        `Couldn't end the session — check your connection and try again. (${err instanceof Error ? err.message : err})`,
      );
      return false;
    }
  }
  // Registry drop before the record delete, so a late stream frame's
  // onEnded no-ops.
  const cleared = teardownSession(sess);
  if (wasChip) updateChip(null);
  await cleared; // record actually gone before we return
  await discardRecoveryJournal(sess);
  return true;
}

/** Close a co-edited doc but KEEP its session resumable: disconnect (a final
 *  drain attempt), persist the CRDT — including edits that never reached the
 *  relay — then drop the live binding while leaving the stored record behind.
 *  The home-screen Sessions list resumes it; unsynced edits flush on rejoin.
 *  Called from the always-loaded close paths via collab-hooks. */
async function closeKeepResumableSession(uid: string): Promise<boolean> {
  const sess = sessionFor(uid);
  if (!sess) return true;
  const wasChip = isChipSession(sess.ownerUid);
  await sess.session.stop(); // disconnect only — the room + record survive
  if (sess.session.durableRoom) {
    if (!(await sess.persist.verifiedFlush())) {
      sess.session.start(); // reconnect; the session stays live, caller aborts
      return false;
    }
    const cleared = teardownSession(sess, /* keepRecord */ true, /* preserveSharedDoc */ true);
    if (wasChip) updateChip(null);
    await cleared;
    await discardRecoveryJournal(sess);
    return true;
  }
  // Capture the final state (incl. any still-unsynced edits) AFTER the drain so
  // sentVersion is accurate — VERIFIED: the close path drops the recovery
  // journal, so this record is about to be the doc's only copy. A silent
  // storage failure must abort the close, not lose the doc (audit find,
  // 2026-07-10).
  if (!(await sess.persist.verifiedFlush())) {
    sess.session.start(); // reconnect; the session stays live, caller aborts
    return false;
  }
  void teardownSession(sess, /* keepRecord */ true);
  if (wasChip) updateChip(null);
  return true;
}

/** Close a co-edited doc by ending/leaving its session (clears the record).
 *  False = a host End failed to tombstone; nothing was torn down. */
async function closeEndOrLeaveSession(uid: string): Promise<boolean> {
  const sess = sessionFor(uid);
  if (!sess) return true;
  return endOrLeaveSession(sess);
}

export async function endSessionFlow(deps: CollabUiDeps): Promise<void> {
  // Ends the FOCUSED doc's session (the one the user is looking at).
  const sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    showToast('No active session');
    return;
  }
  const isHost = sess.session.role === 'host';
  // In-app overlay, NOT window.confirm: Electron's native confirm on
  // Windows/Linux never hands keyboard focus back to the renderer —
  // the editor was untypeable until a reload (field bug, 2026-07-03).
  const choice = await confirmDialog(
    isHost ? 'Everyone keeps the copy currently on their screen.' : 'Your copy stays open here.',
    {
      title: isHost ? 'End live session?' : 'Leave live session?',
      okLabel: isHost ? 'End Session' : 'Leave Session',
      danger: isHost,
    },
  );
  if (!choice) return;
  // A failed host End (relay unreachable) already toasted and left the
  // session live — don't repaint plugins or claim success.
  if (!(await endOrLeaveSession(sess))) return;
  if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
  else deps.refreshPlugins();
  showToast(isHost ? 'Session ended' : 'Left the session');
  deps.getView()?.focus();
}

/** Test seam: the session the user is looking at (focused doc's, or the sole
 *  session), or null. */
export function activeSession(): CollabSession | null {
  return chipSession()?.session ?? null;
}
