/**
 * Persistent per-file evidence-row cache for Search Evidence.
 *
 * The in-memory warm cache dies with the window, so every launch used to
 * re-read and re-parse the ENTIRE evidence corpus before search results
 * settled — minutes on a big Dropbox tree, felt as "search never finishes".
 * Extracted rows are plain structured-clone-safe data keyed by absolute
 * path + mtime, so IndexedDB can carry them across launches: on the first
 * palette open we bulk-load every entry, unchanged files become instant
 * cache hits, and only genuinely new/edited files hit the parser.
 *
 * Derived lowercase search fields (`textLower`, `searchText`) are stripped
 * before persisting — they are recomputed cheaply on load and would roughly
 * double the stored size.
 */

import type { EvidenceSearchRow } from './file-search.js';

const DB_NAME = 'cardmirror-evidence-index';
const DB_VERSION = 1;
const STORE = 'files';

export interface PersistedEvidenceEntry {
  /** Key: the file's absolute path. */
  path: string;
  mtimeMs: number;
  rows: EvidenceSearchRow[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return (dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // storage denied — cache degrades to per-session
    } catch {
      resolve(null);
    }
  }));
}

function stripDerived(rows: EvidenceSearchRow[]): EvidenceSearchRow[] {
  return rows.map((row) => {
    const { textLower: _textLower, searchText: _searchText, ...rest } = row;
    return rest;
  });
}

/** Persisted entries, keyed by path. When `livePaths` is given only those
 *  entries are materialized — a cursor walk, so a huge stale corpus never
 *  gets loaded into renderer memory wholesale (that wholesale `getAll` was
 *  an OOM-crash vector on big libraries). Resolves empty when the store is
 *  unavailable (denied storage, very old runtime). */
export function loadAllEvidenceCache(
  livePaths?: ReadonlySet<string>,
  /** Stop the walk once this many rows have been materialized. Without a
   *  bound, hydrating a large library's persisted index pulled gigabytes
   *  into the renderer and crashed it (field bug 2026-07-19). Callers pass
   *  `MEM_CACHE_MAX_ROWS` explicitly; kept in sync here as the fallback. */
  maxRows = 200_000,
): Promise<Map<string, PersistedEvidenceEntry>> {
  return openDb().then((db) => {
    if (!db) return new Map<string, PersistedEvidenceEntry>();
    return new Promise<Map<string, PersistedEvidenceEntry>>((resolve) => {
      try {
        const out = new Map<string, PersistedEvidenceEntry>();
        let loadedRows = 0;
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(out);
            return;
          }
          const raw = cursor.value as PersistedEvidenceEntry;
          if (
            raw &&
            typeof raw.path === 'string' &&
            Array.isArray(raw.rows) &&
            (!livePaths || livePaths.has(raw.path))
          ) {
            out.set(raw.path, raw);
            loadedRows += raw.rows.length;
            if (loadedRows >= maxRows) {
              resolve(out); // budget spent — the rest indexes on demand
              return;
            }
          }
          cursor.continue();
        };
        req.onerror = () => resolve(out);
      } catch {
        resolve(new Map());
      }
    });
  });
}

/** Fire-and-forget upsert after (re)indexing one file. */
export function saveEvidenceCacheEntry(
  path: string,
  mtimeMs: number,
  rows: EvidenceSearchRow[],
): void {
  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ path, mtimeMs, rows: stripDerived(rows) });
    } catch {
      /* quota / clone failure — cache degrades, search still works */
    }
  });
}

/** Drop entries for files that no longer exist in the scanned roots, so a
 *  reorganized Dropbox doesn't grow the store forever. Fire-and-forget. */
export function pruneEvidenceCache(livePaths: ReadonlySet<string>): void {
  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result ?? []) {
          if (typeof key === 'string' && !livePaths.has(key)) store.delete(key);
        }
      };
    } catch {
      /* best-effort */
    }
  });
}
