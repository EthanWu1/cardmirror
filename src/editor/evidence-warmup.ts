/**
 * Background evidence-index warmup.
 *
 * The persistent index (evidence-cache.ts) makes the SECOND launch fast,
 * but the palette still had to index everything the first time it opened.
 * This kicks the parallel indexer off in the background shortly after boot
 * (desktop only), so by the time the user opens Search Evidence the corpus
 * is already parsed and cached — results in well under a second.
 *
 * Deliberately gentle: waits for the app to settle, runs once per session,
 * and does no UI work (onProgress omitted) — it only populates the caches.
 */

import { getElectronHost } from './host/index.js';
import { settings } from './settings.js';
import { fileFormat, type FileEntry } from './file-search.js';
import { indexEvidenceFiles } from './evidence-index.js';

let warmupStarted = false;

async function collectSearchFiles(
  electron: NonNullable<ReturnType<typeof getElectronHost>>,
): Promise<FileEntry[]> {
  const roots = settings.get('fileSearchRoots');
  if (!roots.length) return [];
  const perRoot = await Promise.all(roots.map((root) => electron.listCmirFiles(root).catch(() => [])));
  const byPath = new Map<string, FileEntry>();
  for (const list of perRoot) {
    for (const entry of list) {
      const format = fileFormat(entry.path);
      if (format !== 'cmir' && format !== 'docx') continue;
      if (byPath.has(entry.path)) continue;
      const name = entry.relPath.split(/[\\/]/).pop() ?? entry.relPath;
      byPath.set(entry.path, {
        path: entry.path,
        relPath: entry.relPath,
        name,
        mtimeMs: entry.mtimeMs,
        ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      });
    }
  }
  return [...byPath.values()];
}

/** Largest corpus we will warm unprompted. This is now a SANITY ceiling
 *  (a pathological tree, not a real evidence library), not a real cap on
 *  useful libraries: the warmup runs in `cacheOnly` mode, so it parses each
 *  file once, streams the rows to the on-disk + in-memory caches, and never
 *  holds the whole corpus in one array. A real ~1,600-file debate library
 *  (which the OLD 600 gate silently skipped entirely, so every session paid
 *  a full cold index — field bug 2026-07-20 "search rarely works") now warms
 *  fully. The persistent cache means this is a once-ever cost per file, not
 *  per launch. */
const WARMUP_MAX_FILES = 20_000;

/** Start the background warmup once. Safe to call unconditionally at boot;
 *  it no-ops on the web edition and after the first call. `delayMs` lets the
 *  app finish its first paint before the indexer competes for the CPU.
 *
 *  Deliberately gentle: a small worker pool (so it never saturates the
 *  machine), `cacheOnly` so it streams to the caches instead of holding the
 *  corpus in memory, and skipped only for a pathologically huge tree. */
export function startEvidenceWarmup(delayMs = 8_000): void {
  if (warmupStarted) return;
  warmupStarted = true;
  const electron = getElectronHost();
  if (!electron) return; // web edition — no local corpus to warm
  setTimeout(() => {
    void (async () => {
      try {
        const files = await collectSearchFiles(electron);
        if (files.length === 0 || files.length > WARMUP_MAX_FILES) return;
        await indexEvidenceFiles({
          files,
          host: electron,
          // Two workers keeps the whole-corpus warm from dragging on for
          // minutes while staying gentle (each worker holds one parsed doc).
          concurrency: 2,
          // Populate the caches for EVERY file without accumulating the
          // whole corpus's rows — later palette opens become cache hits.
          cacheOnly: true,
        });
      } catch {
        /* best-effort — the palette re-indexes on demand if this fails */
      }
    })();
  }, delayMs);
}
