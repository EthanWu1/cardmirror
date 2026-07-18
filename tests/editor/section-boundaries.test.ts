/**
 * sectionEndFromHeading equivalence (audit A-12/A-13, 2026-07-11).
 *
 * The flat sibling scan must return byte-identical section ends to the old
 * O(rest of doc) `nodesBetween` idiom (reproduced here as the REFERENCE, with
 * its zone-opacity guard — the canonical old `computeHeadingRange` behavior)
 * on every heading of randomized flat documents. Two deliberate deltas are
 * asserted explicitly:
 *   - live-view (`self_ref`) innards can no longer truncate an enclosing
 *     section (the old scan guarded zones but NOT views — latent bug);
 *   - zone-INNER headings get a range bounded to their zone, instead of one
 *     escaping into the host document.
 * Plus: move-container zone/view no-op parity (its old resolver reached no-op
 * via a range the alignment guard rejected; the new one refuses directly).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  collectHeadings,
  computeHeadingRange,
  sectionEndFromHeading,
  TYPE_TO_LEVEL,
} from '../../src/editor/headings.js';
import { moveContainerDown, moveContainerUp } from '../../src/editor/move-container.js';

const n = schema.nodes;
const heading = (type: 'pocket' | 'hat' | 'block', text: string): PMNode =>
  n[type]!.create({ id: newHeadingId() }, schema.text(text));
const card = (tagText: string): PMNode =>
  n['card']!.create(null, [
    n['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
    n['card_body']!.create(null, schema.text('body words for ' + tagText)),
  ]);
const para = (text: string): PMNode => n['paragraph']!.create(null, schema.text(text));
const zone = (children: PMNode[]): PMNode =>
  n['transclusion_ref']!.create({ source_ref: 'other.cmir' }, children);
const view = (children: PMNode[]): PMNode =>
  n['self_ref']!.create({ source_heading_id: 'X', source_label: 'View' }, children);

/** REFERENCE: the old computeHeadingRange boundary scan, verbatim — nodesBetween
 *  to doc end, zone-opacity guard, NO self_ref guard (its latent bug preserved,
 *  so the self_ref delta below is asserted against the real old behavior). */
function referenceSectionEnd(doc: PMNode, headingPos: number, level: number): number {
  const node = doc.nodeAt(headingPos)!;
  let to = doc.content.size;
  doc.nodesBetween(headingPos + node.nodeSize, doc.content.size, (nd, pos) => {
    if (to !== doc.content.size) return false;
    const t = nd.type.name;
    if (t === 'transclusion_ref') return false;
    if (t in TYPE_TO_LEVEL && TYPE_TO_LEVEL[t]! <= level) {
      to = pos;
      return false;
    }
    return true;
  });
  return to;
}

