/**
 * Composable scopes (SPEC-voice.md §4.5): containing / iteration /
 * ordinal / every resolution over the debate schema, including flat
 * heading sections and the dumb textual scopes.
 */

import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  scopeRanges,
  containingScope,
  iterationContainer,
  everyInIteration,
  nthInIteration,
} from '../../src/editor/voice/scopes.js';

const n = schema.nodes;
const t = (s: string) => schema.text(s);
const tag = (s: string) => n['tag']!.create({ id: newHeadingId() }, t(s));
const body = (s: string) => n['card_body']!.create(null, t(s));
const cite = (s: string) => n['cite_paragraph']!.create(null, t(s));
const card = (...children: any[]) => n['card']!.create(null, children);
const block = (s: string) => n['block']!.create({ id: newHeadingId() }, t(s));
const hat = (s: string) => n['hat']!.create({ id: newHeadingId() }, t(s));
const para = (s: string) => n['paragraph']!.create(null, t(s));

// hat > [block1 > card1, card2] [block2 > card3], trailing paragraph
const card1 = card(tag('first tag'), cite('first cite'), body('Alpha one. Beta two. Gamma three.'));
const card2 = card(tag('second tag'), body('Delta four words here.'));
const card3 = card(tag('third tag'), body('Epsilon five.'));
const doc = n['doc']!.create(null, [
  para('Preamble before any heading.'),
  hat('the hat'),
  block('block one'),
  card1,
  card2,
  block('block two'),
  card3,
  para('Loose closing paragraph.'),
]);

function textOf(r: { from: number; to: number }) {
  return doc.textBetween(r.from, r.to);
}

function posIn(needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(needle)) {
      found = pos + node.text!.indexOf(needle) + 1;
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`not found: ${needle}`);
  return found;
}

describe('voice composable scopes', () => {
  it('collects node scopes in document order', () => {
    expect(scopeRanges(doc, 'card').length).toBe(3);
    expect(scopeRanges(doc, 'tag').map(textOf)).toEqual(['first tag', 'second tag', 'third tag']);
  });

  it('heading scopes are sections (heading → next same-or-higher)', () => {
    const blocks = scopeRanges(doc, 'block');
    expect(blocks.length).toBe(2);
    // block one's section spans card1+card2 but stops at block two
    expect(textOf(blocks[0]!)).toContain('Delta four');
    expect(textOf(blocks[0]!)).not.toContain('Epsilon');
    // hat's section spans everything below it
    const hats = scopeRanges(doc, 'hat');
    expect(hats.length).toBe(1);
    expect(textOf(hats[0]!)).toContain('Epsilon');
  });

  it('containingScope finds the innermost enclosing range', () => {
    const p = posIn('Beta');
    expect(textOf(containingScope(doc, 'card', p)!)).toContain('first tag');
    expect(textOf(containingScope(doc, 'body', p)!)).toBe('Alpha one. Beta two. Gamma three.');
    expect(textOf(containingScope(doc, 'block', p)!)).toContain('block one');
  });

  it('iteration containers follow the research mapping', () => {
    const p = posIn('Beta');
    // sentences iterate within the paragraph-like block (the body)
    const it1 = iterationContainer(doc, 'sentence', p);
    expect(textOf(it1)).toBe('Alpha one. Beta two. Gamma three.');
    // cards iterate within the containing block section
    const it2 = iterationContainer(doc, 'card', p);
    expect(textOf(it2)).toContain('block one');
    expect(textOf(it2)).not.toContain('Epsilon');
  });

  it('ordinals: "take second sentence" / "take second card"', () => {
    const p = posIn('Alpha');
    expect(textOf(nthInIteration(doc, 'sentence', p, 2)!)).toBe('Beta two.');
    expect(textOf(nthInIteration(doc, 'card', p, 2)!)).toContain('second tag');
    expect(nthInIteration(doc, 'sentence', p, 9)).toBeNull();
  });

  it('every: all tags in the containing card vs all cards in the block', () => {
    const p = posIn('Delta');
    expect(everyInIteration(doc, 'tag', p).map(textOf)).toEqual(['second tag']);
    expect(everyInIteration(doc, 'card', p).length).toBe(2); // block one's cards
  });

  it('word scope rides the tokenizer', () => {
    const p = posIn('Delta');
    expect(textOf(nthInIteration(doc, 'word', posIn('Alpha one'), 1)!)).toBe('Alpha');
  });

  it('outline semantics: a trailing paragraph belongs to the last section', () => {
    const p = posIn('Loose closing');
    expect(textOf(nthInIteration(doc, 'sentence', p, 1)!)).toBe('Loose closing paragraph.');
    // Loose paragraph sits under "block two" in outline terms — its
    // paragraph iteration is that section (card3's body + itself).
    const all = everyInIteration(doc, 'paragraph', p);
    expect(all.length).toBe(2);
    expect(all.map(textOf)).toContain('Loose closing paragraph.');
  });

  it('falls back to the whole doc before any heading exists', () => {
    const p = posIn('Preamble');
    // No card, no block/hat/pocket section contains the preamble —
    // iteration falls all the way back to the document.
    const all = everyInIteration(doc, 'paragraph', p);
    expect(all.length).toBeGreaterThan(4); // every paragraph-like in the doc
    expect(all.map(textOf)).toContain('Preamble before any heading.');
  });
});
