/**
 * Parallel evidence indexer — shared by the search palette and the
 * background boot warmup.
 *
 * Why this exists: the palette used to index the corpus SERIALLY — read
 * one file, hand it to a single worker, await it, sleep 40 ms, repeat.
 * On a real library that is minutes ("Search Evidence never finishes",
 * field 2026-07-19). This module instead:
 *   - runs a POOL of workers (one per core, capped) so N files parse at
 *     once, off the main thread;
 *   - reads file bytes concurrently (the read, not the parse, is the
 *     cost on cloud-placeholder files);
 *   - hits the in-memory + persistent caches first, so a warm library is
 *     effectively free;
 *   - streams rows back as they arrive for progressive display.
 *
 * The persistent cache (evidence-cache.ts) plus the boot warmup mean the
 * palette usually opens with everything already indexed.
 */

import {
  evidenceSearchText,
  type EvidenceSearchRow,
  type FileEntry,
  type OpenableFileFormat,
} from './file-search.js';
import { createEvidenceIndexWorker } from './evidence-index-worker-loader.js';
import {
  loadAllEvidenceCache,
  pruneEvidenceCache,
  saveEvidenceCacheEntry,
} from './evidence-cache.js';

interface EvidenceIndexRequest {
  type: 'index-evidence-file';
  jobId: number;
  entry: FileEntry;
  bytes: Uint8Array;
  format: OpenableFileFormat;
}

interface EvidenceIndexSuccess {
  type: 'evidence-file-indexed';
  jobId: number;
  rows: EvidenceSearchRow[];
}

interface EvidenceIndexFailure {
  type: 'evidence-file-error';
  jobId: number;
  message: string;
}

type EvidenceIndexResponse = EvidenceIndexSuccess | EvidenceIndexFailure;

/** In-memory rows keyed by path, version-stamped by mtime. Shared across
 *  the palette and the warmup so neither re-parses the other's work. */
interface WarmEntry {
  mtimeMs: number;
  rows: EvidenceSearchRow[];
}
const memCache = new Map<string, WarmEntry>();
/** Running count of rows held in `memCache`. The cache is the SECOND place
 *  rows accumulate (the per-run array is the first), and it persists for the
 *  life of the window — leaving it unbounded meant a big library filled the
 *  renderer's heap and crashed it seconds after opening Search Evidence
 *  (field bug 2026-07-19). Raised 50,000 -> 200,000 alongside the slimmer-rows
 *  change (2026-07-20): that cut roughly 4x off the average row's retained
 *  bytes (dropped eager textLower/searchText/snippet duplicates, capped
 *  anchor.quote), so the SAME ~500-600 MB ceiling now holds ~4x more rows —
 *  this raises the cap to actually spend that headroom on corpus coverage
 *  instead of leaving it unused ("doesn't go through everything", field
 *  2026-07-20). Row size shrank; row COUNT cap hadn't moved until now. */
let memCacheRows = 0;
const MEM_CACHE_MAX_ROWS = 200_000;

function rememberRows(path: string, mtimeMs: number, rows: EvidenceSearchRow[]): void {
  const existing = memCache.get(path);
  if (existing) memCacheRows -= existing.rows.length;
  // Past the budget, keep serving what we have rather than growing: the
  // uncached files still index on demand, just without a warm hit.
  if (memCacheRows + rows.length > MEM_CACHE_MAX_ROWS) {
    if (existing) memCache.delete(path);
    return;
  }
  memCache.set(path, { mtimeMs, rows });
  memCacheRows += rows.length;
}

let cacheHydrated: Promise<void> | null = null;
/** Load the persistent index into the in-memory cache once. Bounded both to
 *  `livePaths` and to a row budget, so a huge stale store can never balloon
 *  renderer memory. */
export function hydrateEvidenceCache(livePaths: ReadonlySet<string>): Promise<void> {
  return (cacheHydrated ??= loadAllEvidenceCache(livePaths, MEM_CACHE_MAX_ROWS)
    .then((persisted) => {
      for (const entry of persisted.values()) {
        if (memCacheRows >= MEM_CACHE_MAX_ROWS) break;
        if (!memCache.has(entry.path)) rememberRows(entry.path, entry.mtimeMs, entry.rows);
      }
    })
    .catch(() => {}));
}

export function cachedEvidenceRows(path: string, mtimeMs: number): EvidenceSearchRow[] | null {
  const hit = memCache.get(path);
  if (!hit || hit.mtimeMs !== mtimeMs) return null;
  for (const row of hit.rows) row.searchText ??= evidenceSearchText(row);
  return hit.rows;
}

/** Test-only: drop the in-memory cache and the hydration memo so each test
 *  starts from a clean slate (the memo is process-global by design). */
export function __resetEvidenceIndexForTests(): void {
  memCache.clear();
  memCacheRows = 0;
  cacheHydrated = null;
}

