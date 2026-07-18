// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeNative } from '../../src/native/index.js';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  capResultsForRender,
  clampPaletteToViewport,
} from '../../src/editor/quick-card-search-ui.js';

function installElectronApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, 'electronAPI', {
    value: api,
    configurable: true,
  });
}

function changeInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function contextmenu(el: Element): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRow(timeoutMs = 1000): Promise<HTMLElement> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await flush();
    const row = document.querySelector<HTMLElement>('.pmd-qcs-row');
    if (row) return row;
    await wait(20);
  }
  throw new Error('Timed out waiting for a search result row');
}

function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(
    null,
    schema.text(text, [schema.marks['cite_mark']!.create()]),
  );
}

function evidenceDoc() {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Single Payer AFF')),
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Healthcare spending')),
      citePara('Smith 23'),
      schema.nodes['card_body']!.create(
        null,
        schema.text('Unchecked discretionary spending crowds out productive capacity.'),
      ),
    ]),
  ]);
}

describe('capResultsForRender', () => {
  it('caps arrays to the requested render limit without mutating the source', () => {
    const rows = Array.from({ length: 500 }, (_, i) => i);

    expect(capResultsForRender(rows)).toHaveLength(180);
    expect(capResultsForRender(rows).at(-1)).toBe(179);
    expect(capResultsForRender(rows, 80)).toEqual(rows.slice(0, 80));
    expect(rows).toHaveLength(500);
  });
});

describe('clampPaletteToViewport', () => {
  it('keeps the whole search palette visible inside the viewport', () => {
    expect(
      clampPaletteToViewport({
        left: 720,
        top: 740,
        width: 540,
        height: 320,
        viewportWidth: 900,
        viewportHeight: 800,
        margin: 8,
      }),
    ).toEqual({ left: 352, top: 472 });
  });
});

describe('quick card search flow file results', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    localStorage.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    const mod = await import('../../src/editor/quick-card-search-ui.js');
    mod.quickCardSearchUI.close();
    document.body.innerHTML = '';
    delete (window as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
  });

  it('opens cmflow file results but does not offer or execute in-file object search', async () => {
    const readFileAtPath = vi.fn().mockResolvedValue({
      name: 'round.cmflow',
      bytes: new Uint8Array([123, 125]),
      handle: 'C:\\Flows\\round.cmflow',
      format: 'cmflow',
    });
    installElectronApi({
      listCmirFiles: vi.fn().mockResolvedValue([
        {
          path: 'C:\\Flows\\round.cmflow',
          relPath: 'round.cmflow',
          mtimeMs: 10,
          size: 2,
        },
      ]),
      readFileAtPath,
      onCmirFileIndexUpdated: vi.fn(() => () => {}),
    });
    const [{ quickCardSearchUI }, { settings }] = await Promise.all([
      import('../../src/editor/quick-card-search-ui.js'),
      import('../../src/editor/settings.js'),
    ]);
    settings.set('fileSearchRoots', ['C:\\Flows']);
    const openFilePath = vi.fn();
    quickCardSearchUI.open({
      view: null,
      paneEl: null,
      runCommand: vi.fn(),
      openFilePath,
    });

    const input = document.querySelector<HTMLInputElement>('.pmd-qcs-input')!;
    changeInput(input, 'f round');
    await flush();

    const row = document.querySelector<HTMLElement>('.pmd-qcs-row')!;
    expect(row.textContent).toContain('CMFLOW');
    expect(row.textContent).toContain('round');
    expect(document.querySelector('.pmd-qcs-hints')?.textContent).not.toContain('search inside');

    keydown(input, 'Tab');
    expect(readFileAtPath).not.toHaveBeenCalled();

    contextmenu(row);
    expect(readFileAtPath).not.toHaveBeenCalled();

    keydown(input, 'Enter');
    expect(openFilePath).toHaveBeenCalledWith('C:\\Flows\\round.cmflow', 'round');
  });

  it('indexes evidence text and opens a result at its anchor descriptor', async () => {
    const bytes = serializeNative(evidenceDoc());
    installElectronApi({
      listCmirFiles: vi.fn().mockResolvedValue([
        {
          path: 'C:\\Evidence\\Single-Payer 1AC.cmir',
          relPath: 'Aff\\Single-Payer 1AC.cmir',
          mtimeMs: 20,
          size: bytes.length,
        },
      ]),
      readFileAtPath: vi.fn().mockResolvedValue({
        name: 'Single-Payer 1AC.cmir',
        bytes,
        handle: 'C:\\Evidence\\Single-Payer 1AC.cmir',
        format: 'cmir',
      }),
      onCmirFileIndexUpdated: vi.fn(() => () => {}),
    });
    const [{ quickCardSearchUI }, { settings }] = await Promise.all([
      import('../../src/editor/quick-card-search-ui.js'),
      import('../../src/editor/settings.js'),
    ]);
    settings.set('fileSearchRoots', ['C:\\Evidence']);
    const openFileAtDescriptor = vi.fn();
    quickCardSearchUI.open({
      view: null,
      paneEl: null,
      runCommand: vi.fn(),
      openFilePath: vi.fn(),
      openFileAtDescriptor,
      mode: 'evidence',
    });

    const input = document.querySelector<HTMLInputElement>('.pmd-qcs-input')!;
    changeInput(input, 'discretionary spending');
    await flush();
    await wait(160);
    await flush();

    const row = await waitForRow();
    expect(row.textContent).toContain('EVD');
    expect(row.textContent).toContain('Single-Payer 1AC');
    expect(row.textContent).toContain('Unchecked discretionary spending');

    keydown(input, 'Enter');
    expect(openFileAtDescriptor).toHaveBeenCalledTimes(1);
    const [path, name, descriptor] = openFileAtDescriptor.mock.calls[0]!;
    expect(path).toBe('C:\\Evidence\\Single-Payer 1AC.cmir');
    expect(name).toBe('Single-Payer 1AC');
    expect(descriptor.quote).toContain('discretionary spending');
  });
});
