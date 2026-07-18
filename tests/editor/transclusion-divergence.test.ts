import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  contentHash,
  idIndependentHash,
  zoneReferenceShape,
} from '../../src/editor/transclusion.js';
import { createSelfRefNode } from '../../src/editor/self-transclusion.js';
import {
  isInterDocZone,
  sourceShapeNow,
  zoneDiverged,
} from '../../src/editor/transclusion-divergence.js';

function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
const frag = (...cards: PMNode[]): Fragment => Fragment.fromArray(cards);

/** An inter-doc (cross-file) zone whose stored `source_shape_hash` matches the
 *  given "source at pull" content, unless overridden. */
function interZone(
  content: Fragment,
  overrides: Record<string, unknown> = {},
): PMNode {
  return createTransclusionNode(schema, {
    source_ref: '../Other.cmir',
    source_heading_id: 'sec-1',
    source_content_hash: contentHash(content),
    source_shape_hash: idIndependentHash(content),
    ...overrides,
  } as never, content);
}

describe('idIndependentHash', () => {
  it('is identical for the same content under different heading ids', () => {
    expect(idIndependentHash(frag(card('A', 'aa', 'id-1')))).toBe(
      idIndependentHash(frag(card('A', 'aa', 'id-2'))),
    );
  });
  it('differs when the content differs', () => {
    expect(idIndependentHash(frag(card('A', 'aa')))).not.toBe(
      idIndependentHash(frag(card('A', 'bb'))),
    );
  });
});

describe('isInterDocZone', () => {
  it('true for a real cross-file zone', () => {
    expect(isInterDocZone(interZone(frag(card('A', 'a'))))).toBe(true);
  });
  it('false for an intra-doc self_ref (a separate node type)', () => {
    expect(isInterDocZone(createSelfRefNode(schema, 'sec-1', '↳ Sec'))).toBe(false);
  });
  it('false for a zone with no source ref', () => {
    expect(isInterDocZone(interZone(frag(card('A', 'a')), { source_ref: '' }))).toBe(false);
  });
  it('false for a non-zone node', () => {
    expect(isInterDocZone(card('A', 'a'))).toBe(false);
  });
});

describe('zoneReferenceShape', () => {
  it('returns the stored shape hash when present', () => {
    const content = frag(card('A', 'a'));
    const zone = interZone(content);
    expect(zoneReferenceShape(zone)).toBe(idIndependentHash(content));
  });
  it('falls back to the mirror shape for a pre-attr UNEDITED zone', () => {
    const content = frag(card('A', 'a'));
    const zone = interZone(content, { source_shape_hash: '' });
    expect(zoneReferenceShape(zone)).toBe(idIndependentHash(content));
  });
  it('returns null for a pre-attr EDITED zone (unknowable)', () => {
    // Locally edited: content hash no longer matches source_content_hash, and
    // there's no stored shape to fall back on.
    const zone = interZone(frag(card('A', 'edited-locally')), {
      source_shape_hash: '',
      source_content_hash: 'a-different-hash',
    });
    expect(zoneReferenceShape(zone)).toBeNull();
  });
});

describe('zoneDiverged', () => {
  const pulled = frag(card('A', 'a'), card('B', 'b'));
  const zone = interZone(pulled);

  it('not diverged when the source is unchanged', () => {
    expect(zoneDiverged(zone, frag(card('A', 'a'), card('B', 'b')))).toBe(false);
  });
  it('not diverged for an id-only reshuffle of the same content', () => {
    // Fresh ids, identical text — the source didn't really change.
    expect(zoneDiverged(zone, frag(card('A', 'a', 'x'), card('B', 'b', 'y')))).toBe(false);
  });
  it('diverged when the source content changed', () => {
    expect(zoneDiverged(zone, frag(card('A', 'a'), card('B', 'CHANGED')))).toBe(true);
  });
  it('diverged when the source gained a block', () => {
    expect(zoneDiverged(zone, frag(card('A', 'a'), card('B', 'b'), card('C', 'c')))).toBe(true);
  });
  it('stays flagged-independent of local edits (edited mirror, source moved)', () => {
    // A mirror edited AND whose source moved: still diverged, because the
    // reference is the STORED shape, not the (edited) mirror content.
    const editedZone = interZone(pulled, { source_content_hash: 'edited' });
    expect(zoneDiverged(editedZone, frag(card('A', 'NEW'), card('B', 'b')))).toBe(true);
  });
  it('false when the reference shape is unknown', () => {
    const unknowable = interZone(pulled, { source_shape_hash: '', source_content_hash: 'edited' });
    expect(zoneDiverged(unknowable, frag(card('A', 'anything')))).toBe(false);
  });
});

describe('sourceShapeNow', () => {
  it('matches the stored shape a zone was created with', () => {
    const content = frag(card('A', 'a'), card('B', 'b'));
    const zone = interZone(content);
    // A fresh read of the identical section (different ids) → same shape.
    expect(sourceShapeNow(frag(card('A', 'a', 'p'), card('B', 'b', 'q')))).toBe(
      String(zone.attrs['source_shape_hash']),
    );
  });
});
