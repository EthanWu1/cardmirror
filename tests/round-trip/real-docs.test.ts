/**
 * Round-trip tests against real Verbatim documents.
 *
 * Strategy:
 *   1. Discover every `.docx` in the configured fixtures directory
 *      (see `_fixtures.ts` for the env-var override).
 *   2. For each file, import → re-export → re-import.
 *   3. Assert round-trip invariants that hold for *any* valid input:
 *      text length, heading IDs, paragraph counts, image counts, the
 *      indent / spacing multisets, etc.
 *
 * Per ARCHITECTURE.md §3, lossless round-trip means semantic equivalence
 * for everything Verbatim and Advanced Verbatim treat as semantic. We
 * don't promise byte equivalence (rsids, generation timestamps, etc.).
 *
 * The suite is silent (no failures, no assertions) when the fixtures
 * directory is missing or empty — that's the expected state on a
 * fresh clone.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { discoverDocxFixtures, resolveDocsDir } from './_fixtures.js';

interface NodeCounts {
  pocket: number;
  hat: number;
  block: number;
  card: number;
  analytic: number;
  undertag: number;
  paragraph: number;
  image: number;
  table: number;
  table_row: number;
  table_cell: number;
  totalParagraphs: number;
  totalTextLength: number;
}

function countNodes(doc: PMNode): NodeCounts {
  const counts: Record<string, number> = {
    pocket: 0,
    hat: 0,
    block: 0,
    card: 0,
    analytic: 0,
    undertag: 0,
    paragraph: 0,
    image: 0,
    table: 0,
    table_row: 0,
    table_cell: 0,
    totalParagraphs: 0,
    totalTextLength: 0,
  };
  doc.descendants((node) => {
    const n = node.type.name;
    if (n in counts) {
      counts[n]! += 1;
    }
    if (
      n === 'pocket' || n === 'hat' || n === 'block' || n === 'tag' ||
      n === 'analytic' || n === 'undertag' || n === 'cite_paragraph' ||
      n === 'card_body' || n === 'paragraph'
    ) {
      counts['totalParagraphs']! += 1;
    }
    if (node.isText) {
      counts['totalTextLength']! += node.text?.length ?? 0;
    }
    return true;
  });
  return counts as unknown as NodeCounts;
}

const fixtures = discoverDocxFixtures();

describe.skipIf(fixtures.length === 0)('round-trip: real example docs', () => {
  if (fixtures.length === 0) {
    // Vitest still evaluates the describe body, even when skipping the
    // suite. Log once so users running the tests with no fixtures know
    // why this suite reported zero tests.
    console.log(
      `[round-trip] no .docx files found in ${resolveDocsDir()}; ` +
        `set CARDMIRROR_DOCS_DIR to a folder of .docx fixtures to run real-doc tests.`,
    );
  }
  for (const fixture of fixtures) {
    describe(fixture.filename, () => {
      let imported: PMNode;
      let importCounts: NodeCounts;
      let roundTripped: PMNode;
      let roundTripCounts: NodeCounts;

      beforeAll(async () => {
        const buf = await readFile(fixture.fullPath);
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        imported = await fromDocx(bytes);
        importCounts = countNodes(imported);
        const exportedBytes = await toDocx(imported);
        roundTripped = await fromDocx(exportedBytes);
        roundTripCounts = countNodes(roundTripped);
      }, /* timeout */ 60000);

      it('imports without error', () => {
        expect(imported.type.name).toBe('doc');
        expect(importCounts.totalParagraphs).toBeGreaterThan(0);
      });

      it('preserves text length through round-trip', () => {
        expect(roundTripCounts.totalTextLength).toBe(importCounts.totalTextLength);
      });

      it('preserves heading counts through round-trip', () => {
        expect(roundTripCounts.pocket).toBe(importCounts.pocket);
        expect(roundTripCounts.hat).toBe(importCounts.hat);
        expect(roundTripCounts.block).toBe(importCounts.block);
        expect(roundTripCounts.card).toBe(importCounts.card);
        expect(roundTripCounts.analytic).toBe(importCounts.analytic);
      });

      it('preserves heading IDs through round-trip', () => {
        const ids1 = collectHeadingIds(imported);
        const ids2 = collectHeadingIds(roundTripped);
        expect(ids2.size).toBe(ids1.size);
        for (const id of ids1) {
          expect(ids2.has(id), `id ${id} should survive round-trip`).toBe(true);
        }
      });

      it('preserves total paragraph count through round-trip', () => {
        expect(roundTripCounts.totalParagraphs).toBe(importCounts.totalParagraphs);
      });

      it('preserves image count through round-trip', () => {
        expect(roundTripCounts.image).toBe(importCounts.image);
      });

      it('preserves table structure through round-trip', () => {
        expect(roundTripCounts.table).toBe(importCounts.table);
        expect(roundTripCounts.table_row).toBe(importCounts.table_row);
        expect(roundTripCounts.table_cell).toBe(importCounts.table_cell);
      });

      it('preserves paragraph indent values through round-trip', () => {
        const before = collectIndentBag(imported);
        const after = collectIndentBag(roundTripped);
        // Multiset equality: every (nodeType, dxa) pair appears the
        // same number of times after round-trip as before.
        expect(after).toEqual(before);
      });

      it('preserves paragraph spacing through round-trip', () => {
        const before = collectSpacingBag(imported);
        const after = collectSpacingBag(roundTripped);
        expect(after).toEqual(before);
      });
    });
  }
});

/** Multiset of `${nodeType}:${indent}` keys for every paragraph-like
 *  node that has a non-zero indent. We don't compare zero-indent
 *  paragraphs because that's the default and dominates the count. */
function collectIndentBag(doc: PMNode): Record<string, number> {
  const bag: Record<string, number> = {};
  doc.descendants((node) => {
    const indent = Number(node.attrs?.['indent'] ?? 0);
    if (indent > 0) {
      const key = `${node.type.name}:${indent}`;
      bag[key] = (bag[key] ?? 0) + 1;
    }
    return true;
  });
  return bag;
}

/** Multiset of `${nodeType}:${stable-spacing-key}` for every
 *  paragraph-like node that has a non-null `spacing` attr. The
 *  spacing object is canonicalized by sorting its OOXML attribute
 *  keys so two equivalent specs collapse onto the same string. */
function collectSpacingBag(doc: PMNode): Record<string, number> {
  const bag: Record<string, number> = {};
  doc.descendants((node) => {
    const sp = node.attrs?.['spacing'] as Record<string, string> | null;
    if (sp && typeof sp === 'object') {
      const entries = Object.entries(sp).sort(([a], [b]) => a.localeCompare(b));
      const key = `${node.type.name}:${entries.map(([k, v]) => `${k}=${v}`).join('|')}`;
      bag[key] = (bag[key] ?? 0) + 1;
    }
    return true;
  });
  return bag;
}

function collectHeadingIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs?.['id'];
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
    return true;
  });
  return ids;
}
