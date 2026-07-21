// @vitest-environment jsdom
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  compactLocationLabel,
  confirmCloseUnsaved,
  type CloseUnsavedChoice,
} from '../../src/editor/unsaved-close-dialog.js';

const styleCss = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'style.css'), 'utf8');

afterEach(() => {
  document.body.innerHTML = '';
});

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(styleCss);
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
}

function visibleButtonLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.pmd-unsaved-close-actions button')]
    .map((button) => button.textContent?.trim() ?? '');
}

describe('unsaved close dialog', () => {
  it('compacts long cloud paths for the location row', () => {
    expect(
      compactLocationLabel('C:\\Users\\ethan\\Dropbox\\25-26 Memorial LD\\UMich\\AFF'),
    ).toBe('Dropbox › … › UMich › AFF');
    expect(compactLocationLabel('Downloads')).toBe('Downloads');
  });

  it('shows a compact save prompt with a location row', async () => {
    const choice = confirmCloseUnsaved({
      locationLabel: 'C:\\Users\\ethan\\Dropbox\\25-26 Memorial LD\\UMich\\AFF',
    });

    expect(document.querySelector('.pmd-unsaved-close-title')?.textContent).toBe(
      'Save changes to this file?',
    );
    expect(document.querySelector('.pmd-unsaved-location-label')?.textContent).toBe(
      'Choose a Location',
    );
    expect(document.querySelector('.pmd-unsaved-location-icon')).not.toBeNull();
    expect(document.querySelector('.pmd-unsaved-location-text')?.textContent).toBe(
      'Dropbox › … › UMich › AFF',
    );
    expect(document.querySelector('.pmd-unsaved-location-text')?.getAttribute('title')).toContain(
      '25-26 Memorial LD',
    );
    expect(visibleButtonLabels()).toEqual(['Save', "Don't Save", 'Cancel']);
    expect(document.body.textContent).not.toContain('Save As');
    expect(document.body.textContent).not.toContain('Rename');
    expect(document.body.textContent).not.toContain('Recovery journal');
    expect(document.querySelectorAll('.pmd-unsaved-close-dialog input')).toHaveLength(0);
    expect(document.querySelectorAll('.pmd-unsaved-close-dialog select')).toHaveLength(0);

    document.querySelector<HTMLButtonElement>('.pmd-unsaved-close-primary')!.click();
    await expect(choice).resolves.toBe('save');
    expect(document.querySelector('.pmd-route-overlay')).toBeNull();
  });

  it('allows overwrite prompts to use the same compact save dialog chrome', async () => {
    const choice = confirmCloseUnsaved({
      title: 'Save your current document before creating a new one?',
      locationLabel: 'C:\\Users\\ethan\\Dropbox\\25-26 Memorial LD\\UMich\\AFF',
    });

    expect(document.querySelector('.pmd-unsaved-close-dialog')).not.toBeNull();
    expect(document.querySelector('.pmd-unsaved-close-title')?.textContent).toBe(
      'Save your current document before creating a new one?',
    );
    expect(document.querySelector('.pmd-unsaved-location-button')).not.toBeNull();
    expect(visibleButtonLabels()).toEqual(['Save', "Don't Save", 'Cancel']);

    document.querySelectorAll<HTMLButtonElement>('.pmd-unsaved-close-actions button')[1]!.click();
    await expect(choice).resolves.toBe('discard');
  });

  it('lets the location row pick a target without saving yet', async () => {
    const chooseLocation = vi.fn(async () => 'C:\\Users\\ethan\\Dropbox\\Big Folder\\AFF');
    let settled: CloseUnsavedChoice | null = null;
    const choice = confirmCloseUnsaved({
      locationLabel: 'Downloads',
      onChooseLocation: chooseLocation,
    });
    void choice.then((value) => {
      settled = value;
    });

    expect(document.querySelector('.pmd-unsaved-location-button')?.textContent).toContain(
      'Downloads',
    );
    document.querySelector<HTMLButtonElement>('.pmd-unsaved-location-button')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chooseLocation).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.pmd-unsaved-location-text')?.textContent).toBe(
      'Dropbox › … › Big Folder › AFF',
    );
    expect(settled).toBeNull();

    document.querySelector<HTMLButtonElement>('.pmd-unsaved-close-primary')!.click();
    await expect(choice).resolves.toBe('save');
  });

  it('maps number keys to the visible button order', async () => {
    const choice = confirmCloseUnsaved();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));

    await expect(choice).resolves.toBe('discard');
  });

  it('uses a dark Word-style save prompt color scheme', () => {
    expect(ruleBody('.pmd-unsaved-close-dialog')).toContain('background: var(--pmd-c-dialog-bg);');
    expect(ruleBody('.pmd-unsaved-close-title')).toContain(
      'color: color-mix(in srgb, var(--pmd-c-accent) 78%, #fff);',
    );
    expect(ruleBody('.pmd-unsaved-location-label')).toContain('color: var(--pmd-c-dialog-text);');
    expect(ruleBody('.pmd-unsaved-location-button')).toContain('background: var(--pmd-c-dialog-control);');
    expect(ruleBody('.pmd-unsaved-location-button:hover')).toContain('color: #242424;');
    expect(ruleBody('.pmd-unsaved-location-chevron')).toContain('color: #242424;');
    expect(ruleBody('.pmd-unsaved-close-actions')).toContain('background: var(--pmd-c-dialog-bg-strong);');
    // Don't Save / Cancel must use the LIGHT dialog-button tokens — the old
    // ribbon background went near-black in dark mode and the buttons vanished
    // (field bug 2026-07-19, reported twice).
    expect(ruleBody('.pmd-unsaved-close-btn')).toContain('background: var(--pmd-c-dialog-button);');
    expect(ruleBody('.pmd-unsaved-close-btn')).toContain('color: var(--pmd-c-dialog-button-text);');
    expect(ruleBody('.pmd-unsaved-close-btn')).not.toContain('var(--pmd-c-ribbon)');
    expect(ruleBody('.pmd-unsaved-close-primary')).toContain('background: var(--pmd-c-accent);');
    expect(ruleBody('.pmd-unsaved-close-primary')).toContain('color: var(--pmd-c-text-on-accent);');
    expect(ruleBody('.pmd-unsaved-close-primary')).toContain('border-color: var(--pmd-c-accent);');
    expect(ruleBody('.pmd-unsaved-close-primary:hover')).toContain('color: var(--pmd-c-text-on-accent);');
  });
});
