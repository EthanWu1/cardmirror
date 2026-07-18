// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homeScreen, type HomeScreenCallbacks } from '../../src/editor/home-screen.js';
import { clearRecents, recordRecent } from '../../src/editor/recents-store.js';
import { shouldDeferFlowOpen, shouldHandleInitialDocPayload } from '../../src/editor/boot-home.js';

const indexSource = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8');

function sliceSource(startNeedle: string, endNeedle: string, from = 0): string {
  const start = indexSource.indexOf(startNeedle, from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = indexSource.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

type CallbackMocks = HomeScreenCallbacks & {
  newFlow: ReturnType<typeof vi.fn>;
  openRecent: ReturnType<typeof vi.fn>;
  openFilePath: ReturnType<typeof vi.fn>;
  listSearchFiles?: ReturnType<typeof vi.fn>;
};

function callbacks(): CallbackMocks {
  return {
    newDoc: vi.fn(),
    newSpeechDoc: vi.fn(),
    newFlow: vi.fn(),
    open: vi.fn(),
    openRecent: vi.fn(),
    manageQuickCards: vi.fn(),
    openFilePath: vi.fn(),
  };
}

function changeInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('home flow integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    clearRecents();
  });

  afterEach(() => {
    homeScreen.hide();
  });

  it('renders a FLOW action and a Flows section with cmflow recents', () => {
    recordRecent({
      handle: 'C:/flows/round.cmflow',
      filename: 'round.cmflow',
      format: 'cmflow',
    });

    const cb = callbacks();
    homeScreen.mount(document.body, cb);
    homeScreen.show();

    expect(
      Array.from(document.querySelectorAll('.pmd-home-action-title')).map((el) => el.textContent),
    ).toContain('FLOW');
    const sections = Array.from(document.querySelectorAll('section'));
    const flowsSection = sections.find((section) =>
      section.querySelector('.pmd-home-section-title')?.textContent?.includes('Flows'),
    );
    expect(flowsSection).toBeTruthy();
    expect(flowsSection?.querySelector('.pmd-home-recent-format')?.textContent).toBe('CMFLOW');
    expect(flowsSection?.querySelector('.pmd-home-recent-name')?.getAttribute('title')).toBe(
      'round.cmflow',
    );

    flowsSection?.querySelector<HTMLButtonElement>('.pmd-home-recent')?.click();
    expect(cb.openRecent).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'round.cmflow',
        format: 'cmflow',
      }),
    );
  });

  it('renders distinct Word-like icons for the primary home actions', () => {
    const cb = callbacks();
    homeScreen.mount(document.body, cb);
    homeScreen.show();

    const iconsByTitle = new Map(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.pmd-home-action')).map((action) => [
        action.querySelector('.pmd-home-action-title')?.textContent,
        Array.from(action.querySelector('.pmd-home-action-icon')?.classList ?? []),
      ]),
    );

    expect(iconsByTitle.get('OPEN')).toContain('pmd-icon-open');
    expect(iconsByTitle.get('NEW')).toContain('pmd-icon-new');
    expect(iconsByTitle.get('CARDS')).toContain('pmd-icon-bookmark');
    expect(iconsByTitle.get('FLOW')).toContain('pmd-icon-grid');
    expect(iconsByTitle.get('CONVERT')).toContain('pmd-icon-reset');
    expect(
      new Set(
        ['OPEN', 'NEW', 'CARDS', 'FLOW', 'CONVERT'].map(
          (title) => iconsByTitle.get(title)?.find((className) => className.startsWith('pmd-icon-')),
        ),
      ).size,
    ).toBe(5);
  });

  it('shows cmflow home search results and routes them through openFilePath', async () => {
    const cb = callbacks();
    cb.listSearchFiles = vi.fn().mockResolvedValue([
      {
        path: 'C:/flows/round.cmflow',
        relPath: 'round.cmflow',
        mtimeMs: 30,
      },
    ]);
    homeScreen.mount(document.body, cb);
    homeScreen.show();

    const input = document.querySelector<HTMLInputElement>('.pmd-home-file-search-input')!;
    changeInput(input, 'round');
    await flush();

    const result = document.querySelector<HTMLButtonElement>('.pmd-home-search-result')!;
    expect(result.textContent).toContain('CMFLOW');
    expect(result.textContent).toContain('round');
    result.click();
    expect(cb.openFilePath).toHaveBeenCalledWith('C:/flows/round.cmflow', 'round.cmflow');
  });

  it('keeps Home visible for deferred cmflow opens in index wiring', () => {
    const openFilePathBody = sliceSource(
      'openFilePath: (path: string, name: string) => {',
      'listSearchFiles:',
    );
    const flowGuard = openFilePathBody.indexOf('isFlowFilename(path) || isFlowFilename(name)');
    const multiPanePreRouteHide = openFilePathBody.indexOf('if (multiDocActive) homeScreen.hide();');
    const openResult = openFilePathBody.indexOf(
      'const opened = await openFileByPath(path, name, { forceFlowInPlace: true });',
    );
    const acceptedHide = openFilePathBody.indexOf('if (opened) homeScreen.hide();');
    const rejectedShow = openFilePathBody.indexOf('else if (multiDocActive) homeScreen.show();');
    const firstHide = openFilePathBody.indexOf('homeScreen.hide()');

    expect(flowGuard).toBeGreaterThanOrEqual(0);
    expect(flowGuard).toBeLessThan(firstHide);
    expect(multiPanePreRouteHide).toBeGreaterThan(flowGuard);
    expect(multiPanePreRouteHide).toBeLessThan(openResult);
    expect(openResult).toBeGreaterThan(multiPanePreRouteHide);
    expect(acceptedHide).toBeGreaterThan(openResult);
    expect(rejectedShow).toBeGreaterThan(openResult);

    const recentStart = indexSource.indexOf('async function openRecentInPlace');
    expect(recentStart).toBeGreaterThanOrEqual(0);
    const recentFlowStart = indexSource.indexOf(
      'flowFormatForFilename(file.name) || flowFormatForFilename(recent.filename)',
      recentStart,
    );
    expect(recentFlowStart).toBeGreaterThan(recentStart);
    const recentFlowEnd = indexSource.indexOf(
      '\n  const { takenByOther } = await electron.openPathCheck(file.handle);',
      recentFlowStart,
    );
    expect(recentFlowEnd).toBeGreaterThan(recentFlowStart);
    const recentFlowBody = indexSource.slice(recentFlowStart, recentFlowEnd);
    expect(recentFlowBody).toContain('if (multiDocActive)');
    expect(recentFlowBody.indexOf('homeScreen.hide()')).toBeLessThan(
      recentFlowBody.indexOf('await routeOpenedFlowFile'),
    );
    expect(recentFlowBody).toContain('if (!isPristineStarter && electron.canSpawnWindow)');
    expect(recentFlowBody).toContain('await mountOpenedFlowInPlace');
  });

  it('treats cmflow initial-doc payloads as unhandled so blank/Home boot can continue', () => {
    expect(
      shouldHandleInitialDocPayload({
        filename: 'round.cmflow',
        format: 'cmflow',
      }),
    ).toBe(false);
    expect(
      shouldHandleInitialDocPayload({
        filename: 'case.cmir',
        format: 'cmir',
      }),
    ).toBe(true);
    expect(
      shouldHandleInitialDocPayload({
        filename: 'join-placeholder',
        joinShareCode: 'abc123',
      }),
    ).toBe(true);
  });

  it('detects deferred cmflow picker results so Home can remain visible', () => {
    expect(shouldDeferFlowOpen({ name: 'round.cmflow' })).toBe(true);
    expect(shouldDeferFlowOpen({ filename: 'round.cmflow' })).toBe(true);
    expect(shouldDeferFlowOpen({ path: 'C:/flows/round.cmflow' })).toBe(true);
    expect(shouldDeferFlowOpen({ name: 'case.cmir' })).toBe(false);
  });
});
