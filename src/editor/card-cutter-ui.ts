/**
 * Card-cutter launch sheet — the configuration flow.
 *
 * Asks only what the user knows up front: how long the read should be
 * (read-time) and what they're using the card for (intent). Then,
 * when enabled, runs the describe-then-generate clarifying step: the
 * engine proposes ≤3 candidate cuts (descriptions, not generations)
 * and the user picks one before anything is cut.
 *
 * Reuses the app's `pmd-route-overlay` / `pmd-route-dialog` chrome.
 */

import type { EditorView } from 'prosemirror-view';
import { settings } from './settings.js';
import { showToast } from './toast.js';
import {
  cutFocusedCard,
  focusedCardStatus,
  proposeFocusedOmissions,
  setSectionOmitted,
  previewOmissionSection,
  refineHighlightFocusedCard,
  addHighlightFocusedCard,
  hasCardSubSelection,
  ensureEngine,
  type CutSession,
  type OmissionSection,
} from './card-cutter-port.js';

type Intent = 'build' | 'support' | 'answer';
const INTENT_ROLE: Record<Intent, 'block' | 'ext' | 'at'> = {
  build: 'block',
  support: 'ext',
  answer: 'at',
};

const READ_TIME_PRESETS = [8, 12, 20, 30];

export async function openCutLaunchSheet(view: EditorView): Promise<void> {
  if (!(await ensureEngine())) {
    showToast('Card-cutter engine not loaded.');
    return;
  }
  const status = focusedCardStatus(view);
  if (!status.cuttable) {
    showToast('Put the cursor in a card with body text first.');
    return;
  }
  if (status.hasHighlight) {
    // Already cut. A sub-selection means "add highlight here"; otherwise
    // offer the shorten / tighten / add sheet.
    if (hasCardSubSelection(view)) {
      void addHighlightFocusedCard(view);
    } else {
      openHighlightDownSheet(view);
    }
    return;
  }
  const highlightOnly = status.hasUnderline; // underlined → highlight only

  const overlay = document.createElement('div');
  overlay.className = 'pmd-route-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-route-dialog pmd-cardcutter-dialog';

  const header = document.createElement('div');
  header.className = 'pmd-route-header';
  header.textContent = highlightOnly ? 'Highlight card' : 'Cut card';
  dialog.appendChild(header);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (!dialog.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── Read length (optional cap; efficient by default) ──
  // null = no cap (cut as efficiently as possible). A time chip caps
  // the read via the secondary de-highlight; it never pads up to it.
  let readTimeSec: number | null = null;
  const rtSection = document.createElement('div');
  rtSection.className = 'pmd-cardcutter-section';
  rtSection.appendChild(label('Read length'));
  const rtRow = document.createElement('div');
  rtRow.className = 'pmd-cardcutter-chips';
  const wpm = firstReaderWpm();
  const press = (active: HTMLButtonElement): void =>
    rtRow.querySelectorAll('.pmd-cardcutter-chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(c === active)),
    );
  const noCap = document.createElement('button');
  noCap.type = 'button';
  noCap.className = 'pmd-cardcutter-chip';
  noCap.textContent = 'Efficient (no limit)';
  noCap.setAttribute('aria-pressed', 'true');
  noCap.addEventListener('click', () => {
    readTimeSec = null;
    press(noCap);
  });
  rtRow.appendChild(noCap);
  const chipFor = (sec: number): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-cardcutter-chip';
    b.textContent = `≤ ${sec}s · ~${Math.round((sec * wpm) / 60)}w`;
    b.addEventListener('click', () => {
      readTimeSec = sec;
      press(b);
    });
    return b;
  };
  for (const sec of READ_TIME_PRESETS) rtRow.appendChild(chipFor(sec));
  rtSection.appendChild(rtRow);
  dialog.appendChild(rtSection);

  // ── Intent ──
  let intent: Intent = 'build';
  const intentSection = document.createElement('div');
  intentSection.className = 'pmd-cardcutter-section';
  intentSection.appendChild(label('Using this card to…'));
  const intents: [Intent, string][] = [
    ['build', 'Build a point — full read'],
    ['support', 'Add support — supplement a point already made'],
    ['answer', 'Answer — isolate the responsive line'],
  ];
  const grp = `pmd-cc-intent-${Math.random().toString(36).slice(2, 7)}`;
  for (const [val, text] of intents) {
    const lbl = document.createElement('label');
    lbl.className = 'pmd-cardcutter-radio';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = grp;
    input.checked = val === intent;
    input.addEventListener('change', () => {
      if (input.checked) intent = val;
    });
    lbl.appendChild(input);
    const span = document.createElement('span');
    span.textContent = text;
    lbl.appendChild(span);
    intentSection.appendChild(lbl);
  }
  dialog.appendChild(intentSection);

  // ── Ask-me ──
  const askDefault = settings.get('cardCutterClarifyingQuestions') !== 'never';
  let askMe = askDefault;
  const askRow = document.createElement('label');
  askRow.className = 'pmd-cardcutter-check';
  const askInput = document.createElement('input');
  askInput.type = 'checkbox';
  askInput.checked = askMe;
  askInput.disabled = settings.get('cardCutterClarifyingQuestions') === 'never';
  askInput.addEventListener('change', () => (askMe = askInput.checked));
  askRow.appendChild(askInput);
  const askSpan = document.createElement('span');
  askSpan.textContent = 'Ask me if this card cuts multiple ways';
  askRow.appendChild(askSpan);
  if (!highlightOnly) dialog.appendChild(askRow);

  // ── Buttons ──
  const buttons = document.createElement('div');
  buttons.className = 'pmd-text-prompt-buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pmd-route-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  buttons.appendChild(cancel);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'pmd-text-prompt-ok';
  go.textContent = highlightOnly ? 'Highlight' : 'Cut';
  go.dataset['label'] = go.textContent;
  go.addEventListener('click', () => {
    void onGo();
  });
  buttons.appendChild(go);
  dialog.appendChild(buttons);

  overlay.appendChild(dialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  dialog.tabIndex = -1;
  dialog.focus();

  async function onGo(): Promise<void> {
    // Apply-then-refine: cut now (efficiently, capped if a length was
    // chosen), then — when asked, or when a cap couldn't be met — open
    // the section checklist over the real cut with exact counts.
    close();
    const session = await cutFocusedCard(view, {
      role: INTENT_ROLE[intent],
      ...(readTimeSec ? { readTimeSec } : {}),
    });
    if (!session) return;
    // Cap met cleanly → done. Cap missed → offer manual trim. No cap →
    // offer the checklist when ask-me is on.
    const wantChecklist = readTimeSec ? !!session.shortfall : askMe;
    if (!wantChecklist) return;
    showToast('Finding optional sections…');
    const sections = await proposeFocusedOmissions(session);
    if (sections.length === 0) {
      if (session.shortfall)
        showToast(`Couldn't reach ≤${readTimeSec}s without dropping a warrant.`);
      return;
    }
    openTrimChecklist(view, session, sections, readTimeSec);
  }
}

/** Apply-then-refine checklist: a floating panel listing the optional
 *  sections of a just-applied cut. Each row's count is engine-exact;
 *  unchecking removes that section's highlights live on the card. */
function openTrimChecklist(
  view: EditorView,
  session: CutSession,
  sections: OmissionSection[],
  capSec?: number | null,
): void {
  const wpm = firstReaderWpm();
  const secsFor = (words: number): number => Math.max(1, Math.round((words / wpm) * 60));

  const panel = document.createElement('div');
  panel.className = 'pmd-cardcutter-trim';

  const head = document.createElement('div');
  head.className = 'pmd-cardcutter-trim-head';
  const title = document.createElement('div');
  title.className = 'pmd-cardcutter-trim-title';
  title.textContent = capSec ? `Couldn't hit ≤${capSec}s — trim more?` : 'Trim the read (optional)';
  head.appendChild(title);
  const total = document.createElement('div');
  total.className = 'pmd-cardcutter-trim-total';
  head.appendChild(total);
  panel.appendChild(head);

  let readWords = session.readWords;
  const renderTotal = (): void => {
    total.textContent = `Read now: ${readWords}w · ~${secsFor(readWords)}s`;
  };
  renderTotal();

  const list = document.createElement('div');
  list.className = 'pmd-cardcutter-trim-list';
  for (const sec of sections) {
    const row = document.createElement('label');
    row.className = 'pmd-cardcutter-trim-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true; // checked = kept
    cb.addEventListener('change', () => {
      const omit = !cb.checked;
      setSectionOmitted(view, session, sec, omit);
      readWords += omit ? -sec.words : sec.words;
      row.classList.toggle('pmd-cardcutter-trim-omitted', omit);
      renderTotal();
    });
    row.appendChild(cb);
    const box = document.createElement('span');
    box.className = 'pmd-cardcutter-trim-text';
    const lab = document.createElement('strong');
    lab.textContent = sec.label;
    const det = document.createElement('span');
    det.className = 'pmd-cardcutter-trim-detail';
    det.textContent = sec.description;
    box.appendChild(lab);
    box.appendChild(det);
    row.appendChild(box);
    const save = document.createElement('span');
    save.className = 'pmd-cardcutter-trim-save';
    save.textContent = `−${sec.words}w · ~${secsFor(sec.words)}s`;
    row.appendChild(save);
    // Hover preview: box the highlighted words this row would affect.
    row.addEventListener('mouseenter', () => previewOmissionSection(view, session, sec));
    row.addEventListener('mouseleave', () => previewOmissionSection(view, session, null));
    list.appendChild(row);
  }
  panel.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'pmd-cardcutter-trim-foot';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'pmd-text-prompt-ok';
  done.textContent = 'Done';
  const close = (): void => {
    previewOmissionSection(view, session, null);
    panel.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  done.addEventListener('click', close);
  foot.appendChild(done);
  panel.appendChild(foot);

  document.addEventListener('keydown', onKey);
  document.body.appendChild(panel);
}

/** Refine the read — a compose-then-run dialog. Drop redundancy,
 *  skeletonize, and a target length are all OPTIONAL, composable
 *  settings; free-text guidance steers them, and can run on its own. */
function openHighlightDownSheet(view: EditorView): void {
  const overlay = document.createElement('div');
  overlay.className = 'pmd-route-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-route-dialog pmd-cardcutter-dialog';

  const header = document.createElement('div');
  header.className = 'pmd-route-header';
  header.textContent = 'Refine highlighting';
  dialog.appendChild(header);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  // Modal: swallow every keystroke that isn't aimed at the dialog's own
  // controls, so the underlying doc never sees it (capture phase, before
  // ProseMirror's keydown handler on the editor).
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (!dialog.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── Composable settings (all optional) ──
  let dropRedundancy = false;
  let skeletonize = false;
  let allowAdd = false;
  const toggleSection = document.createElement('div');
  toggleSection.className = 'pmd-cardcutter-section pmd-cardcutter-chips';
  const toggleChip = (text: string, onToggle: (on: boolean) => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-cardcutter-chip';
    b.textContent = text;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      onToggle(on);
    });
    toggleSection.appendChild(b);
  };
  toggleChip('Drop redundancy', (on) => (dropRedundancy = on));
  toggleChip('Skeletonize', (on) => (skeletonize = on));
  toggleChip('Allow adding highlighting', (on) => (allowAdd = on));
  dialog.appendChild(toggleSection);

  // ── Target length (optional; None by default) ──
  let chosenSec: number | null = null;
  const section = document.createElement('div');
  section.className = 'pmd-cardcutter-section';
  section.appendChild(label('Target length (optional)'));
  const row = document.createElement('div');
  row.className = 'pmd-cardcutter-chips';
  const wpm = firstReaderWpm();
  const pressTarget = (active: HTMLButtonElement): void =>
    row.querySelectorAll('.pmd-cardcutter-chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(c === active)),
    );
  const noneChip = document.createElement('button');
  noneChip.type = 'button';
  noneChip.className = 'pmd-cardcutter-chip';
  noneChip.textContent = 'None';
  noneChip.setAttribute('aria-pressed', 'true');
  noneChip.addEventListener('click', () => {
    chosenSec = null;
    pressTarget(noneChip);
  });
  row.appendChild(noneChip);
  for (const sec of READ_TIME_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-cardcutter-chip';
    b.textContent = `${sec}s · ~${Math.round((sec * wpm) / 60)}w`;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      chosenSec = sec;
      pressTarget(b);
    });
    row.appendChild(b);
  }
  section.appendChild(row);
  dialog.appendChild(section);

  // ── Free-text guidance (optional; can run on its own) ──
  const fbSection = document.createElement('div');
  fbSection.className = 'pmd-cardcutter-section';
  fbSection.appendChild(label('Guidance (optional)'));
  const feedbackEl = document.createElement('textarea');
  feedbackEl.className = 'pmd-cardcutter-feedback';
  feedbackEl.rows = 2;
  feedbackEl.placeholder = 'e.g. keep the strongest impact phrasing; drop the China comparison';
  fbSection.appendChild(feedbackEl);
  dialog.appendChild(fbSection);

  const buttons = document.createElement('div');
  buttons.className = 'pmd-text-prompt-buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pmd-route-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  buttons.appendChild(cancel);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'pmd-text-prompt-ok';
  go.textContent = 'Refine';
  go.addEventListener('click', () => {
    const feedback = feedbackEl.value.trim();
    if (!dropRedundancy && !skeletonize && chosenSec === null && !feedback) {
      showToast('Pick a target or a setting, or type some guidance.');
      return;
    }
    close();
    void refineHighlightFocusedCard(view, {
      ...(dropRedundancy ? { dropRedundancy: true } : {}),
      ...(skeletonize ? { skeletonize: true } : {}),
      ...(chosenSec !== null ? { readTimeSec: chosenSec } : {}),
      ...(feedback ? { feedback } : {}),
      ...(allowAdd ? { allowAdd: true } : {}),
    });
  });
  buttons.appendChild(go);
  dialog.appendChild(buttons);

  overlay.appendChild(dialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  // Pull focus off the editor so the doc stops receiving keystrokes.
  dialog.tabIndex = -1;
  dialog.focus();
}

function label(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pmd-cardcutter-label';
  el.textContent = text;
  return el;
}

function firstReaderWpm(): number {
  const r = settings.get('readers');
  return r[0]?.wpm && r[0].wpm > 0 ? r[0].wpm : 350;
}
