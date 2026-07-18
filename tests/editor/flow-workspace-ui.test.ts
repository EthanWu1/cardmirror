// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createRound } from '../../src/editor/flow/flow-model.js';
import { createFlowWorkspace } from '../../src/editor/flow/flow-workspace.js';

function key(target: EventTarget, keyName: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
}

describe('flow workspace UI', () => {
  it('shows bottom flow tabs without add-flow actions and hides row numbering', () => {
    const mount = document.createElement('div');
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange: vi.fn(),
    });

    expect(mount.querySelector('.cm-flow-tabs')).not.toBeNull();
    expect(mount.querySelector('.cm-flow-title')).toBeNull();
    expect(mount.querySelectorAll('.cm-flow-button')).toHaveLength(0);
    expect(mount.querySelector('.flowline-row-header')).toBeNull();
    expect(mount.querySelector('.flowline-row-header-corner')).toBeNull();
    expect(mount.querySelector<HTMLButtonElement>('.cm-flow-close')).toBeNull();

    workspace.destroy();
  });

  it('colors policy Block as a negative speech column', () => {
    const mount = document.createElement('div');
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'policy' }),
      onChange: vi.fn(),
    });

    const headers = Array.from(mount.querySelectorAll<HTMLElement>('.cm-flow-column-header'));
    expect(headers.map((header) => header.textContent)).toEqual([
      '1AC',
      '1NC',
      '2AC',
      'Block',
      '1AR',
      '2NR',
      '2AR',
    ]);
    expect(headers[3]?.classList.contains('speech-neg')).toBe(true);
    expect(headers[3]?.classList.contains('speech-aff')).toBe(false);

    workspace.destroy();
  });

  it('single click selects a cell, double click edits it, typing on a selection starts editing', () => {
    const mount = document.createElement('div');
    const onChange = vi.fn();
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange,
    });

    const first = mount.querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="0"][data-col="0"]')!;
    first.click();
    expect(first.classList.contains('is-selected')).toBe(true);
    expect(first.classList.contains('is-editing')).toBe(false);
    expect(first.querySelector('textarea')).toBeNull();

    first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(first.classList.contains('is-editing')).toBe(true);
    expect(first.querySelector('textarea')).not.toBeNull();

    first.querySelector('textarea')?.blur();
    const second = mount.querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="0"][data-col="1"]')!;
    second.click();
    key(second, 'A');
    expect(second.classList.contains('is-editing')).toBe(true);
    expect(second.querySelector('textarea')?.value).toBe('A');
    expect(onChange).toHaveBeenCalled();

    workspace.destroy();
  });

  it('Enter and arrow keys move the selected flow cell instead of inserting text', () => {
    const mount = document.createElement('div');
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange: vi.fn(),
    });

    const first = mount.querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="0"][data-col="0"]')!;
    first.click();
    key(first, 'Enter');
    expect(
      mount
        .querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="1"][data-col="0"]')
        ?.classList.contains('is-selected'),
    ).toBe(true);

    const down = mount.querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="1"][data-col="0"]')!;
    key(down, 'ArrowRight');
    expect(
      mount
        .querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="1"][data-col="1"]')
        ?.classList.contains('is-selected'),
    ).toBe(true);

    workspace.destroy();
  });

  it('colors speech columns by A/N labels and removes browser focus outlines from arrow navigation', () => {
    const mount = document.createElement('div');
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange: vi.fn(),
    });

    const headers = Array.from(mount.querySelectorAll<HTMLElement>('.cm-flow-column-header'));
    expect(headers.map((header) => header.classList.contains('speech-aff'))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(headers.map((header) => header.classList.contains('speech-neg'))).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(mount.querySelector('td.flowline-cell.speech-aff')).not.toBeNull();
    expect(mount.querySelector('td.flowline-cell.speech-neg')).not.toBeNull();

    workspace.destroy();
  });

  it('uses the first written cell as the tab title and can delete an empty flow without confirmation', () => {
    const mount = document.createElement('div');
    const confirmDeleteFlow = vi.fn();
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange: vi.fn(),
      onConfirmDeleteFlow: confirmDeleteFlow,
    });

    const first = mount.querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="0"][data-col="0"]')!;
    first.click();
    key(first, 'T');
    const editor = first.querySelector<HTMLTextAreaElement>('textarea')!;
    editor.value = 'Theory shell';
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    expect(mount.querySelector('.cm-flow-tab .sheet-tab-label')?.textContent).toBe('Theory shell');

    workspace.addFlow('aff');
    expect(mount.querySelectorAll('.cm-flow-tab')).toHaveLength(3);
    const activeTab = mount.querySelector<HTMLButtonElement>('.cm-flow-tab[aria-selected="true"]')!;
    activeTab.querySelector<HTMLButtonElement>('.cm-flow-tab-close')!.click();

    expect(confirmDeleteFlow).not.toHaveBeenCalled();
    expect(mount.querySelectorAll('.cm-flow-tab')).toHaveLength(2);

    workspace.destroy();
  });

  it('reorders flows by dragging sheet tabs', () => {
    const mount = document.createElement('div');
    const onChange = vi.fn();
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange,
    });

    workspace.addFlow('aff');
    let tabs = Array.from(mount.querySelectorAll<HTMLButtonElement>('.cm-flow-tab'));
    expect(tabs.map((tab) => tab.querySelector('.sheet-tab-label')?.textContent)).toEqual([
      'AFF 1',
      'NEG 1',
      'AFF 2',
    ]);

    tabs[2]!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    tabs[0]!.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    tabs[0]!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

    expect(workspace.getRound().flows.map((flow) => flow.title)).toEqual(['AFF 2', 'AFF 1', 'NEG 1']);
    tabs = Array.from(mount.querySelectorAll<HTMLButtonElement>('.cm-flow-tab'));
    expect(tabs.map((tab) => tab.querySelector('.sheet-tab-label')?.textContent)).toEqual([
      'AFF 2',
      'AFF 1',
      'NEG 1',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(onChange).toHaveBeenCalled();

    workspace.destroy();
  });

  it('confirms before deleting a non-empty flow tab', async () => {
    const mount = document.createElement('div');
    const confirmDeleteFlow = vi.fn(async () => true);
    const workspace = createFlowWorkspace({
      mount,
      round: createRound({ format: 'ld' }),
      onChange: vi.fn(),
      onConfirmDeleteFlow: confirmDeleteFlow,
    });

    const first = mount.querySelector<HTMLTableCellElement>('td.flowline-cell[data-row="0"][data-col="0"]')!;
    first.click();
    key(first, 'A');

    mount.querySelector<HTMLButtonElement>('.cm-flow-tab-close')!.click();
    await Promise.resolve();

    expect(confirmDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mount.querySelectorAll('.cm-flow-tab')).toHaveLength(1);

    workspace.destroy();
  });
});
