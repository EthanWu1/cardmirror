// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  loadAllEvidenceCache,
  pruneEvidenceCache,
  saveEvidenceCacheEntry,
} from '../../src/editor/evidence-cache.js';
import type { EvidenceSearchRow } from '../../src/editor/file-search.js';

function row(text: string): EvidenceSearchRow {
  return {
    kind: 'tag',
    filePath: 'C:/prep/aff.cmir',
    relPath: 'aff.cmir',
    fileName: 'aff',
    mtimeMs: 100,
    text,
    label: text,
    snippet: text,
    anchor: { quote: text, prefix: '', suffix: '', approxPos: 1 },
    from: 1,
    to: 1 + text.length,
    textLower: text.toLowerCase(),
    searchText: `${text.toLowerCase()} aff`,
  } as EvidenceSearchRow;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('persistent evidence index cache', () => {
  it('persists rows across loads with derived search fields stripped', async () => {
    saveEvidenceCacheEntry('C:/prep/aff.cmir', 100, [row('Solvency deficit tag')]);
    await sleep(20);

    const loaded = await loadAllEvidenceCache();
    const entry = loaded.get('C:/prep/aff.cmir');
    expect(entry).toBeDefined();
    expect(entry!.mtimeMs).toBe(100);
    expect(entry!.rows).toHaveLength(1);
    expect(entry!.rows[0]!.text).toBe('Solvency deficit tag');
    // Derived lowercase fields are recomputed on load — never persisted.
    expect(entry!.rows[0]!.textLower).toBeUndefined();
    expect(entry!.rows[0]!.searchText).toBeUndefined();
  });

  it('prunes entries for files that left the scanned roots', async () => {
    saveEvidenceCacheEntry('C:/prep/keep.cmir', 5, [row('kept')]);
    saveEvidenceCacheEntry('C:/prep/gone.cmir', 5, [row('deleted file')]);
    await sleep(20);

    pruneEvidenceCache(new Set(['C:/prep/keep.cmir', 'C:/prep/aff.cmir']));
    await sleep(20);

    const loaded = await loadAllEvidenceCache();
    expect(loaded.has('C:/prep/keep.cmir')).toBe(true);
    expect(loaded.has('C:/prep/gone.cmir')).toBe(false);
  });
});
