/**
 * `zoneChildSendRange` — send-to-dropzone for a selection INSIDE a live zone.
 * A live zone is `isolating`, so a keyboard selection can't cross its boundary
 * and the general top-level normalizer never sees the in-zone cards. This snaps
 * the selection to the whole transcluded cards it overlaps, so the send carries
 * clean cards (and, since it slices the zone's children not the zone node, no
 * live link travels with them).
 */
import { describe, expect, it } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { zoneChildSendRange } from '../../src/editor/speech-doc-send.js';
import { createTransclusionNode, contentHash } from '../../src/editor/transclusion.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const bodyOf = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (t: string, b: string) => schema.nodes['card']!.create(null, Fragment.fromArray([tag(t), bodyOf(b)]));
const para = (t: string) => schema.nodes['paragraph']!.create(null, schema.text(t));
function zone(children: PMNode[]): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(
    schema,
    { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'H', source_content_hash: contentHash(content) },
    content,
  );
}
const makeDoc = (...k: PMNode[]) => schema.nodes['doc']!.create(null, Fragment.fromArray(k));

function findText(doc: PMNode, t: string, off: number): number {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p === -1 && n.isText && n.text === t) p = pos + off;
    return p === -1;
  });
  if (p < 0) throw new Error(`not found: ${t}`);
  return p;
}
// The zone's own position (doc.nodeAt(zonePos) === the zone).
function zonePosOf(doc: PMNode): number {
  let found = -1;
  doc.forEach((n, offset) => {
    if (found === -1 && n.type.name === 'transclusion_ref') found = offset;
  });
  return found;
}
// The top-level types of the sliced range, to prove whole cards (no zone) come out.
function sliceTypes(doc: PMNode, r: { from: number; to: number }): string[] {
  const out: string[] = [];
  doc.slice(r.from, r.to).content.forEach((n) => out.push(n.type.name));
  return out;
}

describe('zoneChildSendRange — send from inside a live zone', () => {
  const doc = makeDoc(
    para('intro'),
    zone([card('A', 'aaaaaa'), card('B', 'bbbbbb'), card('C', 'cccccc')]),
    para('outro'),
  );
  const zp = zonePosOf(doc);

  it('a cursor-sized selection inside one card → that whole card', () => {
    const at = findText(doc, 'bbbbbb', 2);
    const r = zoneChildSendRange(doc, zp, at, at + 1)!;
    expect(r).not.toBeNull();
    expect(sliceTypes(doc, r)).toEqual(['card']);
    expect(doc.slice(r.from, r.to).content.textBetween(0, doc.slice(r.from, r.to).content.size, ' ')).toContain('bbbbbb');
  });

  it('a selection straddling two cards → both, whole (never split)', () => {
    const r = zoneChildSendRange(doc, zp, findText(doc, 'bbbbbb', 3), findText(doc, 'cccccc', 2))!;
    expect(sliceTypes(doc, r)).toEqual(['card', 'card']);
    const txt = doc.slice(r.from, r.to).content.textBetween(0, doc.slice(r.from, r.to).content.size, ' ');
    expect(txt).toContain('bbbbbb');
    expect(txt).toContain('cccccc');
  });

  it('sliced range carries plain cards, not the zone wrapper (no live link)', () => {
    const at = findText(doc, 'aaaaaa', 1);
    const r = zoneChildSendRange(doc, zp, at, at + 2)!;
    const slice = doc.slice(r.from, r.to);
    expect(slice.openStart).toBe(0);
    expect(slice.openEnd).toBe(0);
    let zones = 0;
    slice.content.descendants((n) => {
      if (n.type.name === 'transclusion_ref') zones++;
      return true;
    });
    expect(zones).toBe(0);
  });

  it('all three cards when the selection spans the whole zone', () => {
    const r = zoneChildSendRange(doc, zp, findText(doc, 'aaaaaa', 1), findText(doc, 'cccccc', 5))!;
    expect(sliceTypes(doc, r)).toEqual(['card', 'card', 'card']);
  });
});
