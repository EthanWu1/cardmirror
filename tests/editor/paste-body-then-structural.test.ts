/**
 * A4 — pasting a slice that LEADS with body content and then turns structural
 * (a paragraph copied together with a following heading / card). Neither the
 * card-content fit nor the structural-split path catches it, so without
 * `tryPasteBodyThenStructural` it would fall to PM's default fitter and split
 * the card. Expected: merge the leading body into the cursor's card, split at
 * the first structural node, and the post-cursor tail rides under it.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';
import { tryPasteBodyThenStructural } from '../../src/editor/paste-plugin.js';

const tag = (t: string, id = newHeadingId()) => schema.nodes['tag']!.create({ id }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, t ? schema.text(t) : []);
const citePara = (t: string) => schema.nodes['cite_paragraph']!.create(null, schema.text(t));
const para = (t: string) => schema.nodes['paragraph']!.create(null, schema.text(t));
const hat = (t: string, id = newHeadingId()) => schema.nodes['hat']!.create({ id }, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const makeDoc = (kids: PMNode[]) => schema.nodes['doc']!.createChecked(null, kids);
const flatSlice = (...nodes: PMNode[]) => new Slice(Fragment.fromArray(nodes), 0, 0);

function posInText(doc: PMNode, text: string, offset: number): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos === -1 && n.isText && n.text === text) pos = p + offset;
    return pos === -1;
  });
  if (pos < 0) throw new Error(`text not found: ${text}`);
  return pos;
}
const topTypes = (doc: PMNode): string[] => {
  const out: string[] = [];
  doc.forEach((c) => out.push(c.type.name));
  return out;
};
const childTypes = (node: PMNode): string[] => {
  const out: string[] = [];
  node.forEach((c) => out.push(c.type.name));
  return out;
};
const nth = (doc: PMNode, i: number): PMNode => {
  let found: PMNode | null = null;
  let c = 0;
  doc.forEach((child) => {
    if (c === i) found = child;
    c++;
  });
  if (!found) throw new Error(`no child ${i}`);
  return found;
};

function fit(doc: PMNode, cursor: number, slice: Slice): EditorState | null {
  const base = EditorState.create({ doc, plugins: [absorbPlugin] });
  const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, cursor)));
  const tr = tryPasteBodyThenStructural(state, slice);
  return tr ? state.apply(tr) : null;
}

describe('paste body-then-structural (A4)', () => {
  it('paragraph + heading mid-body: merge the body, split at the heading, tail under it', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const after = fit(doc, posInText(doc, 'BODY', 2), flatSlice(para('pre'), hat('H')))!;
    expect(after).not.toBeNull();
    expect(topTypes(after.doc)).toEqual(['card', 'hat', 'paragraph']);
    expect(childTypes(nth(after.doc, 0))).toEqual(['tag', 'card_body']);
    expect(nth(after.doc, 0).firstChild!.attrs['id']).toBe('t1'); // tag intact
    expect(nth(after.doc, 0).child(1).textContent).toBe('BOpre'); // body merged inline
    expect(nth(after.doc, 1).textContent).toBe('H');
    expect(nth(after.doc, 2).textContent).toBe('DY'); // tail lifted under the heading
  });

  it('paragraph + whole card: body merges; tail absorbs into the pasted card', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const after = fit(
      doc,
      posInText(doc, 'BODY', 2),
      flatSlice(para('pre'), card(tag('N', 'n1'), cardBody('x'))),
    )!;
    expect(topTypes(after.doc)).toEqual(['card', 'card']);
    expect(nth(after.doc, 0).child(1).textContent).toBe('BOpre');
    expect(nth(after.doc, 0).firstChild!.attrs['id']).toBe('t1');
    expect(childTypes(nth(after.doc, 1))).toEqual(['tag', 'card_body', 'card_body']);
    expect(nth(after.doc, 1).firstChild!.attrs['id']).toBe('n1');
    expect(nth(after.doc, 1).child(1).textContent).toBe('x');
    expect(nth(after.doc, 1).child(2).textContent).toBe('DY'); // tail absorbed into the pasted card
  });

  it('paragraph + bare tag: the tag wraps into a card that absorbs the tail', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const after = fit(doc, posInText(doc, 'BODY', 2), flatSlice(para('pre'), tag('N', 'n1')))!;
    expect(topTypes(after.doc)).toEqual(['card', 'card']);
    expect(nth(after.doc, 0).child(1).textContent).toBe('BOpre');
    expect(childTypes(nth(after.doc, 1))).toEqual(['tag', 'card_body']);
    expect(nth(after.doc, 1).child(1).textContent).toBe('DY');
  });

  it('at body start: the body merges in, the whole original body goes under the heading', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const after = fit(doc, posInText(doc, 'BODY', 0), flatSlice(para('pre'), hat('H')))!;
    expect(topTypes(after.doc)).toEqual(['card', 'hat', 'paragraph']);
    expect(nth(after.doc, 0).child(1).textContent).toBe('pre');
    expect(nth(after.doc, 2).textContent).toBe('BODY');
  });

  it('multi-paragraph prefix keeps its breaks (first inline, rest as bodies)', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const after = fit(
      doc,
      posInText(doc, 'BODY', 2),
      flatSlice(para('p1'), para('p2'), hat('H')),
    )!;
    expect(childTypes(nth(after.doc, 0))).toEqual(['tag', 'card_body', 'card_body']);
    expect(nth(after.doc, 0).child(1).textContent).toBe('BOp1');
    expect(nth(after.doc, 0).child(2).textContent).toBe('p2');
    expect(topTypes(after.doc)).toEqual(['card', 'hat', 'paragraph']);
    expect(nth(after.doc, 2).textContent).toBe('DY');
  });

  it('a cite in the prefix lands as a cite block before the split', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const after = fit(doc, posInText(doc, 'BODY', 2), flatSlice(citePara('C'), hat('H')))!;
    expect(childTypes(nth(after.doc, 0))).toEqual(['tag', 'card_body', 'cite_paragraph']);
    expect(nth(after.doc, 0).child(1).textContent).toBe('BO');
    expect(nth(after.doc, 0).child(2).textContent).toBe('C');
  });

  it('bails (null) for a pure-structural lead and for pure-fittable content', () => {
    const doc = makeDoc([card(tag('T', 't1'), cardBody('BODY'))]);
    const base = EditorState.create({ doc, plugins: [absorbPlugin] });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, posInText(doc, 'BODY', 2))),
    );
    expect(tryPasteBodyThenStructural(state, flatSlice(hat('H')))).toBeNull(); // structural leads
    expect(tryPasteBodyThenStructural(state, flatSlice(para('x'), cardBody('y')))).toBeNull(); // no structural
  });
});