// ── Timeouts / caps (mirrored from the palette's earlier constants) ──
export const EVIDENCE_FILE_READ_TIMEOUT_MS = 20_000;
export const EVIDENCE_INDEX_TIMEOUT_MS = 30_000;
/** Per-file byte cap. A docx expands to many times its on-disk size once
 *  parsed into a ProseMirror doc, so this bounds the PEAK of a single parse,
 *  not just the read. Real debate files sit well under this. */
export const EVIDENCE_MAX_FILE_BYTES = 24 * 1024 * 1024;
/** Hard default row bound. EVERY textblock becomes a row — including full
 *  card bodies, which carry `text` + a bounded anchor, so a row averages
 *  roughly 2-3 KB post-slimming (was ~11 KB before dropping the eager
 *  textLower/searchText/snippet duplicates and capping anchor.quote,
 *  2026-07-20). An unbounded run therefore still grows into gigabytes and
 *  takes the renderer down: omitting `maxTotalRows` used to mean Infinity,
 *  which is exactly how the boot warmup crashed the app (field bug
 *  2026-07-19). Raised 50,000 -> 200,000 to match the slimmer rows — same
 *  memory ceiling, ~4x more of the corpus actually indexed. Callers may
 *  lower this, never raise it past this ceiling. */
export const EVIDENCE_DEFAULT_MAX_ROWS = 200_000;
const TIMEOUT_ERROR = 'evidence-index-timeout';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMEOUT_ERROR)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** How many workers to run: one per core, minus one for the main thread,
 *  capped low. Each in-flight worker holds a fully parsed document, so the
 *  cap bounds PEAK memory as much as it bounds CPU. */
function poolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(cores - 1, 3));
}

function cloneTransferableBytes(bytes: Uint8Array): Uint8Array {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint8Array(buffer);
}

/** One RPC round-trip to a worker. A worker handles one job at a time; the
 *  pool loop below never dispatches two jobs to the same worker at once. */
let jobCounter = 0;
function indexInWorker(
  worker: Worker,
  entry: FileEntry,
  bytes: Uint8Array,
  format: OpenableFileFormat,
): Promise<EvidenceSearchRow[]> {
  const jobId = ++jobCounter;
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };
    const onMessage = (event: MessageEvent<EvidenceIndexResponse>): void => {
      const response = event.data;
      if (!response || response.jobId !== jobId) return;
      cleanup();
      if (response.type === 'evidence-file-indexed') resolve(response.rows);
      else reject(new Error(response.message || 'Could not index evidence file.'));
    };
    const onError = (event: ErrorEvent): void => {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    };
    const onMessageError = (): void => {
      cleanup();
      reject(new Error('Could not transfer evidence file to the index worker.'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    const transfer = cloneTransferableBytes(bytes);
    const request: EvidenceIndexRequest = { type: 'index-evidence-file', jobId, entry, bytes: transfer, format };
    worker.postMessage(request, [transfer.buffer]);
  });
}

export interface EvidenceIndexHost {
  readFileAtPath(path: string): Promise<{ bytes: Uint8Array; format: OpenableFileFormat } | null>;
}

export interface EvidenceIndexOptions {
  files: readonly FileEntry[];
  host: EvidenceIndexHost;
  /** Aborts the run when it flips true (palette closed / re-scan). */
  isAborted?: () => boolean;
  /** Called as batches of rows arrive, with running progress. */
  onProgress?: (rows: EvidenceSearchRow[], done: number, total: number) => void;
  /** Stop indexing past this many rows (memory bound). */
  maxTotalRows?: number;
  /** Cache-population run (the boot warmup): parse + persist EVERY file to
   *  the on-disk + in-memory caches, but don't accumulate a returned row
   *  array and don't stop at the row cap. This lets the warmup walk the
   *  whole corpus gently so later palette opens are cache hits, without
   *  holding the entire corpus's rows in one array. The returned
   *  `rows` is left empty; callers that need rows must omit this. */
  cacheOnly?: boolean;
  /** Cap the pool (tests pass 1 for determinism). */
  concurrency?: number;
  /** Main-thread indexer used when Web Workers are unavailable (jsdom /
   *  tests, and as a defensive fallback). In production Electron the worker
   *  pool is used and this is never called. Returning null skips the file. */
  indexFileOnMain?: (
    entry: FileEntry,
    bytes: Uint8Array,
    format: OpenableFileFormat,
  ) => Promise<EvidenceSearchRow[] | null>;
}

export interface EvidenceIndexResult {
  rows: EvidenceSearchRow[];
  truncated: boolean;
}

/** Index `files` into evidence rows using a worker pool, honoring the
 *  caches. Resolves with the full row set (also delivered incrementally
 *  via onProgress). Safe to run from the palette or the boot warmup. */