/** Tiny deterministic LCG so failures reproduce. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomDoc(rng: () => number): PMNode {
  const kids: PMNode[] = [];
  const count = 10 + Math.floor(rng() * 40);
  for (let i = 0; i < count; i++) {
    const r = rng();
    if (r < 0.12) kids.push(heading('pocket', `P${i}`));
    else if (r < 0.28) kids.push(heading('hat', `H${i}`));
    else if (r < 0.5) kids.push(heading('block', `B${i}`));
    else if (r < 0.8) kids.push(card(`T${i}`));
    else if (r < 0.9) kids.push(para(`loose ${i}`));
    else kids.push(zone([heading('block', `ZB${i}`), card(`ZT${i}`)]));
  }
  return n['doc']!.createChecked(null, kids);
}

describe('sectionEndFromHeading ≡ old boundary scan', () => {
  it('agrees with the reference on every heading of 40 random docs', () => {
    const rng = makeRng(0xc0ffee);
    for (let d = 0; d < 40; d++) {
      const doc = randomDoc(rng);
      for (const entry of collectHeadings(doc, { skipCite: true })) {
        if (entry.zonePos !== null) continue; // zone-inner: new semantics, below
        if (!(entry.type === 'pocket' || entry.type === 'hat' || entry.type === 'block')) continue;
        const node = doc.nodeAt(entry.pos)!;
        const $pos = doc.resolve(entry.pos);
        const got = sectionEndFromHeading(
          $pos.parent,
          $pos.index(),
          entry.pos + node.nodeSize,
          entry.level,
        );
        const want = referenceSectionEnd(doc, entry.pos, entry.level);
        expect(got, `doc ${d}, ${entry.type} "${entry.text}" @${entry.pos}`).toBe(want);
        // computeHeadingRange (rewritten on the helper) must agree too.
        const r = computeHeadingRange(doc, entry)!;
        expect(r.from).toBe(entry.pos);
        expect(r.to).toBe(want);
      }
    }
  });

  it('last heading in the doc spans to doc end', () => {
    const doc = n['doc']!.createChecked(null, [heading('block', 'ONLY'), card('T1'), card('T2')]);
    const entry = collectHeadings(doc, { skipCite: true })[0]!;
    expect(computeHeadingRange(doc, entry)!.to).toBe(doc.content.size);
  });

  it('a zone between a heading and its boundary does not truncate (old and new agree)', () => {
    const doc = n['doc']!.createChecked(null, [
      heading('hat', 'MINE'),
      card('T1'),
      zone([heading('pocket', 'SHALLOWER INSIDE ZONE'), card('ZT')]),
      card('T2'),
      heading('hat', 'REAL BOUNDARY'),
    ]);
    const entry = collectHeadings(doc, { skipCite: true }).find((e) => e.text === 'MINE')!;
    const want = referenceSectionEnd(doc, entry.pos, entry.level);
    const got = computeHeadingRange(doc, entry)!.to;
    expect(got).toBe(want);
    // And that shared value is the REAL boundary, past the whole zone.
    const boundary = collectHeadings(doc, { skipCite: true }).find(
      (e) => e.text === 'REAL BOUNDARY',
    )!;
    expect(got).toBe(boundary.pos);
  });

  it('live-view innards no longer truncate the enclosing section (old scan bug)', () => {
    const doc = n['doc']!.createChecked(null, [
      heading('hat', 'MINE'),
      view([heading('pocket', 'MIRRORED SHALLOWER'), card('VT')]),
      card('T2'),
      heading('hat', 'REAL BOUNDARY'),
    ]);
    const entries = collectHeadings(doc, { skipCite: true });
    const entry = entries.find((e) => e.text === 'MINE')!;
    const boundary = entries.find((e) => e.text === 'REAL BOUNDARY')!;
    // The old scan descended into self_ref and stopped at the mirrored pocket:
    const viewNode = doc.nodeAt(entries.find((e) => e.text === 'MINE')!.pos)!;
    const oldTo = referenceSectionEnd(doc, entry.pos, entry.level);
    expect(oldTo).toBeLessThan(boundary.pos); // documents the old bug
    void viewNode;
    // The sibling scan reaches the real boundary.
    expect(computeHeadingRange(doc, entry)!.to).toBe(boundary.pos);
  });

  it('zone-INNER headings get a range bounded to their zone (new semantics)', () => {
    const doc = n['doc']!.createChecked(null, [
      heading('pocket', 'HOST'),
      zone([heading('block', 'INNER'), card('ZT1'), card('ZT2')]),
      card('OUTSIDE'),
      heading('pocket', 'NEXT'),
    ]);
    const entry = collectHeadings(doc, { skipCite: true }).find((e) => e.text === 'INNER')!;
    expect(entry.zonePos).not.toBeNull();
    const r = computeHeadingRange(doc, entry)!;
    // Bounded within the zone: ends at the zone's content end, not out in the
    // host doc (the old scan escaped to the next host heading).
    const zoneNode = doc.nodeAt(entry.zonePos!)!;
    expect(r.to).toBeLessThanOrEqual(entry.zonePos! + zoneNode.nodeSize - 1);
    expect(r.to).toBeGreaterThan(entry.pos);
  });
});

describe('move-container zone/view parity', () => {
  function stateAt(doc: PMNode, pos: number): EditorState {
    return EditorState.create({ doc, selection: TextSelection.create(doc, pos), schema });
  }
  function posInText(doc: PMNode, needle: string): number {
    let found = -1;
    doc.descendants((nd, p) => {
      if (found >= 0) return false;
      if (nd.isText && nd.text?.includes(needle)) found = p + 1;
      return true;
    });
    if (found < 0) throw new Error(`no text "${needle}"`);
    return found;
  }
  const docWithZone = (): PMNode =>
    n['doc']!.createChecked(null, [
      heading('block', 'B1'),
      card('T1'),
      zone([heading('block', 'ZB'), card('ZT'), para('zone para')]),
      heading('block', 'B2'),
      card('T2'),
    ]);

  it('cursor in a zone-inner card: no-op (matches old alignment-guard outcome)', () => {
    const doc = docWithZone();
    const state = stateAt(doc, posInText(doc, 'ZT'));
    expect(moveContainerDown()(state, undefined)).toBe(false);
    expect(moveContainerUp()(state, undefined)).toBe(false);
  });

  it('cursor in zone-inner loose content: no-op', () => {
    const doc = docWithZone();
    const state = stateAt(doc, posInText(doc, 'zone para'));
    expect(moveContainerDown()(state, undefined)).toBe(false);
  });

  it('normal moves still work: card hops the next block heading', () => {
    const doc = docWithZone();
    let moved: PMNode | null = null;
    const state = stateAt(doc, posInText(doc, 'body words for T2'));
    const ok = moveContainerUp()(state, (tr) => {
      moved = tr.doc;
    });
    expect(ok).toBe(true);
    // T2's card lands above the B2 heading (one spot up).
    const seq: string[] = [];
    moved!.forEach((child) => {
      seq.push(child.type.name === 'card' ? child.firstChild!.textContent : child.textContent);
    });
    expect(seq.indexOf('T2')).toBeLessThan(seq.indexOf('B2'));
  });
});
