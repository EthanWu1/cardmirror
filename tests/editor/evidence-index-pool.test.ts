// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  indexEvidenceFiles,
  EVIDENCE_DEFAULT_MAX_ROWS,
  __resetEvidenceIndexForTests,
  type EvidenceIndexHost,
} from '../../src/editor/evidence-index.js';
import type { EvidenceSearchRow, FileEntry, OpenableFileFormat } from '../../src/editor/file-search.js';

function row(path: string, text: string): EvidenceSearchRow {
  return {
    kind: 'tag',
    filePath: path,
    relPath: path,
    fileName: path,
    mtimeMs: 10,
    text,
    label: text,
    snippet: text,
    anchor: { quote: text, prefix: '', suffix: '', approxPos: 1 },
    from: 1,
    to: 1 + text.length,
  } as EvidenceSearchRow;
}

function file(path: string): FileEntry {
  return { path, relPath: path, name: path, mtimeMs: 10 };
}

/** jsdom has no Worker, so the pool uses the injected main-thread indexer.
 *  This host returns a one-byte payload; the indexer maps each file to a
 *  fixed row count, exercising pool orchestration deterministically. */
const bytesHost: EvidenceIndexHost = {
  readFileAtPath: async (path: string) => ({ bytes: new Uint8Array([1]), format: 'cmir' as OpenableFileFormat }),
};

function fixedRowsIndexer(perFile: number) {
  return async (entry: FileEntry): Promise<EvidenceSearchRow[]> =>
    Array.from({ length: perFile }, (_unused, i) => row(entry.path, `${entry.path}#${i}`));
}

beforeEach(() => __resetEvidenceIndexForTests());

