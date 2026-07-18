/**
 * Shared docx-fixture discovery for the round-trip test suite and the
 * round-trip benchmark.
 *
 * The suite isn't pinned to a hand-curated list of files. Instead it
 * runs against every `.docx` file in a directory the caller supplies
 * via the `CARDMIRROR_DOCS_DIR` environment variable. When the
 * variable isn't set, the default is `reference-docs/example docs`
 * (where the project owner keeps their own working corpus). When the
 * directory doesn't exist or contains no `.docx` files, discovery
 * returns an empty list and the suite skips itself — that's the
 * expected behavior on a fresh clone.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface DocxFixture {
  /** Display name used by `describe(...)` blocks. */
  filename: string;
  /** Absolute path to the .docx on disk. */
  fullPath: string;
}

const DEFAULT_DOCS_DIR = 'reference-docs/example docs';

export function resolveDocsDir(): string {
  const fromEnv = process.env['CARDMIRROR_DOCS_DIR'];
  return path.resolve(process.cwd(), fromEnv ?? DEFAULT_DOCS_DIR);
}

export function discoverDocxFixtures(): DocxFixture[] {
  const dir = resolveDocsDir();
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith('.docx') && !name.startsWith('~$'))
    .sort()
    .map((filename) => ({
      filename,
      fullPath: path.join(dir, filename),
    }));
}
