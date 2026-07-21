// @vitest-environment jsdom
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { alertDialog, confirmDialog, confirmDialogDetailed } from '../../src/editor/text-prompt.js';

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

describe('alert and confirm route dialogs', () => {
  it('keeps shared route dialogs visible when their overlay opens', () => {
    const routeDialog = ruleBody('.pmd-route-dialog');
    expect(routeDialog).toContain('display: flex;');
    expect(routeDialog).not.toContain('display: none;');
  });

  it('renders titled alerts with a Word-style title, icon, plain wrapped message, and OK button', async () => {
    const done = alertDialog(
      'The maximum length value must be equal to or greater than the length of the default text.',
      { title: 'CardMirror' },
    );

    expect(document.querySelector('.pmd-alert-title')?.textContent).toBe('CardMirror');
    expect(document.querySelector('.pmd-alert-icon')?.textContent).toBe('!');
    expect(document.querySelector('.pmd-alert-icon-warning')).not.toBeNull();
    expect(document.querySelector('.pmd-alert-message')?.textContent).toContain('maximum length');
    expect(document.querySelector('.pmd-choice-prompt-detail')).toBeNull();
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['OK']);

    document.querySelector<HTMLButtonElement>('.pmd-text-prompt-ok')!.click();
    await expect(done).resolves.toBeUndefined();
  });

  it('renders confirms with a question icon in the shared dialog icon family', async () => {
    const done = confirmDialog('Connect this document to the live shared room?', {
      title: 'CardMirror',
      okLabel: 'Connect',
      cancelLabel: 'Keep Local Copy',
    });

    expect(document.querySelector('.pmd-alert-title')?.textContent).toBe('CardMirror');
    expect(document.querySelector('.pmd-alert-icon-question')?.textContent).toBe('?');
    expect(document.querySelector('.pmd-alert-row-no-icon')).toBeNull();
    expect(document.querySelector('.pmd-alert-message')?.textContent).toContain('Connect this document');
    expect(document.querySelector('.pmd-choice-prompt-detail')).toBeNull();
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Keep Local Copy',
      'Connect',
    ]);

    document.querySelector<HTMLButtonElement>('.pmd-text-prompt-ok')!.click();
    await expect(done).resolves.toBe(true);
  });

  it('renders destructive confirms with the restored compact danger button style', async () => {
    const done = confirmDialog('Everyone keeps the copy currently on their screen.', {
      title: 'End live session?',
      okLabel: 'End Session',
      danger: true,
    });

    const ok = document.querySelector<HTMLButtonElement>('.pmd-text-prompt-ok')!;
    expect(ok.textContent).toBe('End Session');
    expect(ok.classList.contains('pmd-text-prompt-danger')).toBe(true);
    expect(document.querySelector('.pmd-alert-icon-danger')?.textContent).toBe('!');
    expect(ruleBody('.pmd-alert-dialog .pmd-text-prompt-ok')).toContain(
      'background: var(--pmd-c-dialog-button);',
    );
    expect(ruleBody('.pmd-alert-dialog .pmd-text-prompt-danger')).toContain(
      'background: color-mix(in srgb, var(--pmd-c-error) 68%, #202020);',
    );

    ok.click();
    await expect(done).resolves.toBe(true);
  });

  it('can resolve a confirm dialog with a do-not-ask-again checkbox', async () => {
    const done = confirmDialogDetailed('Reload into the new workspace layout?', {
      title: 'Switch workspace layout?',
      okLabel: 'Switch',
      checkboxLabel: 'Do not ask again',
    });

    const checkbox = document.querySelector<HTMLInputElement>('.pmd-confirm-checkbox input')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    checkbox.click();
    document.querySelector<HTMLButtonElement>('.pmd-text-prompt-ok')!.click();

    await expect(done).resolves.toEqual({ confirmed: true, checked: true });
  });

  it('styles route-choice buttons as compact dialog actions instead of large cards', () => {
    expect(ruleBody('.pmd-route-buttons')).toContain('justify-content: flex-end;');
    expect(ruleBody('.pmd-route-btn')).toContain('flex: 0 0 auto;');
    expect(ruleBody('.pmd-route-btn')).toContain('min-width: 5.8rem;');
    expect(ruleBody('.pmd-route-btn span')).toContain('display: none;');
  });

  it('styles alert text like the dark Word popup instead of a boxed panel', () => {
    expect(ruleBody('.pmd-alert-dialog')).toContain('width: min(520px, calc(100vw - 32px));');
    expect(ruleBody('.pmd-alert-dialog')).toContain('min-width: min(340px, calc(100vw - 32px));');
    expect(ruleBody('.pmd-alert-dialog')).toContain('padding: 1rem 1.15rem 0.85rem;');
    expect(ruleBody('.pmd-alert-title')).toContain('color: var(--pmd-c-dialog-text);');
    expect(ruleBody('.pmd-alert-title')).toContain('font-size: 1.08rem;');
    expect(ruleBody('.pmd-alert-row')).toContain('display: grid;');
    expect(ruleBody('.pmd-alert-row')).toContain('grid-template-columns: 3rem minmax(0, 1fr);');
    expect(ruleBody('.pmd-alert-row-no-icon')).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(ruleBody('.pmd-alert-icon')).toContain('width: 2.4rem;');
    expect(ruleBody('.pmd-alert-message')).toContain('color: var(--pmd-c-dialog-text);');
    expect(ruleBody('.pmd-alert-message')).toContain('font-size: 0.88rem;');
    expect(ruleBody('.pmd-alert-message')).toContain('white-space: pre-line;');
    expect(ruleBody('.pmd-alert-dialog .pmd-text-prompt-ok')).toContain(
      'background: var(--pmd-c-dialog-button);',
    );
    expect(ruleBody('.pmd-text-prompt-buttons .pmd-route-cancel')).toContain('background: var(--pmd-c-dialog-button);');
    expect(ruleBody('.pmd-text-prompt-buttons .pmd-route-cancel:hover')).toContain(
      'background: color-mix(in srgb, var(--pmd-c-dialog-button) 82%, #fff);',
    );
  });
});
