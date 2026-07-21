import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { RIBBON_GROUPS } from '../../src/editor/ribbon-groups.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
} from '../../src/editor/ribbon-commands.js';

const editorIndexSource = readFileSync('src/editor/index.ts', 'utf8');
const quickCardSearchSource = readFileSync('src/editor/quick-card-search-ui.ts', 'utf8');
const desktopMainSource = readFileSync('apps/desktop/src/main.ts', 'utf8');
const evidenceIndexWorkerPath = 'src/editor/evidence-index-worker.ts';

describe('Search Evidence command', () => {
  it('is a first-class ribbon command with a searchable label and no default shortcut', () => {
    expect(RIBBON_COMMAND_IDS).toContain('openEvidenceSearch');
    expect((RIBBON_COMMAND_LABELS as Record<string, string>).openEvidenceSearch).toBe('Search Evidence');
    expect((DEFAULT_RIBBON_KEYS as Record<string, string | string[]>).openEvidenceSearch).toBe('');
    expect(RIBBON_GROUPS.find((group) => group.title === 'Search')?.commands).toContain(
      'openEvidenceSearch',
    );
  });

  it('opens evidence results through the anchor-aware source route', () => {
    const fnStart = editorIndexSource.indexOf('async function openFileByPathAtDescriptor');
    const fnEnd = editorIndexSource.indexOf('/** Resolve `descriptor`', fnStart);
    const body = editorIndexSource.slice(fnStart, fnEnd);

    expect(body).toContain('showFlashcardSource({ path, name, descriptor }');
    expect(body).not.toContain('openFileByPath(path, name)');
    expect(body).not.toContain('focusDescriptorInActiveView(descriptor, name)');
  });

  it('indexes evidence incrementally instead of blocking on the whole corpus', () => {
    // The palette now delegates to the shared PARALLEL indexer; progress
    // streams rows in as the pool completes files.
    expect(quickCardSearchSource).toContain('indexEvidenceFiles({');
    expect(quickCardSearchSource).toContain('this.evidenceRows = rows;');
    expect(quickCardSearchSource).not.toContain('this.evidenceRows = rows.slice();');
    expect(quickCardSearchSource).toContain('onProgress:');
    expect(quickCardSearchSource).toContain('capResultsForRender(');
  });

  it('queries evidence through the asynchronous cancelable search path', () => {
    expect(quickCardSearchSource).toContain('searchEvidenceRowsAsync');
    expect(quickCardSearchSource).toContain('evidenceSearchToken');
    expect(quickCardSearchSource).toContain('AbortController');
  });

  it('indexes evidence in a worker so parsing large docs cannot freeze the palette', () => {
    expect(existsSync(evidenceIndexWorkerPath)).toBe(true);
    const workerSource = readFileSync(evidenceIndexWorkerPath, 'utf8');
    const indexerSource = readFileSync('src/editor/evidence-index.ts', 'utf8');

    // The worker MUST be built through the Vite `?worker` loader as a CLASSIC
    // (iife) worker: the packaged Electron renderer runs on file://, which
    // refuses module workers outright (field bug 2026-07-19).
    const loaderSource = readFileSync('src/editor/evidence-index-worker-loader.ts', 'utf8');
    const viteConfig = readFileSync('vite.config.ts', 'utf8');
    expect(loaderSource).toContain("from './evidence-index-worker.ts?worker'");
    expect(viteConfig).toContain("worker: { format: 'iife' }");
    expect(indexerSource).toContain('createEvidenceIndexWorker()');
    expect(workerSource).toContain('fromDocx');
    expect(workerSource).toContain('parseNative');
    expect(workerSource).toContain('extractEvidenceRows');
  });

  it('indexes with a PARALLEL worker pool, not one serial worker with sleeps', () => {
    const indexerSource = readFileSync('src/editor/evidence-index.ts', 'utf8');
    // A pool of workers (one per core, capped) instead of a single worker.
    expect(indexerSource).toContain('function poolSize()');
    expect(indexerSource).toContain('navigator.hardwareConcurrency');
    expect(indexerSource).toContain('Promise.all(');
    // The old serial loop slept 40 ms between every file — that throttle,
    // not the parse, was the "never finishes" cost. It must be gone.
    expect(quickCardSearchSource).not.toContain('await idleYield(EVIDENCE_READ_IDLE_MS);');
  });

  it('warms the evidence index in the background at boot so the palette opens hot', () => {
    const warmupSource = readFileSync('src/editor/evidence-warmup.ts', 'utf8');
    expect(warmupSource).toContain('export function startEvidenceWarmup');
    expect(warmupSource).toContain('indexEvidenceFiles(');
    expect(editorIndexSource).toContain('startEvidenceWarmup()');
  });

  it('keeps the boot warmup gentle while warming the WHOLE corpus (cacheOnly)', () => {
    // REGRESSION (field crash 2026-07-19): the warmup once ran unprompted over
    // the whole corpus with no bound and the full worker pool, crashing boot.
    // The 600-file gate that fixed that then SILENTLY SKIPPED real ~1,600-file
    // libraries entirely, so every session paid a full cold index ("search
    // rarely works", field 2026-07-20). It now warms the whole corpus in
    // cacheOnly mode (streams to the caches, holds nothing) with a small pool
    // and only a sanity ceiling on pathological trees.
    const warmupSource = readFileSync('src/editor/evidence-warmup.ts', 'utf8');
    expect(warmupSource).toContain('WARMUP_MAX_FILES');
    expect(warmupSource).toContain('files.length > WARMUP_MAX_FILES) return;');
    // cacheOnly so it doesn't accumulate the corpus in memory, and a small
    // (not single, not full) worker pool so a big library warms in reasonable
    // time without saturating the machine.
    expect(warmupSource).toContain('cacheOnly: true');
    expect(warmupSource).toContain('concurrency: 2');
    // The old per-run row cap no longer gates the warmup (cacheOnly streams
    // every file straight to the caches).
    expect(warmupSource).not.toContain('WARMUP_MAX_ROWS');
  });

  it('throttles cold-scan partial broadcasts by time and count, not per-file', () => {
    // REGRESSION: a count-based trigger copied + IPC-serialized the whole
    // growing listing every 200 files — O(n^2) bytes, and the renderer
    // re-merged and re-searched on each one.
    expect(desktopMainSource).toContain('PARTIAL_INTERVAL_MS');
    expect(desktopMainSource).toContain('MAX_PARTIALS');
    expect(desktopMainSource).toContain('partialsSent >= MAX_PARTIALS');
    expect(desktopMainSource).not.toContain('out.length - lastPartialCount >= 200');
  });

  it('bounds per-file reads and worker parses so one bad file cannot wedge indexing', () => {
    const indexerSource = readFileSync('src/editor/evidence-index.ts', 'utf8');
    expect(indexerSource).toContain('EVIDENCE_FILE_READ_TIMEOUT_MS');
    expect(indexerSource).toContain('EVIDENCE_INDEX_TIMEOUT_MS');
    // A timed-out worker is replaced (terminated + nulled), not reused.
    expect(indexerSource).toContain('workers[slot]?.terminate()');
  });

  it('hydrates the persistent evidence index so relaunches skip unchanged files', () => {
    const indexerSource = readFileSync('src/editor/evidence-index.ts', 'utf8');
    expect(indexerSource).toContain('hydrateEvidenceCache(');
    expect(indexerSource).toContain('saveEvidenceCacheEntry(entry.path, entry.mtimeMs, extracted)');
  });

  it('bounds evidence memory so huge libraries degrade instead of crashing', () => {
    const indexerSource = readFileSync('src/editor/evidence-index.ts', 'utf8');
    expect(quickCardSearchSource).toContain('EVIDENCE_MAX_TOTAL_ROWS');
    expect(indexerSource).toContain('EVIDENCE_MAX_FILE_BYTES');
    expect(indexerSource).toContain('entry.size > EVIDENCE_MAX_FILE_BYTES');
    // Persistent-cache hydration walks a cursor filtered to live paths — a
    // wholesale getAll() of a big stale store was an OOM vector.
    const evidenceCacheSource = readFileSync('src/editor/evidence-cache.ts', 'utf8');
    expect(evidenceCacheSource).toContain('.openCursor()');
    expect(evidenceCacheSource).not.toContain('.getAll()');
  });

  it('does not block the renderer on a cold recursive file-index scan', () => {
    const handlerStart = desktopMainSource.indexOf("ipcMain.handle('host:list-cmir-files'");
    const handlerEnd = desktopMainSource.indexOf("ipcMain.handle('host:write-file-at-path'", handlerStart);
    const handler = desktopMainSource.slice(handlerStart, handlerEnd);

    expect(handler).toContain('revalidateCmirIndex(root);');
    expect(handler).toContain('return [];');
    expect(handler).not.toContain('await scanCmirFiles(root)');
  });
});
