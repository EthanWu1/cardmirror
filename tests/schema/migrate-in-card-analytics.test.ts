/**
 * Load-time migration: an `analytic` is no longer legal card content (it anchors
 * its own `analytic_unit`). `splitInCardAnalytics` rewrites any card that still
 * holds an analytic — from a legacy `.cmir` or a `.docx` whose author put an
 * Analytic paragraph under a tag — by splitting it the same way pasting an
 * analytic into a card does: the tag + pre-analytic children stay in the card,
 * each analytic heads a trailing `analytic_unit` that absorbs what follows it.
 */

import { describe, expect, it } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { splitInCardAnalytics } from '../../src/schema/migrate.js';
import { serializeNative, parseNative } from '../../src/native/index.js';

// ---- builders (create, not createChecked — we deliberately build the now-
// invalid in-card-analytic shape that old files contain) ----------------------
const tag = (t: string, id = newHeadingId()) =>
  schema.nodes['tag']!.create({ id }, t ? schema.text(t) : []);
const analytic = (t: string, id = newHeadingId()) =>
  schema.nodes['analytic']!.create({ id }, t ? schema.text(t) : []);
const body = (t: string) => schema.nodes['card_body']!.create(null, t ? schema.text(t) : []);
const cite = (t: string) => schema.nodes['cite_paragraph']!.create(null, t ? schema.text(t) : []);
const undertag = (t: string) => schema.nodes['undertag']!.create(null, t ? schema.text(t) : []);
const card = (...k: PMNode[]) => schema.nodes['card']!.create(null, Fragment.fromArray(k));
const unit = (...k: PMNode[]) => schema.nodes['analytic_unit']!.create(null, Fragment.fromArray(k));
const makeDoc = (...k: PMNode[]) => schema.nodes['doc']!.create(null, Fragment.fromArray(k));

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

describe('splitInCardAnalytics', () => {
  it('analytic right after the tag → card[tag] + analytic_unit absorbing the rest', () => {
    const doc = makeDoc(card(tag('T', 't1'), analytic('A', 'a1'), body('below')));
    const after = splitInCardAnalytics(doc);
    expect(topTypes(after)).toEqual(['card', 'analytic_unit']);
    expect(childTypes(nth(after, 0))).toEqual(['tag']);
    expect(childTypes(nth(after, 1))).toEqual(['analytic', 'card_body']);
    expect(nth(after, 1).textContent).toBe('Abelow');
  });

  it('content before the analytic stays in the card; below absorbs into the unit', () => {
    const doc = makeDoc(card(tag('T'), body('above'), analytic('A'), body('below'), cite('c')));
    const after = splitInCardAnalytics(doc);
    expect(topTypes(after)).toEqual(['card', 'analytic_unit']);
    expect(childTypes(nth(after, 0))).toEqual(['tag', 'card_body']);
    expect(nth(after, 0).textContent).toBe('Tabove');
    expect(childTypes(nth(after, 1))).toEqual(['analytic', 'card_body', 'cite_paragraph']);
    expect(nth(after, 1).textContent).toBe('Abelowc');
  });

  it('multiple analytics → one analytic_unit each, absorbing what follows', () => {
    const doc = makeDoc(
      card(tag('T'), body('b0'), analytic('A1'), body('b1'), cite('cc'), analytic('A2'), body('b2')),
    );
    const after = splitInCardAnalytics(doc);
    expect(topTypes(after)).toEqual(['card', 'analytic_unit', 'analytic_unit']);
    expect(childTypes(nth(after, 0))).toEqual(['tag', 'card_body']);
    expect(childTypes(nth(after, 1))).toEqual(['analytic', 'card_body', 'cite_paragraph']);
    expect(childTypes(nth(after, 2))).toEqual(['analytic', 'card_body']);
    expect(nth(after, 1).firstChild!.textContent).toBe('A1');
    expect(nth(after, 2).firstChild!.textContent).toBe('A2');
  });

  it('preserves the tag and analytic ids', () => {
    const doc = makeDoc(card(tag('T', 'tag-keep'), analytic('A', 'an-keep'), body('x')));
    const after = splitInCardAnalytics(doc);
    expect(nth(after, 0).firstChild!.attrs['id']).toBe('tag-keep');
    expect(nth(after, 1).firstChild!.attrs['id']).toBe('an-keep');
  });

  it('produces a schema-valid document', () => {
    const doc = makeDoc(card(tag('T'), body('above'), analytic('A'), undertag('u'), body('below')));
    const after = splitInCardAnalytics(doc);
    expect(() => after.check()).not.toThrow();
  });

  it('leaves cards without an in-card analytic untouched (same node, no churn)', () => {
    const doc = makeDoc(
      card(tag('A1'), body('x'), cite('c')),
      unit(analytic('U'), body('y')),
    );
    const after = splitInCardAnalytics(doc);
    expect(after).toBe(doc); // referential no-op
  });

  it('only splits the affected card; siblings keep their order', () => {
    const doc = makeDoc(
      card(tag('First'), body('f')),
      card(tag('Mid'), analytic('A'), body('m')),
      card(tag('Last'), body('l')),
    );
    const after = splitInCardAnalytics(doc);
    expect(topTypes(after)).toEqual(['card', 'card', 'analytic_unit', 'card']);
    expect(nth(after, 0).firstChild!.textContent).toBe('First');
    expect(nth(after, 1).firstChild!.textContent).toBe('Mid');
    expect(nth(after, 3).firstChild!.textContent).toBe('Last');
  });
});

describe('parseNative applies the in-card-analytic migration', () => {
  it('round-trips an old in-card-analytic card into card + analytic_unit', () => {
    const oldDoc = makeDoc(card(tag('T', 't1'), analytic('A', 'a1'), body('below')));
    const bytes = serializeNative(oldDoc);
    const { doc: migrated } = parseNative(bytes);
    expect(topTypes(migrated)).toEqual(['card', 'analytic_unit']);
    expect(childTypes(nth(migrated, 1))).toEqual(['analytic', 'card_body']);
    expect(() => migrated.check()).not.toThrow();
  });
});
