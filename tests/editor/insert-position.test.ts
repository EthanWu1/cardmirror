/**
 * `nearestValidInsertPos` — snaps an insert to a valid drop target *for the kind
 * of content being inserted* (mirroring drag-and-drop): inline text stays at the
 * caret, card content drops inside the enclosing card, a whole card drops at a
 * doc-level gap. Block inserts never split the card the caret is in.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { nearestValidInsertPos } from '../../src/editor/insert-position.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => schema.nodes['card_body']!.create(null, t ? schema.text(t) : []);
const cite = (t: string) => schema.nodes['cite_paragraph']!.create(null, t ? schema.text(t) : []);
const para = (t: string) => schema.nodes['paragraph']!.create(null, t ? schema.text(t) : []);
const block = (t: string) => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.create(null, Fragment.fromArray(k));
const makeDoc = (...k: PMNode[]) => schema.nodes['doc']!.create(null, Fragment.fromArray(k));

const findText = (doc: PMNode, t: string, off: number): number => {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p === -1 && n.isText && n.text === t) p = pos + off;
    return p === -1;
  });
  if (p < 0) throw new Error(`not found: ${t}`);
  return p;
};
const cardsOf = (doc: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  doc.forEach((c) => {
    if (c.type.name === 'card') out.push(c);
  });
  return out;
};
const childTypes = (node: PMNode): string[] => {
  const out: string[] = [];
  node.forEach((c) => out.push(c.type.name));
  return out;
};
const nullIdTags = (doc: PMNode): number => {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === 'tag' && node.attrs['id'] == null) n++;
  });
  return n;
};
// Insert `content` at the snapped position and return the resulting doc.
const snapInsert = (doc: PMNode, caret: number, content: Fragment): PMNode => {
  const at = nearestValidInsertPos(doc, caret, content);
  const st = EditorState.create({ doc });
  return st.apply(st.tr.insert(at, content)).doc;
};

describe('nearestValidInsertPos — content-aware snapping', () => {
  const newCard = () => Fragment.from(card(tag('NEW'), body('new body')));
  const newCite = () => Fragment.from(cite('Cite 24'));
  const inlineText = () => Fragment.from(schema.text('XX'));

  it('a whole card snaps OUT to a doc-level gap (clean sibling, no split)', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const caret = findText(doc, 'alpha body', 5); // mid-body
    const at = nearestValidInsertPos(doc, caret, newCard());
    expect([0, doc.firstChild!.nodeSize]).toContain(at); // before/after the card
    const after = snapInsert(doc, caret, newCard());
    expect(cardsOf(after).length).toBe(2);
    expect(nullIdTags(after)).toBe(0);
    expect(() => after.check()).not.toThrow();
  });

  it('card content (a cite) snaps INSIDE the enclosing card, not out to doc level', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const caret = findText(doc, 'alpha body', 5);
    const at = nearestValidInsertPos(doc, caret, newCite());
    // strictly inside the single card, not at a doc boundary
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(doc.firstChild!.nodeSize);
    const after = snapInsert(doc, caret, newCite());
    expect(cardsOf(after).length).toBe(1); // still ONE card
    expect(childTypes(cardsOf(after)[0]!)).toContain('cite_paragraph');
    expect(cardsOf(after)[0]!.firstChild!.type.name).toBe('tag');
    expect(() => after.check()).not.toThrow();
  });

  it('inline text stays at the caret (inserted inline, card intact)', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const caret = findText(doc, 'alpha body', 5); // between "alpha" and " body"
    expect(nearestValidInsertPos(doc, caret, inlineText())).toBe(caret);
    const after = snapInsert(doc, caret, inlineText());
    expect(cardsOf(after).length).toBe(1);
    expect(after.textContent).toContain('alphaXX body');
  });

  it('card content near the top of a card snaps to the gap above the body (after the tag)', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const at = nearestValidInsertPos(doc, findText(doc, 'alpha body', 0), newCite());
    const after = snapInsert(doc, findText(doc, 'alpha body', 0), newCite());
    expect(childTypes(cardsOf(after)[0]!)).toEqual(['tag', 'cite_paragraph', 'card_body']);
    expect(at).toBeGreaterThan(0);
  });

  it('outside any card, a whole card snaps to the loose paragraph’s boundary', () => {
    const doc = makeDoc(para('loose text here'));
    const caret = findText(doc, 'loose text here', 5);
    const at = nearestValidInsertPos(doc, caret, Fragment.from(card(tag('N'), body('b'))));
    expect([0, doc.firstChild!.nodeSize]).toContain(at);
  });

  it('a position already at a doc-level gap is unchanged for a card', () => {
    const doc = makeDoc(card(tag('A'), body('a')), card(tag('B'), body('b')));
    const gap = doc.child(0).nodeSize;
    expect(nearestValidInsertPos(doc, gap, Fragment.from(card(tag('N'), body('n'))))).toBe(gap);
  });

  it('the RAW caret (no snap) splits the card — the bug this avoids', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body')));
    const caret = findText(doc, 'alpha body', 5);
    const st = EditorState.create({ doc });
    const after = st.apply(st.tr.insert(caret, card(tag('NEW'), body('n')))).doc;
    expect(nullIdTags(after)).toBeGreaterThan(0);
  });
});

// Doc-level structural objects snap to OUTLINE slots for their level, exactly
// like the drag surface: a card lands between cards, a block between blocks.
describe('nearestValidInsertPos — outline-level snapping for doc-level objects', () => {
  // block B1 { card A, card B }  block B2 { card C }
  const b1 = block('B1');
  const cA = card(tag('A'), body('aaa'));
  const cB = card(tag('B'), body('bbb'));
  const b2 = block('B2');
  const cC = card(tag('C'), body('ccc'));
  const doc = makeDoc(b1, cA, cB, b2, cC);
  const posB1 = 0;
  const posCA = b1.nodeSize; // before card A (a tag-level-only slot)
  const posCB = posCA + cA.nodeSize; // before card B (a tag-level-only slot)
  const posB2 = posCB + cB.nodeSize; // before block B2 (a block-level slot)
  const docEnd = doc.content.size;
  const caretInA = findText(doc, 'aaa', 3); // end of card A's body, under block B1

  it('a block snaps to a block-level slot, never between two cards', () => {
    const snap = nearestValidInsertPos(doc, caretInA, Fragment.from(block('NEW')));
    expect([posB1, posB2, docEnd]).toContain(snap);
    expect(snap).not.toBe(posCA);
    expect(snap).not.toBe(posCB);
  });

  it('a card at the same caret DOES snap between cards (tag-level slot)', () => {
    const snap = nearestValidInsertPos(doc, caretInA, Fragment.from(card(tag('N'), body('n'))));
    expect(snap).toBe(posCB); // between card A and card B — a slot the block could not use
  });
});
