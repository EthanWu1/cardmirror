// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { showPaneRouteOverlay, type PaneRouteSlot } from '../../src/editor/pane-route-overlay.js';

type SlotId = 'slot1' | 'slot2' | 'slot3';

function slots(stackCounts: [number, number, number]): PaneRouteSlot<SlotId>[] {
  return stackCounts.map((stackCount, index) => ({
    id: `slot${index + 1}` as SlotId,
    label: String(index + 1),
    filename: stackCount > 0 ? `Doc ${index + 1}` : '',
    stackCount,
  }));
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove(
    'pmd-pane-route-active',
    'pmd-pane-route-preview-left',
    'pmd-pane-route-preview-right',
  );
});

describe('pane route overlay', () => {
  function ruleBody(selector: string): string {
    const styleSource = fs.readFileSync(path.resolve(process.cwd(), 'src/editor/style.css'), 'utf8');
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(styleSource);
    if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
    return match[1];
  }

  it('keeps open separate the same compact size as cancel', () => {
    const styleSource = fs.readFileSync(path.resolve(process.cwd(), 'src/editor/style.css'), 'utf8');
    const separateRule = styleSource.match(/\.pmd-pane-route-separate\s*\{[^}]*\}/)?.[0] ?? '';
    expect(separateRule).not.toContain('min-height');
    expect(separateRule).not.toContain('padding: 0 14px');
    expect(separateRule).not.toContain('font: 600');
    expect(styleSource).toContain('.pmd-route-cancel.pmd-pane-route-separate');
  });

  it('styles the three pane picker as connected number panels', () => {
    const styleSource = fs.readFileSync(path.resolve(process.cwd(), 'src/editor/style.css'), 'utf8');
    const numberRule = ruleBody('.pmd-pane-route-number');
    expect(styleSource).toContain('.pmd-pane-route-slots {');
    expect(styleSource).toContain('gap: 0;');
    expect(styleSource).toContain('border-radius: 0;');
    expect(numberRule).toContain('display: block;');
    expect(numberRule).toContain('border: 0;');
    expect(numberRule).toContain('font-size: 2.25rem;');
    expect(numberRule).not.toContain('border-radius: 999px;');
  });

  it('renders a compact three-panel route dialog with open separate', async () => {
    const choicePromise = showPaneRouteOverlay({
      filename: 'Evidence.cmir',
      slots: slots([1, 0, 0]),
      activeSlotId: 'slot1',
      allowSeparate: true,
    });

    expect(document.querySelector('.pmd-route-overlay')).not.toBeNull();
    expect(document.querySelector('.pmd-pane-route-dialog')).not.toBeNull();
    expect(document.querySelector('.pmd-pane-route-blur-layer')).toBeNull();
    expect(document.querySelectorAll('.pmd-pane-route-slot')).toHaveLength(3);
    expect(document.querySelector('.pmd-pane-route-edge-left')).toBeNull();
    expect(document.querySelector('.pmd-pane-route-edge-right')).toBeNull();
    expect(document.querySelector('.pmd-pane-route-card')).toBeNull();
    expect(document.querySelector('.pmd-pane-route-separate')).not.toBeNull();
    expect(document.querySelector('.pmd-pane-route-separate')?.classList.contains('pmd-route-cancel')).toBe(
      true,
    );
    expect(document.querySelector('.pmd-pane-route-close')).toBeNull();
    expect(document.body.classList.contains('pmd-pane-route-active')).toBe(false);

    const targets = Array.from(document.querySelectorAll<HTMLButtonElement>('.pmd-pane-route-slot'));
    expect(targets.map((target) => target.dataset['slot'])).toEqual(['slot1', 'slot2', 'slot3']);
    expect(targets.map((target) => target.textContent?.trim())).toEqual(['1Doc 1', '2', '3']);

    document.querySelector<HTMLButtonElement>('.pmd-pane-route-separate')!.click();
    await expect(choicePromise).resolves.toBe('separate');
  });

  it('lets users click an already-open pane to stack the routed item there', async () => {
    const choicePromise = showPaneRouteOverlay({
      filename: 'Evidence.cmir',
      slots: slots([1, 0, 1]),
      activeSlotId: 'slot2',
      allowSeparate: true,
    });

    const targets = Array.from(document.querySelectorAll<HTMLButtonElement>('.pmd-pane-route-slot'));
    expect(targets.map((target) => target.dataset['slot'])).toEqual(['slot1', 'slot2', 'slot3']);
    expect(targets[0]?.getAttribute('aria-label')).toBe('Open Evidence.cmir into pane 1');
    targets[0]?.click();

    await expect(choicePromise).resolves.toBe('slot1');
  });

  it('uses the same three-panel dialog for an empty workspace and keeps cancel available', async () => {
    const choicePromise = showPaneRouteOverlay({
      filename: 'Evidence.cmir',
      slots: slots([0, 0, 0]),
      activeSlotId: null,
      allowSeparate: true,
    });

    expect(document.querySelector('.pmd-route-overlay')).not.toBeNull();
    expect(document.querySelector('.pmd-pane-route-dialog')).not.toBeNull();
    expect(document.querySelector('.pmd-pane-route-blur-layer')).toBeNull();
    expect(document.querySelector('.pmd-pane-route-edge-left')).toBeNull();
    expect(document.querySelector('.pmd-pane-route-edge-right')).toBeNull();
    expect(document.querySelector('.pmd-pane-route-separate')).not.toBeNull();
    expect(document.querySelector('.pmd-pane-route-card')).toBeNull();
    const close = document.querySelector<HTMLButtonElement>('.pmd-pane-route-close');
    expect(close).toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(choicePromise).resolves.toBeNull();
  });

  it('routes number keys to panel slots', async () => {
    const choicePromise = showPaneRouteOverlay({
      filename: 'Evidence.cmir',
      slots: slots([1, 0, 1]),
      activeSlotId: 'slot2',
      allowSeparate: true,
    });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));

    await expect(choicePromise).resolves.toBe('slot3');
  });

  it('resolves null when the overlay is removed externally', async () => {
    const choicePromise = showPaneRouteOverlay({
      filename: 'Evidence.cmir',
      slots: slots([1, 0, 0]),
      activeSlotId: 'slot1',
      allowSeparate: false,
    });

    const overlay = document.querySelector<HTMLElement>('.pmd-route-overlay')!;

    overlay.remove();
    await Promise.resolve();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));

    expect(document.body.classList.contains('pmd-pane-route-preview-left')).toBe(false);
    expect(document.body.classList.contains('pmd-pane-route-preview-right')).toBe(false);
    await expect(choicePromise).resolves.toBeNull();
  });
});
