// @vitest-environment jsdom
/**
 * Guards the cost of bulk evidence extraction.
 *
 * REGRESSION (field crash 2026-07-20): `extractEvidenceRows` called
 * `buildDescriptor(doc, …)` per row, and that flattens the WHOLE document
 * (a full text string plus one array entry per character). Indexing a single
 * real 0.5 MB debate file took 102 seconds and allocated 2.7 GB, which is
 * what crashed Search Evidence. Flattening once per file made the same file
 * 68 ms. These tests fail loudly if the per-row flatten ever returns.
 */
import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { extractEvidenceRows, type FileEntry } from '../../src/editor/file-search.js';
import {
  buildDescriptor,
  buildDescriptorIn,
  flattenDoc,
  resolveDescriptor,
} from '../../src/editor/learn-anchor.js';

function bigDoc(cards: number, bodyChars: number): PMNode {
  const children: PMNode[] = [];
  for (let i = 0; i < cards; i++) {
    children.push(
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(`Tag number ${i}`)),
        schema.nodes['card_body']!.create(null, schema.text(`${'body text '.repeat(bodyChars / 10)}${i}`)),
      ]),
    );
  }
  return schema.nodes['doc']!.create(null, children);
}

const entry: FileEntry = {
  path: 'C:/prep/big.docx',
  relPath: 'big.docx',
  name: 'big.docx',
  mtimeMs: 1,
};

describe('evidence extraction cost', () => {
  it('extracts a large document in linear time, not per-row-flatten time', () => {
    // 300 cards = 300 tags (always kept) + 300 card bodies, over ~180 KB of
    // text. With the per-row flatten this took tens of seconds; flattening
    // once it is milliseconds. The per-file body cap (80) trims the body rows
    // but every tag is still descriptor-built, so a per-row-flatten
    // regression would still blow the time bound. Loose bound (CI varies) but
    // ~100x under the old cost.
    const doc = bigDoc(300, 600);
    const t0 = Date.now();
    const rows = extractEvidenceRows(doc, entry);
    const elapsed = Date.now() - t0;

    // 300 tags + 80 capped bodies = 380 rows (bodies bounded per file).
    expect(rows.length).toBeGreaterThan(350);
    expect(rows.filter((r) => r.kind === 'body').length).toBe(80);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('scales sub-quadratically: 4x the document is nowhere near 16x the time', () => {
    const small = bigDoc(150, 400);
    const large = bigDoc(600, 400);

    const t0 = Date.now();
    extractEvidenceRows(small, entry);
    const smallMs = Math.max(1, Date.now() - t0);

    const t1 = Date.now();
    extractEvidenceRows(large, entry);
    const largeMs = Date.now() - t1;

    // Quadratic would be ~16x. Linear-ish is ~4x; allow generous slack for
    // noise on a loaded machine while still catching a return to O(n^2).
    expect(largeMs).toBeLessThan(smallMs * 12);
  });

  it('buildDescriptorIn matches buildDescriptor exactly', () => {
    const doc = bigDoc(6, 80);
    const flat = flattenDoc(doc);
    // Probe a spread of ranges across the document.
    for (const [from, to] of [
      [1, 8],
      [20, 60],
      [Math.floor(doc.content.size / 2), Math.floor(doc.content.size / 2) + 25],
    ] as const) {
      expect(buildDescriptorIn(flat, from, to)).toEqual(buildDescriptor(doc, from, to));
    }
  });

  // Slimmer-rows follow-up (2026-07-20): a row used to carry the full text a
  // SECOND time as `textLower`, a THIRD time as `searchText`, and a FOURTH
  // time as `snippet` (always overwritten before display), plus the anchor
  // quote duplicating the whole card body — several KB per row, which is
  // what capped how much of a real corpus could stay indexed under the
  // 50,000-row memory budget.
  it('extracted rows omit the eager textLower/searchText copies and a real snippet', () => {
    const doc = bigDoc(3, 40);
    const [row] = extractEvidenceRows(doc, entry);
    expect(row).toBeDefined();
    expect(row!.textLower).toBeUndefined();
    expect(row!.searchText).toBeUndefined();
    expect(row!.snippet).toBe('');
  });

  it('caps the stored anchor quote for a long textblock, but still relocates it via context', () => {
    // A single card body far longer than the anchor's quote cap.
    const longBody = `${'body text '.repeat(200)}the unique needle phrase`;
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
        schema.nodes['card_body']!.create(null, schema.text(longBody)),
      ]),
    ]);
    const rows = extractEvidenceRows(doc, entry);
    const bodyRow = rows.find((r) => r.kind === 'body');
    expect(bodyRow).toBeDefined();
    // The full row text is kept (needed for search/snippet/display)...
    expect(bodyRow!.text.length).toBeGreaterThan(1_000);
    // ...but the anchor's stored quote is bounded well under the full text,
    // not a second full-length copy of it.
    expect(bodyRow!.anchor.quote.length).toBeLessThan(500);
    expect(bodyRow!.anchor.quote.length).toBeLessThan(bodyRow!.text.length);
    // And the capped quote + context still resolves back to a valid range
    // in the live doc (re-opening a search result still finds the passage).
    const resolved = resolveDescriptor(doc, bodyRow!.anchor);
    expect(resolved).not.toBeNull();
  });
});
