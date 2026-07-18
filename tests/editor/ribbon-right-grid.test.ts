// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const indexHtml = await fs.readFile(path.join(process.cwd(), 'index.html'), 'utf8');

describe('ribbon right grid', () => {
  it('does not include Download or Keyboard Shortcuts buttons', () => {
    const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
    const grid = parsed.querySelector('.ribbon-right-grid');

    expect(grid).not.toBeNull();
    expect(grid!.querySelector('#download-app-btn')).toBeNull();
    expect(grid!.querySelector('#reference-btn')).toBeNull();
  });

  it('replaces GitHub and timer utility buttons with custom window controls', () => {
    const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
    const grid = parsed.querySelector('.ribbon-right-grid');
    const fileStack = parsed.querySelector('#file-command-stack');

    expect(grid).not.toBeNull();
    expect(fileStack).not.toBeNull();
    expect(fileStack!.classList.contains('ribbon-button-stack')).toBe(true);
    expect(fileStack!.classList.contains('ribbon-file-command-stack')).toBe(true);
    expect(Array.from(fileStack!.children).map((child) => child.id)).toEqual([
      'open-btn',
      'autosave-btn',
      'new-btn',
      'home-btn',
      'export-btn',
      'settings-btn',
    ]);
    expect(grid!.querySelector('#github-btn')).toBeNull();
    expect(grid!.querySelector('#timer-toggle-btn')).toBeNull();
    expect(grid!.querySelector('#settings-btn')).toBeNull();
    expect(grid!.querySelector('#home-btn')).toBeNull();
    expect(fileStack!.querySelector('#settings-btn')).not.toBeNull();
    expect(fileStack!.querySelector('#home-btn')).not.toBeNull();
    expect(grid!.querySelector('#window-minimize-btn')).not.toBeNull();
    expect(grid!.querySelector('#window-maximize-btn')).not.toBeNull();
    expect(grid!.querySelector('#window-close-btn')).not.toBeNull();
  });

  it('keeps only custom window controls in the right grid', () => {
    const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
    const grid = parsed.querySelector('.ribbon-right-grid');

    expect(grid).not.toBeNull();
    expect(Array.from(grid!.children).map((child) => child.id)).toEqual([
      'window-minimize-btn',
      'window-maximize-btn',
      'window-close-btn',
    ]);
  });

  it('does not include the screenshot utility clusters', () => {
    const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
    const removedIds = [
      'format-menu-panel',
      'table-menu-btn',
      'insert-image-btn',
      'superscript-btn',
      'subscript-btn',
      'strikethrough-btn',
      'numbering-panel',
      'num-role-btn',
      'num-sub-role-btn',
      'num-restart-btn',
      'num-visibility-btn',
      'doc-ops-panel',
      'paragraph-integrity-btn',
      'plain-paste-toggle-btn',
      'comments-ops-panel',
      'comments-toggle-btn',
      'comments-add-btn',
      'add-note-btn',
      'manage-flashcards-btn',
      'create-flashcard-btn',
      'ask-ai-btn',
    ];

    for (const id of removedIds) {
      expect(parsed.getElementById(id), id).toBeNull();
    }
  });
});
