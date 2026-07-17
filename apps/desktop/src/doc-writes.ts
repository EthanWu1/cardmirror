/**
 * Document write pipeline — the hardened disk layer under every save.
 *
 * All four document-writing IPC handlers (`host:save-existing`,
 * `host:save-as`, `host:save-send-doc`, `host:write-file-at-path`)
 * route through here, which adds three protections a bare
 * `fs.writeFile` lacks:
 *
 *  1. EXISTENCE CHECK (in-place saves only): a save to a path whose
 *     file was renamed or deleted in Finder/Explorer used to silently
 *     recreate the file at the stale path — forking the document.
 *     `saveExistingDoc` stats first, so the miss surfaces as ENOENT
 *     and the renderer's "file location not found → Save As" rescue
 *     flow takes over.
 *
 *  2. CHANGED-ON-DISK GUARD (in-place saves only): we remember each
 *     document's on-disk mtime+size after every read and write. If the
 *     file changed underneath us — another machine editing through a
 *     synced Dropbox folder is the field case; Dropbox will NOT mint a
 *     "conflicted copy" when the remote version already synced down
 *     before our write — the save is refused with an EMODIFIED-marked
 *     error so the renderer can ask overwrite / Save As / cancel.
 *     Unknown paths (nothing recorded) skip the check: a doc restored
 *     from a journal after a restart behaves exactly as before.
 *
 *  3. ATOMIC WRITES + PER-PATH SERIALIZATION (all doc writes): bytes
 *     stage into a hidden sibling `.cmtmp` file, then rename over the
 *     real path — a crash mid-write can never leave a half-written
 *     document (same pattern as the crash-recovery journals). Writes
 *     to the same path chain onto each other, so a manual ⌘S landing
 *     while an autosave write is still in flight can't interleave
 *     (see the kernel-race note above `host:write-journal` in main.ts).
 *
 * The state map is keyed by resolved path and shared across windows —
 * which matches the cross-window duplicate-open guard's invariant that
 * a document is open in at most one window. It deliberately tracks
 * "what CardMirror last saw on disk", not per-editing-session identity:
 * an in-app write to a path (send-doc export, bulk convert) refreshes
 * the entry, so only writes by OTHER programs trip the guard.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Marker embedded in the changed-on-disk error MESSAGE — the renderer
 *  classifies IPC failures by message text (Electron only preserves the
 *  message across the IPC boundary), same as its existing ENOENT check.
 *  Mirrored by `isFileChangedOnDiskError` in src/editor/error-surface.ts. */
export const CHANGED_ON_DISK_MARKER = 'EMODIFIED';

interface DiskState {
  mtimeMs: number;
  size: number;
}

export interface SaveExistingOptions {
  force?: boolean;
  conflictCopiesForDocx?: boolean;
}

export type SaveExistingResult =
  | { status: 'saved' }
  | {
      status: 'conflict';
      reason: 'changed';
      conflictPath: string;
      conflictName: string;
    };

/** Last-seen on-disk identity per resolved path. Populated by
 *  `recordDiskStateFromDisk` (after document reads) and by the two
 *  writers below (after their writes). Entries are refreshed on every
 *  read, so going stale is harmless — the next open overwrites them. */
const knownDiskState = new Map<string, DiskState>();

/** Per-path write tails — same serialization pattern as main.ts's
 *  `journalWriteTails`, for the same reason: two overlapping writes to
 *  one path interleave at the kernel level into a torn file. */
const writeTails = new Map<string, Promise<void>>();

function keyFor(filePath: string): string {
  return path.resolve(filePath);
}

function isDocxPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.docx';
}

function isReplaceDeniedError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function isTransientCloudLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

const CLOUD_LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000, 5000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function conflictTimestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-') + ' ' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('-');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw err;
  }
}

