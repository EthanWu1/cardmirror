/**
 * Detect files living inside a consumer cloud-sync folder (Dropbox, OneDrive,
 * iCloud Drive, Google Drive).
 *
 * Why this matters for CO-EDITED documents specifically: a shared `.cmir`
 * carries its room pointer (room id + encrypted key) INSIDE the file. Cloud
 * sync replaces the whole file, last-writer-wins, with no idea what is in it.
 * So when the same shared file sits in a folder both collaborators sync:
 *
 *   - the room pointer can be swapped or reverted underneath a running app,
 *     leaving the two clients connected to DIFFERENT rooms — each "live", each
 *     invisible to the other (edits flow one way, or not at all);
 *   - both machines autosave the same path, so the sync client cannot
 *     reconcile it and produces "conflicted copy" files (and, on macOS, the
 *     cloud-with-error badge in Finder);
 *   - a not-yet-downloaded placeholder can fail to open at all.
 *
 * Field-confirmed 2026-07-27. The two mechanisms are also redundant: the relay
 * room already gives both people the same document, so the file does not need
 * to be shared through the cloud provider as well.
 *
 * Pure string matching — no I/O — so it is cheap and unit-testable. Matching is
 * deliberately conservative: only a path SEGMENT equal to (or prefixed by) a
 * known provider name counts, so `~/Documents/dropbox-notes.cmir` is not
 * flagged while `~/Dropbox (Team)/x.cmir` is.
 */

/** Provider names as they appear as a path segment, lowercased. A segment
 *  matches when it equals the name or starts with `name` + a separator-ish
 *  character (covers "Dropbox (Personal)", "OneDrive - Contoso"). */
const CLOUD_FOLDER_NAMES: readonly { id: string; label: string }[] = [
  { id: 'dropbox', label: 'Dropbox' },
  { id: 'onedrive', label: 'OneDrive' },
  { id: 'google drive', label: 'Google Drive' },
  { id: 'googledrive', label: 'Google Drive' },
  { id: 'gdrive', label: 'Google Drive' },
  // macOS iCloud Drive on disk: ~/Library/Mobile Documents/com~apple~CloudDocs
  { id: 'mobile documents', label: 'iCloud Drive' },
  { id: 'com~apple~clouddocs', label: 'iCloud Drive' },
  { id: 'icloud drive', label: 'iCloud Drive' },
];

function segmentMatches(segment: string): string | null {
  const s = segment.trim().toLowerCase();
  if (s === '') return null;
  for (const { id, label } of CLOUD_FOLDER_NAMES) {
    if (s === id) return label;
    // "Dropbox (Personal)", "OneDrive - Contoso" — a provider name followed by
    // a SPACE or "(", which is what the providers actually generate. Anything
    // tighter misses real folders; anything looser starts matching ordinary
    // names like "dropbox-notes" (caught by the false-positive test).
    // "dropboxes" / "onedriver" are excluded because the next char is a letter.
    if (s.length > id.length && s.startsWith(id) && /[ (]/.test(s.charAt(id.length))) {
      return label;
    }
  }
  return null;
}

/** The cloud provider whose folder contains `path`, or null. Accepts both
 *  Windows (`\`) and POSIX (`/`) separators. */
export function cloudSyncFolderLabel(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || path === '') return null;
  // Only DIRECTORY segments: the last segment is the filename, and a file
  // merely NAMED "dropbox-notes.cmir" is not in a synced folder.
  const segments = path.split(/[\\/]+/).slice(0, -1);
  for (const segment of segments) {
    const label = segmentMatches(segment);
    if (label) return label;
  }
  return null;
}

/** Warning text for a co-edited document stored in `label`'s folder. Kept
 *  here (not at the call site) so the wording stays consistent wherever the
 *  guard fires. */
export function cloudSyncCoEditWarning(label: string, filename: string): string {
  return (
    `"${filename}" is inside your ${label} folder and is being co-edited. ` +
    `If the other person syncs that same folder, ${label} will overwrite the ` +
    `file underneath both of you — which can disconnect the session, split ` +
    `you into separate rooms, or create "conflicted copy" files. ` +
    `Move it to a folder that isn't shared through ${label}; CardMirror's ` +
    `session already shares the document.`
  );
}
