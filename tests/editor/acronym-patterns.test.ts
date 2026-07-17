/**
 * Custom acronym letters — the phrase table consulted by the acronym
 * commands (Alt-F10 emphasize / Alt-F11 highlight / underlineAcronym).
 * Covers the pure matching/sanitizing helpers and the command-level
 * behavior: custom hit, classic first-letter fallback, whole-word
 * expansion, null pen, and the multi-paragraph fallback.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  matchAcronymPattern,
  sanitizeAcronymPattern,
} from '../../src/editor/acronym-patterns.js';
import {
  emphasizeAcronym,
  highlightAcronym,
  underlineAcronym,
} from '../../src/editor/ribbon-commands.js';
import { settings } from '../../src/editor/settings.js';

const { nodes } = schema;
const tag = (t: string) => nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => nodes['doc']!.createChecked(null, k);

/** Select [from, to] inside the first card_body (offsets into its text). */
function selectInBody(d: PMNode, from: number, to: number): EditorState {
  let start = -1;
  d.descendants((n, p) => {
    if (start === -1 && n.type.name === 'card_body') start = p + 1;
  });
  const s = EditorState.create({ doc: d });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, start + from, start + to)));
}

function run(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

/** Characters in the first card_body carrying the given mark. */
function markedChars(d: PMNode, markName: string): string {
  let out = '';
  d.descendants((n, _p, parent) => {
    if (n.isText && parent?.type.name === 'card_body') {
      if (n.marks.some((m) => m.type.name === markName)) out += n.text ?? '';
    }
    return true;
  });
  return out;
}

afterEach(() => {
  settings.set('acronymPatterns', []);
});

describe('matchAcronymPattern', () => {
  const NUCS = { phrase: 'nuclear weapons', chars: [0, 1, 2, 14] };

  it('matches case-insensitively and exactly', () => {
    expect(matchAcronymPattern('Nuclear Weapons', [NUCS])).toBe(NUCS);
    expect(matchAcronymPattern('nuclear weapons', [NUCS])).toBe(NUCS);
    expect(matchAcronymPattern('nuclear  weapons', [NUCS])).toBeNull(); // spacing differs
    expect(matchAcronymPattern('nuclear weapon', [NUCS])).toBeNull();
  });

  it('ignores entries with no picked letters', () => {
    expect(matchAcronymPattern('nuclear weapons', [{ phrase: 'nuclear weapons', chars: [] }])).toBeNull();
  });
});

describe('sanitizeAcronymPattern', () => {
  it('sorts, dedupes, and drops out-of-range or whitespace offsets', () => {
    expect(
      sanitizeAcronymPattern({ phrase: 'ab cd', chars: [3, 0, 3, 2, 99, -1] }),
    ).toEqual({ phrase: 'ab cd', chars: [0, 3] }); // 2 is the space; 99/-1 out of range
  });

  it('rejects malformed entries', () => {
    expect(sanitizeAcronymPattern(null)).toBeNull();
    expect(sanitizeAcronymPattern({ phrase: 5, chars: [] })).toBeNull();
    expect(sanitizeAcronymPattern({ phrase: 'x', chars: 'nope' })).toBeNull();
  });
});

describe('acronym commands with a custom pattern', () => {
  const D = doc(card(tag('T'), body('the nuclear weapons treaty')));
  // "nuclear weapons" spans offsets [4, 19) of the body text.

  it('highlightAcronym marks the picked letters on a phrase match', () => {
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0, 1, 2, 14] }]);
    const state = selectInBody(D, 4, 19);
    const next = run(state, highlightAcronym(() => 'yellow'));
    expect(next).not.toBeNull();
    expect(markedChars(next!.doc, 'highlight')).toBe('nucs');
  });

  it('matches after whole-word expansion of a partial selection', () => {
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0, 1, 2, 14] }]);
    // Select from mid-"nuclear" to mid-"weapons"; expansion covers both words.
    const state = selectInBody(D, 7, 16);
    const next = run(state, highlightAcronym(() => 'yellow'));
    expect(markedChars(next!.doc, 'highlight')).toBe('nucs');
  });

  it('emphasizeAcronym and underlineAcronym use the same table', () => {
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0, 1, 2, 14] }]);
    const e = run(selectInBody(D, 4, 19), emphasizeAcronym());
    expect(markedChars(e!.doc, 'emphasis_mark')).toBe('nucs');
    const u = run(selectInBody(D, 4, 19), underlineAcronym());
    expect(markedChars(u!.doc, 'underline_mark')).toBe('nucs');
  });

  it('falls back to first letters when no phrase matches', () => {
    const state = selectInBody(D, 4, 19);
    const next = run(state, highlightAcronym(() => 'yellow'));
    expect(markedChars(next!.doc, 'highlight')).toBe('nw');
  });

  it('null pen strips the picked letters instead of highlighting', () => {
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0, 1, 2, 14] }]);
    // First paint them yellow, then run again with the null pen.
    const painted = run(selectInBody(D, 4, 19), highlightAcronym(() => 'yellow'))!;
    const reselected = painted.apply(
      painted.tr.setSelection(TextSelection.create(painted.doc, painted.selection.from, painted.selection.to)),
    );
    const stripped = run(reselected, highlightAcronym(() => null));
    expect(markedChars(stripped!.doc, 'highlight')).toBe('');
  });

  it('multi-paragraph selections keep the classic per-word behavior', () => {
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0, 1, 2, 14] }]);
    const d2 = doc(card(tag('T'), body('nuclear'), body('weapons')));
    let firstStart = -1;
    let secondEnd = -1;
    d2.descendants((n, p) => {
      if (n.type.name === 'card_body') {
        if (firstStart === -1) firstStart = p + 1;
        secondEnd = p + 1 + n.content.size;
      }
    });
    const s = EditorState.create({ doc: d2 });
    const state = s.apply(s.tr.setSelection(TextSelection.create(s.doc, firstStart, secondEnd)));
    const next = run(state, highlightAcronym(() => 'yellow'));
    expect(markedChars(next!.doc, 'highlight')).toBe('nw');
  });
});
