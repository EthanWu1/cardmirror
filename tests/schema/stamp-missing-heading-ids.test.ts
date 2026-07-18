import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  HEADING_TYPE_NAMES,
  newHeadingId,
  stampMissingHeadingIds,
} from '../../src/schema/ids.js';

function tagWithId(text: string, id: string | null) {
  // Pass the id attribute literally — `null` simulates the
  // pre-alpha.6 F2 schema-fitter synthesis path.
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}

function cardBody(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}

function cardWith(...children: PMNode[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function makeDoc(children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function tagIds(doc: PMNode): Array<string | null> {
  const out: Array<string | null> = [];
  doc.descendants((n) => {
    if (HEADING_TYPE_NAMES.has(n.type.name)) {
      const id = (n.attrs as Record<string, unknown>)['id'];
      out.push(typeof id === 'string' ? id : null);
    }
    return true;
  });
  return out;
}

describe('stampMissingHeadingIds', () => {
  it('leaves a doc with all-stamped headings untouched (identity return)', () => {
    const doc = makeDoc([
      cardWith(tagWithId('A', newHeadingId()), cardBody('a body')),
      cardWith(tagWithId('B', newHeadingId()), cardBody('b body')),
    ]);
    const stamped = stampMissingHeadingIds(doc);
    expect(stamped).toBe(doc);
  });

  it('stamps a tag whose id is null', () => {
    const doc = makeDoc([
      cardWith(tagWithId('A', null), cardBody('a body')),
    ]);
    const stamped = stampMissingHeadingIds(doc);
    const ids = tagIds(stamped);
    expect(ids).toHaveLength(1);
    expect(typeof ids[0]).toBe('string');
    expect(ids[0]).not.toBe(null);
  });

  it('stamps only the null-id tag in a mixed doc; leaves others alone', () => {
    const keepId = newHeadingId();
    const doc = makeDoc([
      cardWith(tagWithId('A', keepId), cardBody('a body')),
      cardWith(tagWithId('B', null), cardBody('b body')),
      cardWith(tagWithId('C', null), cardBody('c body')),
    ]);
    const stamped = stampMissingHeadingIds(doc);
    const ids = tagIds(stamped);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(keepId);
    expect(typeof ids[1]).toBe('string');
    expect(typeof ids[2]).toBe('string');
    // Every stamped id should be unique.
    expect(new Set(ids).size).toBe(3);
  });

  it('stamps headings at every level (pocket / hat / block / tag / analytic)', () => {
    const pocket = schema.nodes['pocket']!.create({ id: null }, schema.text('P'));
    const hat = schema.nodes['hat']!.create({ id: null }, schema.text('H'));
    const block = schema.nodes['block']!.create({ id: null }, schema.text('B'));
    const tag = tagWithId('T', null);
    const card = cardWith(tag, cardBody('body'));
    const analyticHead = schema.nodes['analytic']!.create({ id: null }, schema.text('A'));
    const analyticUnit = schema.nodes['analytic_unit']!.createChecked(null, [analyticHead]);
    const doc = makeDoc([pocket, hat, block, card, analyticUnit]);
    const stamped = stampMissingHeadingIds(doc);
    const ids = tagIds(stamped);
    expect(ids).toHaveLength(5);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id).not.toBe(null);
    }
  });

  it('preserves non-heading nodes verbatim (card_body content untouched)', () => {
    const doc = makeDoc([
      cardWith(tagWithId('A', null), cardBody('body content stays exactly the same')),
    ]);
    const stamped = stampMissingHeadingIds(doc);
    // Walk to the card_body and check text.
    let bodyText: string | null = null;
    stamped.descendants((n) => {
      if (n.type.name === 'card_body') bodyText = n.textContent;
      return true;
    });
    expect(bodyText).toBe('body content stays exactly the same');
  });

  it('preserves indent + spacing attrs on the stamped heading', () => {
    const tagWithExtras = schema.nodes['tag']!.create(
      { id: null, indent: 240, spacing: { 'w:after': '160' } },
      schema.text('A'),
    );
    const doc = makeDoc([
      cardWith(tagWithExtras, cardBody('body')),
    ]);
    const stamped = stampMissingHeadingIds(doc);
    let stampedAttrs: Record<string, unknown> | null = null;
    stamped.descendants((n) => {
      if (n.type.name === 'tag') stampedAttrs = n.attrs as Record<string, unknown>;
      return true;
    });
    expect(stampedAttrs).not.toBeNull();
    expect(stampedAttrs!['indent']).toBe(240);
    expect(stampedAttrs!['spacing']).toEqual({ 'w:after': '160' });
    expect(typeof stampedAttrs!['id']).toBe('string');
  });
});
