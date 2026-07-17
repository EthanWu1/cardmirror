import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { serializeNative } from '../../src/index.js';
import { recoveryJournalMatchesDisk } from '../../src/editor/recovery-prune.js';

const n = schema.nodes;

function pmDoc(text: string) {
  return n['doc']!.createChecked(null, [
    n['paragraph']!.create(null, schema.text(text)),
  ]);
}

describe('recovery journal pruning', () => {
  it('treats a journal matching the file on disk as redundant', async () => {
    const bytes = serializeNative(pmDoc('already saved'));

    await expect(recoveryJournalMatchesDisk(bytes, bytes, 'cmir')).resolves.toBe(true);
  });

  it('keeps a journal with real unsaved content', async () => {
    const diskBytes = serializeNative(pmDoc('already saved'));
    const journalBytes = serializeNative(pmDoc('unsaved edits'));

    await expect(recoveryJournalMatchesDisk(journalBytes, diskBytes, 'cmir')).resolves.toBe(false);
  });
});