export async function indexEvidenceFiles(opts: EvidenceIndexOptions): Promise<EvidenceIndexResult> {
  const { files, host } = opts;
  const isAborted = opts.isAborted ?? (() => false);
  const cacheOnly = opts.cacheOnly ?? false;
  // Never unbounded — see EVIDENCE_DEFAULT_MAX_ROWS. In cacheOnly mode the
  // returned array stays empty, so the row cap doesn't gate the walk — the
  // in-memory cache (rememberRows) enforces its own MEM_CACHE_MAX_ROWS bound.
  const maxRows = Math.min(opts.maxTotalRows ?? EVIDENCE_DEFAULT_MAX_ROWS, EVIDENCE_DEFAULT_MAX_ROWS);
  const total = files.length;

  await hydrateEvidenceCache(new Set(files.map((f) => f.path)));
  if (isAborted()) return { rows: [], truncated: false };

  const rows: EvidenceSearchRow[] = [];
  let done = 0;
  let truncated = false;
  let sinceProgress = 0;
  /** Append up to the remaining row budget. Checking the cap only BETWEEN
   *  files would let one pathological file blow past it by its own row count,
   *  so the clip happens here — the cap is a hard bound, not a checkpoint. */
  const pushBounded = (source: readonly EvidenceSearchRow[]): void => {
    const room = maxRows - rows.length;
    if (room <= 0) {
      truncated = true;
      return;
    }
    if (source.length > room) {
      for (let i = 0; i < room; i++) rows.push(source[i]!);
      truncated = true;
      return;
    }
    for (const row of source) rows.push(row);
  };
  const reportMaybe = (force = false): void => {
    if (!opts.onProgress) return;
    sinceProgress++;
    if (force || sinceProgress >= 8) {
      sinceProgress = 0;
      opts.onProgress(rows, done, total);
    }
  };

  // Workers are created lazily and reused across the whole run; a wedged
  // worker (timeout) is replaced so the next file doesn't inherit the jam.
  // Where Workers are unavailable (jsdom/tests), fall back to the injected
  // main-thread indexer.
  const workersAvailable = typeof Worker !== 'undefined';
  const workerCount = Math.max(1, opts.concurrency ?? poolSize());
  const workers: (Worker | null)[] = new Array(workerCount).fill(null);
  const workerFor = (slot: number): Worker | null => {
    if (!workersAvailable) return null;
    if (workers[slot]) return workers[slot];
    try {
      workers[slot] = createEvidenceIndexWorker();
    } catch {
      workers[slot] = null;
    }
    return workers[slot];
  };

  let cursor = 0;
  const runSlot = async (slot: number): Promise<void> => {
    for (;;) {
      // The row cap stops a normal run once the searchable set is full; a
      // cacheOnly warmup keeps going (it accumulates nothing) so the whole
      // corpus reaches the persistent cache.
      if (isAborted() || (!cacheOnly && rows.length >= maxRows)) {
        if (!cacheOnly && rows.length >= maxRows) truncated = true;
        return;
      }
      const index = cursor++;
      if (index >= files.length) return;
      const entry = files[index]!;
      done++;

      const cached = cachedEvidenceRows(entry.path, entry.mtimeMs);
      if (cached) {
        if (!cacheOnly) pushBounded(cached);
        reportMaybe();
        continue;
      }
      if (typeof entry.size === 'number' && entry.size > EVIDENCE_MAX_FILE_BYTES) {
        reportMaybe();
        continue;
      }
      const worker = workerFor(slot);
      if (!worker && !opts.indexFileOnMain) {
        reportMaybe();
        continue; // no worker and no fallback — nothing can parse this file
      }
      try {
        const file = await withTimeout(host.readFileAtPath(entry.path), EVIDENCE_FILE_READ_TIMEOUT_MS);
        if (!file) {
          reportMaybe();
          continue;
        }
        if (isAborted()) return;
        const extracted = worker
          ? await withTimeout(
              indexInWorker(worker, entry, file.bytes, file.format),
              EVIDENCE_INDEX_TIMEOUT_MS,
            )
          : ((await opts.indexFileOnMain!(entry, file.bytes, file.format)) ?? []);
        rememberRows(entry.path, entry.mtimeMs, extracted);
        saveEvidenceCacheEntry(entry.path, entry.mtimeMs, extracted);
        if (!cacheOnly) pushBounded(extracted);
        reportMaybe();
      } catch (err) {
        if (err instanceof Error && err.message === TIMEOUT_ERROR) {
          workers[slot]?.terminate();
          workers[slot] = null; // replaced on next workerFor()
        }
        reportMaybe();
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, (_unused, slot) => runSlot(slot)));

  for (const w of workers) w?.terminate();
  if (opts.onProgress) opts.onProgress(rows, done, total);
  if (!isAborted() && files.length > 0) pruneEvidenceCache(new Set(files.map((f) => f.path)));
  return { rows, truncated };
}
