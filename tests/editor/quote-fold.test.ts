import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { foldQuotes, normalizeForMatch } from '../../src/editor/word-break.js';
import {
  findReplacePlugin,
  findReplaceKey,
} from '../../src/editor/find-replace-plugin.js';

describe('foldQuotes', () => {
  it('folds curly single/double quotes to straight, length-preserving', () => {
    expect(foldQuotes('the court’s ‘view’')).toBe("the court's 'view'");
    expect(foldQuotes('“clear” rule')).toBe('"clear" rule');
    // length is unchanged so it never shifts match offsets
    const s = 'a’b“c”d';
    expect(foldQuotes(s).length).toBe(s.length);
  });
  it('leaves straight quotes and other text untouched', () => {
    expect(foldQuotes(`it's "fine"`)).toBe(`it's "fine"`);
    expect(foldQuotes('no quotes here')).toBe('no quotes here');
  });
});

describe('normalizeForMatch', () => {
  it('folds quotes + every Unicode dash (length-preserving, identity map)', () => {
    expect(normalizeForMatch('a–b—c‐d').text).toBe('a-b-c-d'); // en/em/hyphen → -
    expect(normalizeForMatch('the court’s “view”').text).toBe(`the court's "view"`);
    // length-preserving folds → map is the identity (plus the end sentinel)
    const r = normalizeForMatch('a–b');
    expect(r.text).toBe('a-b');
    expect(r.map).toEqual([0, 1, 2, 3]);
    // the whole \p{Dash} property folds — not just the General-Punctuation range
    for (const cp of [0x2212 /* minus */, 0x2e3a /* two-em */, 0x2e3b /* three-em */, 0xff0d /* fullwidth */]) {
      expect(normalizeForMatch('a' + String.fromCodePoint(cp) + 'b').text).toBe('a-b');
    }
  });

  it('collapses "..." and "…" to one canonical char, with a position map', () => {
    expect(normalizeForMatch('wait... ok').text).toBe('wait… ok');
    expect(normalizeForMatch('wait… ok').text).toBe('wait… ok');
    // map skips the two extra dots: 'a','...','b' → indices 0, 1, (then) 4
    expect(normalizeForMatch('a...b').map).toEqual([0, 1, 4, 5]);
    // the single ellipsis char maps one-to-one
    expect(normalizeForMatch('a…b').map).toEqual([0, 1, 2, 3]);
  });
});

// ---- find/replace honors curly quotes ----

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

function findMatchesFor(d: PMNode, query: string) {
  let state = EditorState.create({ doc: d, plugins: [findReplacePlugin()] });
  state = state.apply(
    state.tr.setMeta(findReplaceKey, {
      type: 'setQuery',
      query,
      caseSensitive: false,
      wholeWord: false,
      anchor: 0,
      sortMode: 'uncategorized',
      categoryOrder: ['heading', 'tag', 'cite', 'other'],
    }),
  );
  return findReplaceKey.getState(state)!.matches;
}

describe('find matches across straight/curly quotes', () => {
  it('a straight-quote query finds smart-quote text', () => {
    const d = doc(card(tag('T'), cardBody('the court’s “clear” rule')));
    expect(findMatchesFor(d, "court's")).toHaveLength(1);
    expect(findMatchesFor(d, '"clear"')).toHaveLength(1);
  });
  it('a curly-quote query finds straight-quote text', () => {
    const d = doc(card(tag('T'), cardBody(`it's "fine"`)));
    expect(findMatchesFor(d, 'it’s')).toHaveLength(1);
    expect(findMatchesFor(d, '“fine”')).toHaveLength(1);
  });
  it('the match range still lands on the real (curly) characters', () => {
    const d = doc(card(tag('T'), cardBody('a court’s b')));
    const m = findMatchesFor(d, "court's");
    expect(m).toHaveLength(1);
    // the matched doc text is the original curly form
    expect(d.textBetween(m[0]!.from, m[0]!.to)).toBe('court’s');
  });
});

describe('find matches across dashes and ellipses', () => {
  it('a hyphen query finds en/em-dash text (and vice versa)', () => {
    const d = doc(card(tag('T'), cardBody('pre–war and pre—war')));
    expect(findMatchesFor(d, 'pre-war')).toHaveLength(2); // en + em dash
    const d2 = doc(card(tag('T'), cardBody('pre-war')));
    expect(findMatchesFor(d2, 'pre–war')).toHaveLength(1); // en-dash query, hyphen text
  });

  it('a "..." query finds "…" text and a "…" query finds "..." text', () => {
    const d = doc(card(tag('T'), cardBody('wait… really')));
    expect(findMatchesFor(d, 'wait...')).toHaveLength(1);
    const d2 = doc(card(tag('T'), cardBody('wait... really')));
    expect(findMatchesFor(d2, 'wait…')).toHaveLength(1);
  });

  it('the match range covers the real characters across an ellipsis collapse', () => {
    // "..." query → matches the single "…" char; range covers exactly it
    const dA = doc(card(tag('T'), cardBody('x…y')));
    const mA = findMatchesFor(dA, '...');
    expect(mA).toHaveLength(1);
    expect(dA.textBetween(mA[0]!.from, mA[0]!.to)).toBe('…');
    // "…" query → matches "..."; range covers all three dots
    const dB = doc(card(tag('T'), cardBody('x...y')));
    const mB = findMatchesFor(dB, '…');
    expect(mB).toHaveLength(1);
    expect(dB.textBetween(mB[0]!.from, mB[0]!.to)).toBe('...');
  });

  it('an earlier ellipsis collapse does not shift a later match', () => {
    // Without the position map, the "..." (3→1) would shift "cd" two chars left.
    const d = doc(card(tag('T'), cardBody('a...b cd')));
    const m = findMatchesFor(d, 'cd');
    expect(m).toHaveLength(1);
    expect(d.textBetween(m[0]!.from, m[0]!.to)).toBe('cd');
  });
});
