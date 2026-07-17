#!/usr/bin/env tsx
/**
 * Round-trip CLI.
 *
 * Usage:
 *   npm run round-trip <input.docx> [output.docx]
 *
 * Imports input.docx into our schema, re-exports as output.docx (default:
 * `input.roundtripped.docx` next to the input). Prints a structural and
 * mark-count summary so you can sanity-check what survived.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { Node as PMNode } from 'prosemirror-model';
import { fromDocx } from '../src/import/index.js';
import { toDocx } from '../src/export/index.js';

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npm run round-trip <input.docx> [output.docx]');
    process.exit(2);
  }
  const outputPath = process.argv[3] ?? deriveOutputPath(inputPath);

  console.error(`Reading ${inputPath} ...`);
  const buf = await readFile(inputPath);
  const t0 = Date.now();
  const doc = await fromDocx(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const t1 = Date.now();
  console.error(`  imported in ${t1 - t0}ms`);

  const counts = summarize(doc);
  console.error(`  structure: ${formatCounts(counts.nodes)}`);
  console.error(`  marks:     ${formatCounts(counts.marks)}`);
  console.error(`  text:      ${counts.totalTextLength} chars`);

  console.error(`Exporting to ${outputPath} ...`);
  const t2 = Date.now();
  const bytes = await toDocx(doc);
  const t3 = Date.now();
  console.error(`  exported in ${t3 - t2}ms (${bytes.length} bytes)`);

  await writeFile(outputPath, bytes);
  console.error(`Wrote ${outputPath}`);
}

function deriveOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, '.docx');
  return path.join(dir, `${base}.roundtripped.docx`);
}

interface Counts {
  nodes: Record<string, number>;
  marks: Record<string, number>;
  totalTextLength: number;
}

function summarize(doc: PMNode): Counts {
  const nodes: Record<string, number> = {};
  const marks: Record<string, number> = {};
  let totalTextLength = 0;
  doc.descendants((node) => {
    nodes[node.type.name] = (nodes[node.type.name] ?? 0) + 1;
    if (node.isText) {
      totalTextLength += node.text?.length ?? 0;
      for (const m of node.marks) {
        marks[m.type.name] = (marks[m.type.name] ?? 0) + 1;
      }
    }
    return true;
  });
  return { nodes, marks, totalTextLength };
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
