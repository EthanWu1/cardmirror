/**
 * In-editor confirm dialog — a Promise-based replacement for `window.confirm`
 * in editor flows, so a prompt reads as part of the app rather than a jarring
 * OS alert (and doesn't yank focus out of the contenteditable the way the
 * native dialog does). Resolves `true` on confirm, `false` on cancel / Escape /
 * backdrop click. Headless (no `document`) resolves `false`.
 */

export interface ConfirmOptions {
  /** Optional bold title line above the message. */
  title?: string;
  /** The body text (supports multiple lines via `\n`). */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action. */
  danger?: boolean;
}

export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'pmd-confirm-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'pmd-confirm';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    if (opts.title) {
      const title = document.createElement('div');
      title.className = 'pmd-confirm-title';
      title.textContent = opts.title;
      dialog.appendChild(title);
    }

    const message = document.createElement('div');
    message.className = 'pmd-confirm-message';
    // Preserve author-intended line breaks without allowing HTML injection.
    message.textContent = opts.message;
    dialog.appendChild(message);

    const actions = document.createElement('div');
    actions.className = 'pmd-confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pmd-confirm-btn pmd-confirm-cancel';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `pmd-confirm-btn pmd-confirm-ok${opts.danger ? ' pmd-confirm-danger' : ''}`;
    confirmBtn.textContent = opts.confirmLabel ?? 'OK';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const previouslyFocused = document.activeElement as HTMLElement | null;
    let settled = false;
    const close = (result: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      // Return focus to wherever it was (usually the editor).
      previouslyFocused?.focus?.();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener('keydown', onKey, true);

    setTimeout(() => confirmBtn.focus(), 0);
  });
}
