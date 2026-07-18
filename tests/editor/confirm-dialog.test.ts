// @vitest-environment jsdom
/**
 * In-editor confirm dialog (`showConfirm`) — the window.confirm replacement for
 * transclusion create/update prompts.
 */
import { describe, expect, it } from 'vitest';
import { showConfirm } from '../../src/editor/confirm-dialog.js';

describe('showConfirm', () => {
  it('resolves true when the confirm button is clicked, and cleans up', async () => {
    const p = showConfirm({ message: 'Proceed?', confirmLabel: 'Yes' });
    const ok = document.querySelector('.pmd-confirm-ok') as HTMLButtonElement | null;
    expect(ok?.textContent).toBe('Yes');
    ok!.click();
    expect(await p).toBe(true);
    expect(document.querySelector('.pmd-confirm-backdrop')).toBeNull();
  });

  it('resolves false when cancel is clicked', async () => {
    const p = showConfirm({ message: 'Proceed?' });
    (document.querySelector('.pmd-confirm-cancel') as HTMLButtonElement).click();
    expect(await p).toBe(false);
  });

  it('resolves false on Escape', async () => {
    const p = showConfirm({ message: 'Proceed?' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBe(false);
  });

  it('renders the title + message and marks a danger action', async () => {
    const p = showConfirm({ title: 'Heads up', message: 'Body', danger: true });
    expect(document.querySelector('.pmd-confirm-title')?.textContent).toBe('Heads up');
    expect(document.querySelector('.pmd-confirm-message')?.textContent).toBe('Body');
    expect(document.querySelector('.pmd-confirm-ok')?.classList.contains('pmd-confirm-danger')).toBe(
      true,
    );
    (document.querySelector('.pmd-confirm-cancel') as HTMLButtonElement).click();
    await p;
  });
});
