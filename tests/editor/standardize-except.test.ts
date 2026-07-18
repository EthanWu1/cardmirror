/**
 * Standardize with exceptions — uniHighlight / uniShade's `except`
 * getter. The commands behave exactly like plain standardize (rewrite
 * every marked run to the active pen color; null pen strips) except
 * runs whose current color matches the configured exception are left
 * completely untouched. Highlight compares Word names exactly;
 * shading compares hex case-insensitively.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { uniHighlight, uniShade } from '../../src/editor/ribbon-commands.js';

const { nodes, marks } = schema;

function tag(text: string) {
  return nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(...inline: PMNode[]) {
  return nodes['card_body']!.create(null, inline);
}
function card(...children: PMNode[]) {
  return nodes['card']!.createChecked(null, children);
}
function doc(...children: PMNode[]) {
  return nodes['doc']!.createChecked(null, children);
}
const t = (text: string, ...m: Mark[]) => schema.text(text, m);
const hl = (color: string): Mark => marks['highlight']!.create({ color });
const sh = (color: string): Mark => marks['shading']!.create({ color });

function run(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

/** Every text run in the doc as { text, color } for the given mark. */
function runsWith(d: PMNode, markName: string): { text: string; color: string | null }[] {
  const out: { text: string; color: string | null }[] = [];
  d.descendants((n) => {
    if (!n.isText) return true;
    const m = n.marks.find((mk) => mk.type.name === markName);
    out.push({ text: n.text ?? '', color: m ? String(m.attrs['color']) : null });
    return true;
  });
  return out;
}

describe('standardize highlighting with exception', () => {
  const mixed = () =>
    doc(card(tag('T'), body(t('a', hl('yellow')), t('b', hl('green')), t('c', hl('cyan')), t('d'))));

  it('rewrites every highlight to the pen color except the exception', () => {
    const state = EditorState.create({ doc: mixed() });
    const next = run(state, uniHighlight(() => 'yellow', 'document', () => 'green'));
    expect(next).not.toBeNull();
    expect(runsWith(next!.doc, 'highlight')).toEqual([
      { text: 'T', color: null },
      { text: 'a', color: 'yellow' },
      { text: 'b', color: 'green' }, // exception: untouched
      { text: 'c', color: 'yellow' },
      { text: 'd', color: null }, // unmarked text stays unmarked
    ]);
  });

  it('null pen strips every highlight except the exception', () => {
    const state = EditorState.create({ doc: mixed() });
    const next = run(state, uniHighlight(() => null, 'document', () => 'green'));
    // 'c' and 'd' merge into one run once both are unmarked.
    expect(runsWith(next!.doc, 'highlight')).toEqual([
      { text: 'T', color: null },
      { text: 'a', color: null },
      { text: 'b', color: 'green' },
      { text: 'cd', color: null },
    ]);
  });

  it('without an exception, still rewrites everything (plain standardize unchanged)', () => {
    const state = EditorState.create({ doc: mixed() });
    const next = run(state, uniHighlight(() => 'cyan', 'document'));
    // The three rewritten runs merge into one once their marks match.
    expect(runsWith(next!.doc, 'highlight')).toEqual([
      { text: 'T', color: null },
      { text: 'abc', color: 'cyan' },
      { text: 'd', color: null },
    ]);
  });

  it('selection scope: only the selected exception survives inside the selection', () => {
    const d = mixed();
    // Select across the runs 'a' and 'b' inside the card body.
    let from = -1;
    d.descendants((n, p) => {
      if (from === -1 && n.type.name === 'card_body') from = p + 1;
    });
    const s = EditorState.create({ doc: d });
    const state = s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, from + 2)));
    const next = run(state, uniHighlight(() => 'yellow', 'selection', () => 'green'));
    expect(runsWith(next!.doc, 'highlight')).toEqual([
      { text: 'T', color: null },
      { text: 'a', color: 'yellow' },
      { text: 'b', color: 'green' }, // exception inside the selection: kept
      { text: 'c', color: 'cyan' }, // outside the selection: untouched
      { text: 'd', color: null },
    ]);
  });
});

describe('standardize background color with exception', () => {
  it('rewrites every shading to the pen color except the exception', () => {
    const d = doc(card(tag('T'), body(t('a', sh('FFFF00')), t('b', sh('D2D2D2')), t('c'))));
    const state = EditorState.create({ doc: d });
    const next = run(state, uniShade(() => 'C0C0C0', 'document', () => 'D2D2D2'));
    expect(runsWith(next!.doc, 'shading')).toEqual([
      { text: 'T', color: null },
      { text: 'a', color: 'C0C0C0' },
      { text: 'b', color: 'D2D2D2' }, // protected grey: untouched
      { text: 'c', color: null },
    ]);
  });

  it('matches the exception hex case-insensitively', () => {
    const d = doc(card(tag('T'), body(t('a', sh('d2d2d2')), t('b', sh('ffff00')))));
    const state = EditorState.create({ doc: d });
    const next = run(state, uniShade(() => 'C0C0C0', 'document', () => 'D2D2D2'));
    expect(runsWith(next!.doc, 'shading')).toEqual([
      { text: 'T', color: null },
      { text: 'a', color: 'd2d2d2' }, // lowercase stored attr still matches — untouched
      { text: 'b', color: 'C0C0C0' },
    ]);
  });

  it('null pen strips every shading except the exception', () => {
    const d = doc(card(tag('T'), body(t('a', sh('FFFF00')), t('b', sh('D2D2D2')))));
    const state = EditorState.create({ doc: d });
    const next = run(state, uniShade(() => null, 'document', () => 'D2D2D2'));
    expect(runsWith(next!.doc, 'shading')).toEqual([
      { text: 'T', color: null },
      { text: 'a', color: null },
      { text: 'b', color: 'D2D2D2' },
    ]);
  });
});