describe('parallel evidence indexer', () => {
  it('indexes every file across the pool and reports final progress', async () => {
    const files = Array.from({ length: 25 }, (_u, i) => file(`C:/prep/file-${i}.cmir`));
    const progressCalls: number[] = [];
    const result = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 4,
      indexFileOnMain: fixedRowsIndexer(1),
      onProgress: (rows) => progressCalls.push(rows.length),
    });

    expect(result.rows).toHaveLength(25);
    expect(new Set(result.rows.map((r) => r.filePath)).size).toBe(25);
    expect(result.truncated).toBe(false);
    expect(progressCalls.at(-1)).toBe(25);
  });

  it('reuses the cache on a second run (no re-index)', async () => {
    const files = Array.from({ length: 8 }, (_u, i) => file(`C:/warm/file-${i}.cmir`));
    let indexCalls = 0;
    const counting = async (entry: FileEntry): Promise<EvidenceSearchRow[]> => {
      indexCalls++;
      return [row(entry.path, entry.path)];
    };
    await indexEvidenceFiles({ files, host: bytesHost, concurrency: 4, indexFileOnMain: counting });
    expect(indexCalls).toBe(8);

    // Second run: every file is in the in-memory cache now → no parse calls.
    const second = await indexEvidenceFiles({ files, host: bytesHost, concurrency: 4, indexFileOnMain: counting });
    expect(indexCalls).toBe(8);
    expect(second.rows).toHaveLength(8);
  });

  it('stops at the row cap and reports truncation', async () => {
    const files = Array.from({ length: 10 }, (_u, i) => file(`C:/big/file-${i}.cmir`));
    const result = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 2,
      maxTotalRows: 12,
      indexFileOnMain: fixedRowsIndexer(3),
    });
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThanOrEqual(12);
    expect(result.rows.length).toBeLessThan(30);
  });

  it('is bounded even when the caller omits maxTotalRows', async () => {
    // REGRESSION (field crash 2026-07-19): omitting maxTotalRows used to mean
    // Infinity, so the boot warmup accumulated rows until the renderer died.
    // Rows carry full body text — an unbounded run is gigabytes. Row counts
    // here are scaled comfortably past EVIDENCE_DEFAULT_MAX_ROWS (raised
    // 50k -> 200k alongside the slimmer-rows change, 2026-07-20) so the
    // truncation assertion stays meaningful regardless of the cap's value.
    const files = Array.from({ length: 200 }, (_u, i) => file(`C:/unbounded/file-${i}.cmir`));
    const result = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 2,
      indexFileOnMain: fixedRowsIndexer(1200), // 200 x 1200 = 240k rows if unbounded
    });
    expect(result.rows.length).toBeLessThanOrEqual(EVIDENCE_DEFAULT_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it('cacheOnly warms EVERY file past the row cap and returns no rows (boot warmup)', async () => {
    // The boot warmup must populate the cache for the whole corpus even when
    // it is far larger than the in-memory row budget — otherwise the tail of a
    // big library is never pre-indexed and every session pays a cold index
    // ("search rarely works", field 2026-07-20). cacheOnly streams to the
    // caches without accumulating a returned array or stopping at the cap.
    let indexCalls = 0;
    const counting = async (entry: FileEntry): Promise<EvidenceSearchRow[]> => {
      indexCalls++;
      return Array.from({ length: 1000 }, (_u, i) => row(entry.path, `${entry.path}#${i}`));
    };
    const files = Array.from({ length: 300 }, (_u, i) => file(`C:/cacheonly/file-${i}.cmir`));
    const warm = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 2,
      cacheOnly: true,
      indexFileOnMain: counting, // 300 x 1000 = 300k rows, well past the cap
    });
    // Every file was parsed (the row cap did NOT stop the walk), yet nothing
    // is held in the returned array.
    expect(indexCalls).toBe(300);
    expect(warm.rows).toHaveLength(0);
    expect(warm.truncated).toBe(false);
  });

  it('cacheOnly populates the reusable cache so a later search skips re-parsing', async () => {
    let indexCalls = 0;
    const counting = async (entry: FileEntry): Promise<EvidenceSearchRow[]> => {
      indexCalls++;
      return Array.from({ length: 50 }, (_u, i) => row(entry.path, `${entry.path}#${i}`));
    };
    // 100 x 50 = 5,000 rows — comfortably inside the in-memory bound, so the
    // whole warmed set stays cached and the follow-up search is all hits.
    const files = Array.from({ length: 100 }, (_u, i) => file(`C:/reuse/file-${i}.cmir`));
    await indexEvidenceFiles({ files, host: bytesHost, concurrency: 2, cacheOnly: true, indexFileOnMain: counting });
    expect(indexCalls).toBe(100);

    const search = await indexEvidenceFiles({ files, host: bytesHost, concurrency: 2, indexFileOnMain: counting });
    expect(indexCalls).toBe(100); // no re-parse: served from the warm cache
    expect(search.rows).toHaveLength(5000);
  });

  it('never lets a caller raise the bound above the hard default', async () => {
    const files = Array.from({ length: 200 }, (_u, i) => file(`C:/raise/file-${i}.cmir`));
    const result = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 2,
      maxTotalRows: Number.POSITIVE_INFINITY,
      indexFileOnMain: fixedRowsIndexer(1200), // 200 x 1200 = 240k rows if unbounded
    });
    expect(result.rows.length).toBeLessThanOrEqual(EVIDENCE_DEFAULT_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it('bounds the in-memory cache so it cannot grow across a whole library', async () => {
    // REGRESSION (field crash 2026-07-19/20): the per-run row array was
    // bounded, but memCache kept EVERY indexed file's rows for the life of
    // the window — so a big library still filled the heap seconds after
    // opening Search Evidence. Indexing far past the cap must not blow up,
    // and a second pass must still return a bounded result.
    const files = Array.from({ length: 300 }, (_u, i) => file(`C:/memcache/file-${i}.cmir`));
    const first = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 2,
      indexFileOnMain: fixedRowsIndexer(1000), // 300 x 1000 = 300k rows if unbounded
    });
    expect(first.rows.length).toBeLessThanOrEqual(EVIDENCE_DEFAULT_MAX_ROWS);
    expect(first.truncated).toBe(true);

    const second = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 2,
      indexFileOnMain: fixedRowsIndexer(1000),
    });
    expect(second.rows.length).toBeLessThanOrEqual(EVIDENCE_DEFAULT_MAX_ROWS);
  });

  it('aborts promptly when isAborted flips', async () => {
    const files = Array.from({ length: 40 }, (_u, i) => file(`C:/ab/file-${i}.cmir`));
    const result = await indexEvidenceFiles({
      files,
      host: bytesHost,
      concurrency: 4,
      isAborted: () => true, // abort immediately
      indexFileOnMain: fixedRowsIndexer(1),
    });
    expect(result.rows.length).toBe(0);
  });
});
