export type CloseUnsavedChoice = 'save' | 'discard' | 'cancel';
export interface CloseUnsavedOptions {
  title?: string;
  locationLabel?: string | null;
  onChooseLocation?: () => Promise<string | null> | string | null;
}

export function locationLabelFromHandle(handle: unknown): string | null {
  if (typeof handle !== 'string' || !handle.trim()) return null;
  const normalized = handle.trim().replace(/[\\/]+$/, '');
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (slash <= 0) return null;
  return normalized.slice(0, slash);
}

export function compactLocationLabel(label: string | null | undefined): string {
  const trimmed = label?.trim();
  if (!trimmed) return 'Choose when saving';
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return trimmed;

  const cloudIndex = parts.findIndex((part) => /^(dropbox|onedrive|google drive)$/i.test(part.trim()));
  const anchor = cloudIndex >= 0 ? parts[cloudIndex]! : parts[0]!;
  const tail = parts.slice(-2);
  return `${anchor} › … › ${tail.join(' › ')}`;
}

function setLocationDisplay(el: HTMLElement, label: string | null | undefined): void {
  const raw = label?.trim() || 'Choose when saving';
  el.textContent = compactLocationLabel(raw);
  el.title = raw;
}

/** Compact prompt for closing a dirty document.
 * Save routes through the normal save flow, which already opens a picker when
 * the document has never been saved. */
export function confirmCloseUnsaved(options: CloseUnsavedOptions = {}): Promise<CloseUnsavedChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-unsaved-close-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'pmd-unsaved-close-title');

    const header = document.createElement('div');
    header.id = 'pmd-unsaved-close-title';
    header.className = 'pmd-unsaved-close-title';
    header.textContent = options.title ?? 'Save changes to this file?';
    dialog.appendChild(header);

    const cleanup = (): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };

    const resolveChoice = (choice: CloseUnsavedChoice): void => {
      cleanup();
      resolve(choice);
    };

    const locationWrap = document.createElement('div');
    locationWrap.className = 'pmd-unsaved-location';
    const locationLabel = document.createElement('div');
    locationLabel.className = 'pmd-unsaved-location-label';
    locationLabel.textContent = 'Choose a Location';
    locationWrap.appendChild(locationLabel);
    const locationButton = document.createElement('button');
    locationButton.type = 'button';
    locationButton.className = 'pmd-unsaved-location-button';
    const locationMain = document.createElement('span');
    locationMain.className = 'pmd-unsaved-location-main';
    const locationIcon = document.createElement('span');
    locationIcon.className = 'pmd-unsaved-location-icon';
    locationIcon.setAttribute('aria-hidden', 'true');
    locationMain.appendChild(locationIcon);
    const locationText = document.createElement('span');
    locationText.className = 'pmd-unsaved-location-text';
    setLocationDisplay(locationText, options.locationLabel);
    locationMain.appendChild(locationText);
    locationButton.appendChild(locationMain);
    const locationChevron = document.createElement('span');
    locationChevron.className = 'pmd-unsaved-location-chevron';
    locationChevron.setAttribute('aria-hidden', 'true');
    locationChevron.textContent = 'v';
    locationButton.appendChild(locationChevron);
    let choosingLocation = false;
    locationButton.addEventListener('click', () => {
      if (!options.onChooseLocation || choosingLocation) return;
      choosingLocation = true;
      locationButton.disabled = true;
      Promise.resolve(options.onChooseLocation())
        .then((label) => {
          const trimmed = label?.trim();
          if (trimmed) setLocationDisplay(locationText, trimmed);
        })
        .catch((err) => {
          console.warn('Choose save location failed:', err);
        })
        .finally(() => {
          choosingLocation = false;
          locationButton.disabled = false;
          locationButton.focus();
        });
    });
    locationWrap.appendChild(locationButton);
    dialog.appendChild(locationWrap);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-unsaved-close-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pmd-unsaved-close-btn pmd-unsaved-close-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => resolveChoice('save'));
    buttons.appendChild(saveBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pmd-unsaved-close-btn';
    discardBtn.textContent = "Don't Save";
    discardBtn.addEventListener('click', () => resolveChoice('discard'));
    buttons.appendChild(discardBtn);

    dialog.appendChild(buttons);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-unsaved-close-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => resolveChoice('cancel'));
    buttons.appendChild(cancel);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        resolveChoice('cancel');
      }
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        resolveChoice('cancel');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === '1') {
        e.preventDefault();
        resolveChoice('save');
      } else if (e.key === '2') {
        e.preventDefault();
        resolveChoice('discard');
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}
