// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const editorIndexSource = await fs.readFile(
  path.join(process.cwd(), 'src', 'editor', 'index.ts'),
  'utf8',
);
const multiPaneSource = await fs.readFile(
  path.join(process.cwd(), 'src', 'editor', 'multi-pane-shell.ts'),
  'utf8',
);

describe('.cmir save conflict handling', () => {
  it('forces existing .cmir writes so cloud-sync mtime changes do not show overwrite prompts', () => {
    expect(editorIndexSource).toContain("force: documentFormat === 'cmir'");
    expect(editorIndexSource).toContain('await getHost().saveExisting(file.handle, bytes, { force: true })');
    expect(multiPaneSource).toContain("await host.saveExisting(record.handle, bytes, { force: true })");
    expect(multiPaneSource).toContain("await getHost().saveExisting(rec.handle, bytes, { force: true })");
  });

  it('only lets the host force-autosave a live shared .cmir to the sync folder', () => {
    expect(editorIndexSource).toContain("collabCopresenceFor(activeDocIdentity().sessionUid)?.role === 'host'");
    expect(multiPaneSource).toContain("collabCopresenceFor(record.uid)?.role === 'host'");
  });

  it('prevents non-host live shared .cmir autosave/manual saves from writing the Dropbox file', () => {
    expect(editorIndexSource).toContain('activeSharedDocDiskWriter()');
    expect(editorIndexSource).toContain('if (!activeSharedDocDiskWriter()) return');
    expect(editorIndexSource).toContain('if (!activeSharedDocDiskWriter()) {');
    expect(multiPaneSource).toContain('sharedDocDiskWriter(record)');
    expect(multiPaneSource).toContain('if (!sharedDocDiskWriter(record)) return');
    expect(multiPaneSource).toContain('if (!sharedDocDiskWriter(rec)) {');
  });
});
