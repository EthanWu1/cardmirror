/**
 * Mark-fidelity tests: confirm that whatever direct-formatting and
 * named-style marks a real document carries (highlight, font_color,
 * shading, underline_mark, emphasis_mark, etc.), they survive
 * round-trip. Runs against every `.docx` in the configured fixtures
 * directory (see `_fixtures.ts`).
 *
 * No per-file expected mark counts are baked in — the assertion is
 * universal: the mark multiset before round-trip equals the mark
 * multiset after, and the same holds when broken down by
 * mark-attribute value (color, etc.).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { discoverDocxFixtures } from './_fixtures.js';

/** Marks the round-trip is responsible for preserving. (Everything in
 *  the schema's `marks` spec, minus `comment_range` which is a runtime
 *  annotation, not docx-bound.) */
const TRACKED_MARKS = [
  'underline_mark',
  'underline_direct',
  'emphasis_mark',
  'cite_mark',
  'undertag_mark',
  'analytic_mark',
  'highlight',
  'font_color',
  'font_size',
  'font_family',
  'shading',
  'bold',
  'italic',
  'strikethrough',
  'superscript',
  'subscript',
  'link',
  'pilcrow_marker',
];

/** Marks whose `color` (or equivalent string) attr we also track as
 *  a per-value multiset — i.e., yellow-highlight count and
 *  green-highlight count must each survive independently. */
const COLOR_KEYED_MARKS = ['highlight', 'font_color', 'shading'] as const;

function countMarks(doc: PMNode): Record<string, number> {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      counts[mark.type.name] = (counts[mark.type.name] ?? 0) + 1;
    }
  });
  return counts;
}

function countByColor(doc: PMNode, markName: string): Record<string, number> {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === markName) {
        const color = String(mark.attrs['color'] ?? '');
        counts[color] = (counts[color] ?? 0) + 1;
      }
    }
  });
  return counts;
}

const fixtures = discoverDocxFixtures();

describe.skipIf(fixtures.length === 0)('mark fidelity — real docs', () => {
  for (const fixture of fixtures) {
    describe(fixture.filename, () => {
      let imported: PMNode;
      let roundTripped: PMNode;

      beforeAll(async () => {
        const buf = await readFile(fixture.fullPath);
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        imported = await fromDocx(bytes);
        const exportedBytes = await toDocx(imported);
        roundTripped = await fromDocx(exportedBytes);
      }, 60000);

      it('preserves every tracked mark count through round-trip', () => {
        const before = countMarks(imported);
        const after = countMarks(roundTripped);
        for (const name of TRACKED_MARKS) {
          expect(
            after[name] ?? 0,
            `${name} count must survive round-trip in ${fixture.filename}`,
          ).toBe(before[name] ?? 0);
        }
      });

      it('preserves per-color counts for highlight / font_color / shading', () => {
        for (const markName of COLOR_KEYED_MARKS) {
          const before = countByColor(imported, markName);
          const after = countByColor(roundTripped, markName);
          expect(
            after,
            `${markName} per-color multiset must survive round-trip in ${fixture.filename}`,
          ).toEqual(before);
        }
      });
    });
  }
});
