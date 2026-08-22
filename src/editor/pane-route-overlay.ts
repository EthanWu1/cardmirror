export type PaneRouteChoice<Slot extends string> = Slot | 'separate';

export interface PaneRouteSlot<Slot extends string> {
  id: Slot;
  label: string;
  filename: string;
  stackCount: number;
}

export interface PaneRouteOverlayOptions<Slot extends string> {
  filename: string;
  slots: readonly PaneRouteSlot<Slot>[];
  activeSlotId: Slot | null;
  allowSeparate?: boolean;
  separateLabel?: string;
  ariaLabel?: string;
}

function slotDisplayName(slot: PaneRouteSlot<string>): string {
  return slot.filename.trim();
}

function makeSlotButton<Slot extends string>(
  slot: PaneRouteSlot<Slot>,
  filename: string,
  active: boolean,
  finish: (choice: PaneRouteChoice<Slot> | null) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pmd-pane-route-slot ${slot.stackCount > 0 ? 'is-open' : 'is-empty'}`;
  if (active) button.classList.add('is-active-slot');
  button.dataset['slot'] = slot.id;
  button.setAttribute('aria-label', `Open ${filename} into pane ${slot.label}`);

  const number = document.createElement('span');
  number.className = 'pmd-pane-route-number';
  number.textContent = slot.label;
  button.appendChild(number);

  const title = document.createElement('span');
  title.className = 'pmd-pane-route-title';
  title.textContent = slotDisplayName(slot);
  button.appendChild(title);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    finish(slot.id);
  });
  return button;
}

export function showPaneRouteOverlay<Slot extends string>(
  opts: PaneRouteOverlayOptions<Slot>,
): Promise<PaneRouteChoice<Slot> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay pmd-pane-route-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-pane-route-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.ariaLabel ?? `Open ${opts.filename}`);

    let settled = false;
    const removalObserver = new MutationObserver(() => {
      if (!overlay.isConnected) finish(null);
    });

    const finish = (choice: PaneRouteChoice<Slot> | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      removalObserver.disconnect();
      overlay.remove();
      resolve(choice);
    };

    const header = document.createElement('div');
    header.className = 'pmd-route-header pmd-pane-route-header';
    header.textContent = `Open ${opts.filename} into...`;
    dialog.appendChild(header);

    const slots = document.createElement('div');
    slots.className = 'pmd-pane-route-slots';
    opts.slots.forEach((slot) => {
      slots.appendChild(makeSlotButton(slot, opts.filename, slot.id === opts.activeSlotId, finish));
    });
    dialog.appendChild(slots);

    const actions = document.createElement('div');
    actions.className = 'pmd-pane-route-actions';
    if (opts.allowSeparate) {
      const separate = document.createElement('button');
      separate.type = 'button';
      separate.className = 'pmd-route-cancel pmd-pane-route-cancel pmd-pane-route-separate';
      separate.textContent = opts.separateLabel ?? 'Open separate';
      separate.addEventListener('click', () => finish('separate'));
      actions.appendChild(separate);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel pmd-pane-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    actions.appendChild(cancel);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(null);
    });

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && opts.slots[index]) {
        event.preventDefault();
        finish(opts.slots[index]!.id);
      } else if (opts.allowSeparate && event.key.toLowerCase() === 's') {
        event.preventDefault();
        finish('separate');
      }
    };

    document.body.appendChild(overlay);
    removalObserver.observe(document.body, { childList: true });
    document.addEventListener('keydown', onKey);
    (overlay.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}
