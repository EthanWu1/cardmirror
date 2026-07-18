import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { RIBBON_GROUPS } from '../../src/editor/ribbon-groups.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
} from '../../src/editor/ribbon-commands.js';

const editorIndexSource = readFileSync('src/editor/index.ts', 'utf8');
const quickCardSearchSource = readFileSync('src/editor/quick-card-search-ui.ts', 'utf8');
const evidenceIndexWorkerPath = 'src/editor/evidence-index-worker.ts';

describe('Search Evidence command', () => {
  it('is a first-class ribbon command with a searchable label and no default shortcut', () => {
    expect(RIBBON_COMMAND_IDS).toContain('openEvidenceSearch');
    expect((RIBBON_COMMAND_LABELS as Record<string, string>).openEvidenceSearch).toBe('Search Evidence');
    expect((DEFAULT_RIBBON_KEYS as Record<string, string | string[]>).openEvidenceSearch).toBe('');
    expect(RIBBON_GROUPS.find((group) => group.title === 'Search')?.commands).toContain(
      'openEvidenceSearch',
    );
  });

  it('opens evidence results through the anchor-aware source route', () => {
    const fnStart = editorIndexSource.indexOf('async function openFileByPathAtDescriptor');
    const fnEnd = editorIndexSource.indexOf('/** Resolve `descriptor`', fnStart);
    const body = editorIndexSource.slice(fnStart, fnEnd);

    expect(body).toContain('showFlashcardSource({ path, name, descriptor }');
    expect(body).not.toContain('openFileByPath(path, name)');
    expect(body).not.toContain('focusDescriptorInActiveView(descriptor, name)');
  });

  it('indexes evidence incrementally instead of blocking on the whole corpus', () => {
    expect(quickCardSearchSource).toContain('EVIDENCE_INDEX_BATCH_SIZE');
    expect(quickCardSearchSource).toContain('this.evidenceRows = rows.slice();');
    expect(quickCardSearchSource).toContain('await idleYield(EVIDENCE_READ_IDLE_MS);');
    expect(quickCardSearchSource).toContain('capResultsForRender(');
  });

  it('queries evidence through the asynchronous cancelable search path', () => {
    expect(quickCardSearchSource).toContain('searchEvidenceRowsAsync');
    expect(quickCardSearchSource).toContain('evidenceSearchToken');
    expect(quickCardSearchSource).toContain('AbortController');
  });

  it('indexes evidence in a worker so parsing large docs cannot freeze the palette', () => {
    expect(existsSync(evidenceIndexWorkerPath)).toBe(true);
    const workerSource = readFileSync(evidenceIndexWorkerPath, 'utf8');

    expect(quickCardSearchSource).toContain('new Worker(new URL(\'./evidence-index-worker.ts\'');
    expect(quickCardSearchSource).toContain('indexEvidenceFileInWorker');
    expect(workerSource).toContain('fromDocx');
    expect(workerSource).toContain('parseNative');
    expect(workerSource).toContain('extractEvidenceRows');
  });
});
