/**
 * The evidence corpus: every indexable file under the configured search roots.
 *
 * Upstream moved file indexing into a utilityProcess, and its client exposes
 * only ranked queries and mtimes-for-paths — there is deliberately no "hand me
 * the whole corpus" call, because shipping the corpus to the renderer is what
 * that refactor removed. Evidence indexing genuinely does need the full list
 * (it parses inside every file), so it rebuilds one from the host walk and
 * borrows the index service for mtimes, which are the evidence cache's version
 * key. Shared by the boot warmup and the search palette so the two can never
 * disagree about what the corpus is.
 */

import { getElectronHost } from './host/index.js';
import { settings } from './settings.js';
import { fileFormat, makeFileEntry, type FileEntry } from './file-search.js';
import { getFileIndexClient } from './file-search-client.js';

export async function collectSearchFiles(
  electron: NonNullable<ReturnType<typeof getElectronHost>>,
): Promise<FileEntry[]> {
  const roots = settings.get('fileSearchRoots');
  if (!roots.length) return [];
  // Upstream moved the file index into a utilityProcess, and the client
  // deliberately exposes only ranked queries and mtimes-for-paths — there is
  // no "hand me the whole corpus" call any more. Rebuild the listing from the
  // host walk, then ask the index for the mtimes (the cache's version key).
  const perRoot = await Promise.all(
    roots.flatMap((root) =>
      (['cmir', 'docx'] as const).map((ext) =>
        electron
          .listFilesRecursive(root, ext)
          .then((list) => list.map((e) => ({ ...e, root })))
          .catch(() => []),
      ),
    ),
  );

  const byPath = new Map<string, { path: string; relPath: string }>();
  for (const list of perRoot) {
    for (const entry of list) {
      const format = fileFormat(entry.path);
      if (format !== 'cmir' && format !== 'docx') continue;
      if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
    }
  }
  if (byPath.size === 0) return [];

  const mtimes = new Map<string, number>();
  try {
    const client = await getFileIndexClient();
    if (client) {
      const rows = await client.entriesForPaths({
        paths: [...byPath.keys()],
        roots: [...roots],
        exclusions: [],
      });
      for (const row of rows) mtimes.set(row.path, row.mtimeMs);
    }
  } catch {
    /* index service unavailable — fall through with mtime 0 */
  }

  // mtime 0 simply means "no cache hit", so a missing mtime costs a re-parse
  // rather than serving stale rows.
  return [...byPath.values()].map((e) => makeFileEntry(e.path, e.relPath, mtimes.get(e.path) ?? 0));
}
