// @vitest-environment jsdom
/**
 * Home-screen number shortcuts (1-9) must stand down while a modal or the
 * command bar is layered over the home screen — otherwise they fire over the
 * modal and swallow number input meant for it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homeScreen, type HomeScreenCallbacks } from '../../src/editor/home-screen.js';
import { pushOverlay, popOverlay } from '../../src/editor/overlay-stack.js';

const styleCss = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'style.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(styleCss);
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
}

function makeCallbacks(): HomeScreenCallbacks & {
  newDoc: ReturnType<typeof vi.fn>;
  openFilePath: ReturnType<typeof vi.fn>;
  listSearchFiles?: ReturnType<typeof vi.fn>;
} {
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

function press(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function changeInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('home-screen number shortcuts', () => {
  let cb: ReturnType<typeof makeCallbacks>;

  beforeEach(() => {
    document.body.innerHTML = '';
    cb = makeCallbacks();
    homeScreen.mount(document.body, cb);
    homeScreen.show();
  });

  afterEach(() => {
    homeScreen.hide();
  });

  it('fires the action when the home screen is the active layer', () => {
    press('1');
    expect(cb.open).toHaveBeenCalledTimes(1);
  });

  it('does not render the startup title/header block', () => {
    expect(document.querySelector('.pmd-home-header')).toBeNull();
    expect(document.querySelector('.pmd-home-title')).toBeNull();
    expect(document.querySelector('.pmd-home-tagline')).toBeNull();
    expect(document.querySelector('.pmd-home-mark')).toBeNull();
    expect(document.body.textContent).not.toContain('CardMirror');
  });

  it('uses a compact Word-like sidebar and omits speech, clean, and learn tiles', () => {
    expect(document.querySelector('.pmd-home-sidebar')).not.toBeNull();
    expect(document.querySelector('.pmd-home-main')).not.toBeNull();
    expect(document.querySelector('.pmd-home-file-search-input')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('.pmd-home-file-search-input')?.placeholder).toBe('Search everything');
    expect(document.querySelector('.pmd-home-file-search-icon')).not.toBeNull();
    expect(document.querySelector('.pmd-home-search-status')?.textContent).toBe('');
    expect(Array.from(document.querySelectorAll('.pmd-home-action-title')).map((el) => el.textContent)).toEqual([
      'OPEN',
      'NEW',
      'CARDS',
      'FLOW',
      'CONVERT',
    ]);
    expect(document.querySelectorAll('.pmd-home-action .pmd-icon').length).toBe(5);
    expect(document.querySelector('.pmd-home-qc-section')).toBeNull();
    expect(document.querySelector('.pmd-home-learn')).toBeNull();
    expect(document.body.textContent).not.toContain('New speech document');
    expect(document.body.textContent).not.toContain('Clean styles');
    expect(document.body.textContent).not.toContain('Learn');
  });

  it('keeps the back affordance visually secondary', () => {
    expect(document.querySelector('.pmd-home-back-small')).not.toBeNull();
  });

  it('shows a back arrow when home can return to an open document', () => {
    homeScreen.hide();
    homeScreen.show({ canReturnToDoc: true });

    const back = document.querySelector<HTMLButtonElement>('.pmd-home-back')!;
    expect(back.hidden).toBe(false);
    expect(back.querySelector('.pmd-home-back-arrow')).not.toBeNull();
    expect(back.textContent).toContain('Back to document');
  });

  it('uses a gray centered home surface with aligned search and result widths', () => {
    expect(ruleBody('.pmd-home-screen')).toContain('background: var(--pmd-c-surface);');
    expect(ruleBody('.pmd-home-main')).toContain('background: var(--pmd-c-surface);');
    expect(ruleBody('.pmd-home-search-section')).toContain('width: min(720px, 100%);');
    expect(ruleBody('.pmd-home-search-section')).toContain('margin: min(8vh, 72px) auto 1.4rem;');
    expect(ruleBody('.pmd-home-file-search-label')).toContain('width: 100%;');
    expect(ruleBody('.pmd-home-search-results')).toContain('width: 100%;');
    expect(ruleBody('.pmd-home-recents-header')).toContain('max-width: 720px;');
    expect(ruleBody('.pmd-home-recents')).toContain('max-width: 720px;');
  });

  it('searches configured docx/cmir files and opens the selected result', async () => {
    cb.listSearchFiles = vi.fn().mockResolvedValue([
      {
        path: 'C:\\Cases\\Aff\\Healthcare costs.docx',
        relPath: 'Aff\\Healthcare costs.docx',
        mtimeMs: 20,
      },
      {
        path: 'C:\\Cases\\Neg\\States CP.cmir',
        relPath: 'Neg\\States CP.cmir',
        mtimeMs: 10,
      },
    ]);
    homeScreen.hide();
    document.body.innerHTML = '';
    homeScreen.mount(document.body, cb);
    homeScreen.show();

    const input = document.querySelector<HTMLInputElement>('.pmd-home-file-search-input')!;
    changeInput(input, 'health');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = document.querySelector<HTMLButtonElement>('.pmd-home-search-result')!;
    expect(result.textContent).toContain('Healthcare costs');
    expect(result.textContent).toContain('DOCX');
    result.click();
    expect(cb.openFilePath).toHaveBeenCalledWith(
      'C:\\Cases\\Aff\\Healthcare costs.docx',
      'Healthcare costs.docx',
    );
  });

  it('does NOT fire while a modal overlay is open', () => {
    const token = pushOverlay();
    try {
      press('1');
      expect(cb.open).not.toHaveBeenCalled();
    } finally {
      popOverlay(token);
    }
  });

  it('does NOT fire when focus is in a text input (e.g. the command bar)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    press('1', input);
    expect(cb.open).not.toHaveBeenCalled();
  });

  it('resumes firing once the overlay closes', () => {
    const token = pushOverlay();
    press('1');
    popOverlay(token);
    press('1');
    expect(cb.open).toHaveBeenCalledTimes(1);
  });
});

describe('home-screen shortcuts reflow around the gated Compress tile', () => {
  afterEach(() => homeScreen.hide());

  function mountWith(extra: Partial<HomeScreenCallbacks>) {
    document.body.innerHTML = '';
    const cb = {
      newDoc: vi.fn(),
      newSpeechDoc: vi.fn(),
      open: vi.fn(),
      openRecent: vi.fn(),
      manageQuickCards: vi.fn(),
      newFlow: vi.fn(),
      clean: vi.fn(),
      bulkConvert: vi.fn(),
      openFilePath: vi.fn(),
      ...extra,
    } as HomeScreenCallbacks & { manageQuickCards: ReturnType<typeof vi.fn> };
    homeScreen.mount(document.body, cb);
    homeScreen.show();
    return cb;
  }

  it('key 3 runs Manage quick cards after removing the extra home tiles', () => {
    // Runners: 1 Open, 2 New, 3 Quick Cards.
    const cb = mountWith({}); // no bulkCompress supplied
    press('3');
    expect(cb.manageQuickCards).toHaveBeenCalledTimes(1);
  });

  it('Compress gated ON no longer changes the home shortcut map', () => {
    const bulkCompress = vi.fn();
    const cb = mountWith({ bulkCompress });
    press('3');
    expect(bulkCompress).not.toHaveBeenCalled();
    expect(cb.manageQuickCards).toHaveBeenCalledTimes(1);
  });

  it('key 2 runs New after removing New Speech from home', () => {
    const cb = mountWith({});
    press('2');
    expect(cb.newDoc).toHaveBeenCalledTimes(1);
    expect(cb.manageQuickCards).not.toHaveBeenCalled();
  });

  it('key 4 runs Flow from the home sidebar', () => {
    const newFlow = vi.fn();
    const cb = mountWith({ newFlow });
    press('4');
    expect(newFlow).toHaveBeenCalledTimes(1);
    expect(cb.manageQuickCards).not.toHaveBeenCalled();
  });

  it('key 5 runs Convert from the home sidebar', () => {
    const bulkConvert = vi.fn();
    const cb = mountWith({ bulkConvert });
    press('5');
    expect(bulkConvert).toHaveBeenCalledTimes(1);
    expect(cb.manageQuickCards).not.toHaveBeenCalled();
  });
});
