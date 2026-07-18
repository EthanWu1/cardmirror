/**
 * Per-document autosave preference store.
 *
 * Remembers which saved files the user has explicitly changed autosave for,
 * keyed by absolute path, so the autosave toggle survives closing and
 * reopening a doc. Persisted to `localStorage` (survives restarts;
 * shared across same-session Electron windows).
 *
 * This is distinct from the live `autosaveEnabled` setting, which stays
 * transient/per-window (see `TRANSIENT_SETTING_KEYS` in settings.ts):
 * the setting drives the current window's behavior, and opening a known
 * doc restores its remembered state from here. Only Electron docs have
 * a stable string path; web `FileSystemFileHandle`s aren't serializable,
 * so web docs never match (autosave stays its default-off).
 *
 * `.cmir` files default ON, so this store needs both an explicit-on set
 * (legacy docs / non-default paths) and an explicit-off set (the user turned
 * autosave off for a `.cmir` file and expects that to stick).
 */

const STORAGE_KEY = 'pmd-autosave-paths';
const DISABLED_STORAGE_KEY = 'pmd-autosave-disabled-paths';

function read(key = STORAGE_KEY): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return new Set();
  }
}

function write(paths: Set<string>, key = STORAGE_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify([...paths]));
  } catch {
    // Storage disabled / quota — the live `autosaveEnabled` setting
    // still drives this window; we just lose cross-restart persistence.
  }
}

/** Whether autosave should be ON for the file at `path`. False for
 *  a non-string path (unsaved / web handle). `defaultOn` is used for
 *  saved `.cmir` files, unless the user explicitly disabled autosave for
 *  that path. */
export function isAutosaveOnForPath(path: unknown, defaultOn = false): boolean {
  if (typeof path !== 'string' || !path) return false;
  if (read(DISABLED_STORAGE_KEY).has(path)) return false;
  if (read(STORAGE_KEY).has(path)) return true;
  return defaultOn;
}

/** Remember the autosave toggle state for the file at `path`. No-op for
 *  a non-string path (unsaved docs / web — nothing stable to key on). */
export function setAutosaveForPath(path: unknown, on: boolean): void {
  if (typeof path !== 'string' || !path) return;
  const paths = read(STORAGE_KEY);
  const disabledPaths = read(DISABLED_STORAGE_KEY);
  if (on) {
    paths.add(path);
    disabledPaths.delete(path);
  } else {
    paths.delete(path);
    disabledPaths.add(path);
  }
  write(paths, STORAGE_KEY);
  write(disabledPaths, DISABLED_STORAGE_KEY);
}
