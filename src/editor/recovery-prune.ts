import { fromDocxFull, parseNative } from '../index.js';
import { isMeaningfullyDirtyFromBaseline } from './dirty-compare.js';

export type RecoveryPruneFormat = 'cmir' | 'docx' | null;

function bytesLookLikeDocx(bytes: Uint8Array): boolean {
  // .docx is a ZIP container and starts with "PK".
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function readDoc(bytes: Uint8Array) {
  if (bytesLookLikeDocx(bytes)) {
    return (await fromDocxFull(bytes)).doc;
  }
  return parseNative(bytes).doc;
}

/** True when a recovery journal is only a stale duplicate of the file that is
 * already on disk. Used at startup to avoid offering "Recover" for no-op edits
 * or clean mode-switch leftovers. */
export async function recoveryJournalMatchesDisk(
  journalBytes: Uint8Array,
  diskBytes: Uint8Array,
  format: RecoveryPruneFormat,
): Promise<boolean> {
  const diskDoc = await readDoc(diskBytes);
  const journalDoc = await readDoc(journalBytes);
  return !isMeaningfullyDirtyFromBaseline(diskDoc, journalDoc, format);
}