async function uniqueConflictPath(filePath: string): Promise<string> {
  const parsed = path.parse(filePath);
  const stamp = conflictTimestamp();
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? '' : ` ${i + 1}`;
    const candidate = path.join(
      parsed.dir,
      `${parsed.name} (CardMirror conflicted copy ${stamp}${suffix})${parsed.ext}`,
    );
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free conflicted-copy name for "${path.basename(filePath)}".`);
}

async function writeDocxConflictCopy(
  filePath: string,
  buf: Buffer,
  reason: 'changed',
): Promise<SaveExistingResult> {
  const conflictPath = await uniqueConflictPath(filePath);
  await writeAtomic(conflictPath, buf);
  await recordDiskStateFromDisk(conflictPath);
  return {
    status: 'conflict',
    reason,
    conflictPath,
    conflictName: path.basename(conflictPath),
  };
}

async function fallbackOverwriteExisting(
  tmpPath: string,
  filePath: string,
  buf: Buffer,
  mode?: number,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= CLOUD_LOCK_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await delay(CLOUD_LOCK_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      await fs.copyFile(tmpPath, filePath);
      return;
    } catch (err) {
      if (!isTransientCloudLockError(err)) throw err;
      lastErr = err;
    }
    try {
      await fs.writeFile(filePath, buf, mode !== undefined ? { mode } : {});
      return;
    } catch (err) {
      if (!isTransientCloudLockError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Chain `task` onto the previous write to the same path. Returns the
 *  task's own promise (rejections propagate to THIS caller); the stored
 *  tail always settles fulfilled so one failed write can't dam the
 *  queue for the session. */
export function chainDocWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = keyFor(filePath);
  const previous = writeTails.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeTails.set(key, tail);
  // GC the chain entry when this write settles — only if we're still
  // the tail (a later write may have chained onto us already).
  void tail.then(() => {
    if (writeTails.get(key) === tail) writeTails.delete(key);
  });
  return run;
}

/** Remember `filePath`'s current on-disk mtime+size. Best-effort: a
 *  stat failure (file vanished between read and stat) just leaves no
 *  entry, which disables the changed-on-disk guard for that path —
 *  never breaks the read that called us. */
export async function recordDiskStateFromDisk(filePath: string): Promise<void> {
  try {
    const st = await fs.stat(filePath);
    knownDiskState.set(keyFor(filePath), { mtimeMs: st.mtimeMs, size: st.size });
  } catch {
    /* best-effort */
  }
}

/** Stage-then-rename write. The tmp file is dot-prefixed (hidden in
 *  Finder) and lives in the target's own directory so the rename stays
 *  on one filesystem (atomic on POSIX; MoveFileEx-replace on Windows).
 *  If a sync provider/Windows denies the final replace, fall back to
 *  copying the fully written tmp file over the existing file. That path
 *  is not atomic, so it only runs after the atomic replace was refused.
 *  On failure the tmp file is cleaned up best-effort and the error
 *  propagates. */
async function writeAtomic(
  filePath: string,
  buf: Buffer,
  mode?: number,
  opts: { fallbackOnReplaceDenied?: boolean } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.cmtmp`);
  await fs.writeFile(tmpPath, buf, mode !== undefined ? { mode } : {});
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (isReplaceDeniedError(err) && opts.fallbackOnReplaceDenied !== false) {
      try {
        // Preserve the "existing file must still exist" invariant from
        // saveExistingDoc when a provider refuses atomic replacement.
        await fs.stat(filePath);
        await fallbackOverwriteExisting(tmpPath, filePath, buf, mode);
        if (mode !== undefined) await fs.chmod(filePath, mode).catch(() => {});
        await fs.unlink(tmpPath).catch(() => {});
        return;
      } catch (fallbackErr) {
        await fs.unlink(tmpPath).catch(() => {});
        throw fallbackErr;
      }
    }
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** In-place save to a file that must already exist on disk.
 *
 *  Throws ENOENT (from the stat) when the file was renamed/deleted —
 *  the renderer's `isFileGoneError` → Save-As rescue path. Throws an
 *  EMODIFIED-marked error when the file changed on disk since we last
 *  read or wrote it, unless `opts.force` (the renderer's explicit
 *  "Overwrite" choice) is set. */
export function saveExistingDoc(
  filePath: string,
  buf: Buffer,
  opts?: SaveExistingOptions,
): Promise<SaveExistingResult> {
  return chainDocWrite(filePath, async () => {
    // Existence check — a bare writeFile would silently recreate a
    // renamed/deleted file at the stale path.
    const st = await fs.stat(filePath);
    const canCreateDocxConflict = opts?.conflictCopiesForDocx === true && isDocxPath(filePath);
    const known = knownDiskState.get(keyFor(filePath));
    if (
      !opts?.force &&
      known &&
      (known.mtimeMs !== st.mtimeMs || known.size !== st.size)
    ) {
      if (canCreateDocxConflict) {
        return writeDocxConflictCopy(filePath, buf, 'changed');
      }
      throw new Error(
        `${CHANGED_ON_DISK_MARKER}: "${path.basename(filePath)}" changed on disk ` +
          `after CardMirror last read or wrote it — another program, device, or ` +
          `sync service may have written it.`,
      );
    }
    // Preserve the existing file's permission bits across the
    // tmp+rename (a plain in-place write would have kept them).
    try {
      await writeAtomic(filePath, buf, st.mode & 0o777);
    } catch (err) {
      throw err;
    }
    await recordDiskStateFromDisk(filePath);
    return { status: 'saved' };
  });
}

/** Write a document to a path that need not exist yet (Save As, the
 *  silent send-doc/marked-cards exports, bulk convert). No freshness
 *  guard — the user just picked the destination — but the write is
 *  still atomic, serialized, and recorded so a follow-up in-place save
 *  to the same path starts with a fresh baseline. */
export function saveNewDoc(
  filePath: string,
  buf: Buffer,
  opts?: { mkdir?: boolean },
): Promise<void> {
  return chainDocWrite(filePath, async () => {
    if (opts?.mkdir) await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomic(filePath, buf);
    await recordDiskStateFromDisk(filePath);
  });
}

/** The deepest existing DIRECTORY on `fromPath`'s ancestor chain —
 *  `fromPath`'s own folder when the path is intact, or the nearest
 *  surviving parent after a rename/move/delete broke some segment.
 *  Used to open the Save-As dialog next to wherever the document's
 *  old location went (Word does the same on a stale-path save).
 *  Null only if nothing on the chain exists (unmounted volume). */
export async function nearestExistingDir(fromPath: string): Promise<string | null> {
  let dir = path.resolve(fromPath);
  for (;;) {
    try {
      // isDirectory guard: an existing FILE on the chain (fromPath
      // itself, or a file squatting on an ancestor name) is not a
      // place a save dialog can open.
      if ((await fs.stat(dir)).isDirectory()) return dir;
    } catch {
      /* segment gone — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

/** Test seam — clears both maps so vitest cases start cold. */
export function resetDocWritesForTests(): void {
  knownDiskState.clear();
  writeTails.clear();
}
