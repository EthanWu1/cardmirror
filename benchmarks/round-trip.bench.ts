/**
 * Performance benchmarks for the round-trip pipeline.
 *
 * Run via `npm run test:bench`. Establishes a baseline for regression
 * tracking. Benches every `.docx` in the configured fixtures directory
 * (override with `CARDMIRROR_DOCS_DIR`). Silent when the directory is
 * empty or missing.
 */

import { bench, describe, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fromDocx } from '../src/import/index.js';
import { toDocx } from '../src/export/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { discoverDocxFixtures } from '../tests/round-trip/_fixtures.js';

interface Fixture {
  filename: string;
  bytes: Uint8Array;
  doc: PMNode;
}

const discovered = discoverDocxFixtures();
const loaded: Fixture[] = [];

beforeAll(async () => {
  for (const { filename, fullPath } of discovered) {
    const buf = await readFile(fullPath);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const doc = await fromDocx(bytes);
    loaded.push({ filename, bytes, doc });
  }
});

describe.skipIf(discovered.length === 0)('import (.docx → schema)', () => {
  for (const { filename } of discovered) {
    bench(`import ${filename}`, async () => {
      const fix = loaded.find((f) => f.filename === filename)!;
      await fromDocx(fix.bytes);
    });
  }
});

describe.skipIf(discovered.length === 0)('export (schema → .docx)', () => {
  for (const { filename } of discovered) {
    bench(`export ${filename}`, async () => {
      const fix = loaded.find((f) => f.filename === filename)!;
      await toDocx(fix.doc);
    });
  }
});

describe.skipIf(discovered.length === 0)('full round-trip (.docx → schema → .docx)', () => {
  for (const { filename } of discovered) {
    bench(`round-trip ${filename}`, async () => {
      const fix = loaded.find((f) => f.filename === filename)!;
      const doc = await fromDocx(fix.bytes);
      await toDocx(doc);
    });
  }
});
