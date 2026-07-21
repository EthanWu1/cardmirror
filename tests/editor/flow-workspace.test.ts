// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRound, setCellText } from '../../src/editor/flow/flow-model.js';
import { createFlowWorkspace, defaultFlowName } from '../../src/editor/flow/flow-workspace.js';
import type { FlowRound } from '../../src/editor/flow/flow-model.js';

const flowWorkspaceCss = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'flow', 'flow-workspace.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(flowWorkspaceCss);
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
}

function declarationValue(selector: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^;]+);`).exec(ruleBody(selector));
  if (!match?.[1]) throw new Error(`missing CSS declaration: ${selector} { ${property}: ... }`);
  return match[1];
}

function mountWorkspace(round: FlowRound = createRound({ format: 'ld', title: 'Round' })) {
  const mount = document.createElement('div');
  const stale = document.createElement('p');
  stale.textContent = 'stale';
  mount.appendChild(stale);
  document.body.appendChild(mount);

  const onChange = vi.fn();
  const onRequestSave = vi.fn();
  const onRequestClose = vi.fn();
  const workspace = createFlowWorkspace({ mount, round, onChange, onRequestSave, onRequestClose });
  return { mount, onChange, onRequestSave, onRequestClose, round, workspace };
}

function input(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('flow workspace', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses CardMirror Flow workspace shell class names', () => {
    const { workspace } = mountWorkspace();

    expect(workspace.element.matches('.cm-flow-workspace')).toBe(true);
    expect(workspace.element.querySelector('.flowline-shell')).not.toBeNull();
    expect(workspace.element.querySelector('.flowline-workspace')).not.toBeNull();
    expect(workspace.element.querySelector('table.flowline-sheet')).not.toBeNull();
    expect(workspace.element.querySelector('.sheet-tabs')).not.toBeNull();
    expect(workspace.element.querySelector('.selection-frame')).not.toBeNull();
  });

  it('renders tabs, Flowline table, and cells; editing a cell updates the round and calls onChange', () => {
    const round = createRound({ format: 'ld', title: 'Harvard RR' });
    const { mount, onChange, workspace } = mountWorkspace(round);

    expect(mount.children).toHaveLength(1);
    expect(mount.firstElementChild).toBe(workspace.element);
    expect(workspace.element.classList.contains('cm-flow-workspace')).toBe(true);
    expect(workspace.element.querySelector('.cm-flow-toolbar')).not.toBeNull();
    expect(workspace.element.querySelector<HTMLInputElement>('.cm-flow-title')).toBeNull();
    expect([...workspace.element.querySelectorAll('.cm-flow-tab')].map((tab) => tab.textContent?.trim())).toEqual([
      'AFF 1',
      'NEG 1',
    ]);
    expect(workspace.element.querySelector('.cm-flow-grid.flowline-sheet')).not.toBeNull();
    expect([...workspace.element.querySelectorAll('.cm-flow-column-header')].map((cell) => cell.textContent)).toEqual([
      '1AC',
      '1NC',
      '1AR',
      '2NR',
      '2AR',
    ]);
    expect(workspace.element.querySelectorAll('tbody .cell-value')).toHaveLength(
      round.settings.rowCount * round.flows[0]!.columns.length,
    );
    expect(workspace.element.querySelectorAll('.flowline-row-header')).toHaveLength(0);
    expect(workspace.element.querySelectorAll('.cell-editor.cm-flow-cell')).toHaveLength(0);

    const firstCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    firstCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = firstCell.querySelector<HTMLTextAreaElement>('.cm-flow-cell')!;
    input(editor, 'plan text');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('plan text');
    expect(onChange).toHaveBeenLastCalledWith(workspace.getRound());
    expect(workspace.element.querySelector('.cell-value')?.textContent).toBe('plan text');
  });

  it('marks a clicked table cell active and exposes a selection frame', () => {
    const { workspace } = mountWorkspace();
    const firstCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;

    firstCell.click();

    expect(firstCell.classList.contains('is-active')).toBe(true);
    expect(firstCell.classList.contains('is-selected')).toBe(true);
    expect(firstCell.classList.contains('is-editing')).toBe(false);
    expect(firstCell.dataset.row).toBe('0');
    expect(firstCell.dataset.col).toBe('0');
    expect(workspace.element.querySelector('.selection-frame')?.classList.contains('is-visible')).toBe(true);
  });

  it('keeps first click as selection and starts editing when typing into the selected cell', () => {
    const { onChange, workspace } = mountWorkspace();
    const targetCell = workspace.element.querySelectorAll<HTMLTableCellElement>('td.flowline-cell')[1]!;

    targetCell.click();
    expect(workspace.element.querySelector('.cell-editor.cm-flow-cell')).toBeNull();
    targetCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    const editor = targetCell.querySelector<HTMLTextAreaElement>('.cell-editor.cm-flow-cell')!;
    input(editor, 'cross ex');

    expect(document.activeElement).toBe(editor);
    expect(workspace.element.querySelectorAll('.cell-editor.cm-flow-cell')).toHaveLength(1);
    expect(targetCell.contains(editor)).toBe(true);
    expect(workspace.getRound().flows[0]!.rows[0]![1]!.text).toBe('cross ex');
    expect(targetCell.querySelector('.cell-value')?.textContent).toBe('cross ex');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps a started cell editor live across continued typing', () => {
    const { onChange, workspace } = mountWorkspace();
    const targetCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;

    targetCell.click();
    targetCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
    const editor = targetCell.querySelector<HTMLTextAreaElement>('.cell-editor.cm-flow-cell')!;
    input(editor, 'plan');
    input(editor, 'plan text');

    expect(document.activeElement).toBe(editor);
    expect(targetCell.classList.contains('is-editing')).toBe(true);
    expect(workspace.element.querySelectorAll('.cell-editor.cm-flow-cell')).toHaveLength(1);
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('plan text');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('runs command methods for addFlow, zoom, find, and destroy', () => {
    const { mount, onChange, workspace } = mountWorkspace();

    workspace.addFlow('aff');
    expect(workspace.element.querySelectorAll('.cm-flow-tab')).toHaveLength(3);
    expect([...workspace.element.querySelectorAll('.cm-flow-tab')].map((tab) => tab.textContent?.trim())).toContain(
      'AFF 2',
    );

    workspace.setZoom(120);
    expect(workspace.element.style.getPropertyValue('--cm-flow-zoom')).toBe('120%');
    expect(workspace.getRound().settings.zoomPercent).toBe(120);
    expect(onChange).toHaveBeenCalledTimes(2);

    workspace.find('impact');
    expect(workspace.element.querySelector('.cm-flow-find')?.textContent).toContain('impact');
    expect(workspace.getRound().title).toBe('Round');

    workspace.focus();
    expect(document.activeElement).toBe(workspace.element.querySelector('.cm-flow-tab'));

    workspace.destroy();
    expect(mount.innerHTML).toBe('');
  });

  it('does not remove newer mount content when a stale workspace is destroyed', () => {
    const { mount, workspace } = mountWorkspace();
    const marker = document.createElement('div');
    marker.className = 'new-workspace-marker';
    marker.textContent = 'new content';
    mount.replaceChildren(marker);

    workspace.destroy();

    expect(mount.children).toHaveLength(1);
    expect(mount.firstElementChild).toBe(marker);
  });

  it('does not emit changes from public mutators after destroy', () => {
    const { mount, onChange, workspace } = mountWorkspace();
    const roundBeforeDestroy = workspace.getRound();

    workspace.destroy();
    expect(mount.innerHTML).toBe('');
    onChange.mockClear();

    workspace.addFlow('aff');
    workspace.setZoom(130);

    expect(onChange).not.toHaveBeenCalled();
    expect(workspace.getRound()).toBe(roundBeforeDestroy);
    expect(mount.innerHTML).toBe('');
  });

  it('does not run retained DOM callbacks after destroy', () => {
    const { onRequestClose, onRequestSave, workspace } = mountWorkspace();
    const targetCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const cell = workspace.element.querySelector<HTMLTextAreaElement>('.cm-flow-cell')!;
    cell.focus();
    const saveEvent = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });

    workspace.destroy();
    cell.blur();
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    cell.dispatchEvent(saveEvent);

    expect(onRequestSave).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(saveEvent.defaultPrevented).toBe(false);
  });

  it('updates a flow tab label from the first written cell', () => {
    const { onChange, workspace } = mountWorkspace();
    const targetCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    input(targetCell.querySelector<HTMLTextAreaElement>('.cm-flow-cell')!, 'Finals');

    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('Finals');
    expect(workspace.element.querySelector('.cm-flow-tab[aria-selected="true"] .sheet-tab-label')?.textContent).toBe(
      'Finals',
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(workspace.getRound());
  });

  it('touches round and flow metadata when cell text changes', () => {
    const stale = '2000-01-01T00:00:00.000Z';
    const round = { ...createRound({ format: 'ld', title: 'Round' }), updatedAt: stale };
    round.flows = round.flows.map((flow) => ({ ...flow, updatedAt: stale }));
    const { onChange, workspace } = mountWorkspace(round);
    const targetCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    input(targetCell.querySelector<HTMLTextAreaElement>('.cm-flow-cell')!, 'Finals');

    expect(workspace.getRound().updatedAt).not.toBe(stale);
    expect(workspace.getRound().flows[0]!.updatedAt).not.toBe(stale);
    expect(Date.parse(workspace.getRound().updatedAt)).toBeGreaterThan(Date.parse(stale));
    expect(onChange).toHaveBeenLastCalledWith(workspace.getRound());
  });

  it('touches round metadata when zoom changes', () => {
    const stale = '2000-01-01T00:00:00.000Z';
    const round = { ...createRound({ format: 'ld', title: 'Round' }), updatedAt: stale };
    const { onChange, workspace } = mountWorkspace(round);

    workspace.setZoom(130);

    expect(workspace.getRound().settings.zoomPercent).toBe(130);
    expect(workspace.getRound().updatedAt).not.toBe(stale);
    expect(Date.parse(workspace.getRound().updatedAt)).toBeGreaterThan(Date.parse(stale));
    expect(onChange).toHaveBeenLastCalledWith(workspace.getRound());
  });

  it('keeps flow tab labels compact when cell text has extra whitespace', () => {
    const { workspace } = mountWorkspace();
    const targetCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    input(targetCell.querySelector<HTMLTextAreaElement>('.cm-flow-cell')!, '  Finals   Round  ');

    expect(workspace.element.querySelector('.cm-flow-tab[aria-selected="true"] .sheet-tab-label')?.textContent).toBe(
      'Finals Round',
    );
  });

  it('updates find feedback without re-rendering the focused cell', () => {
    const { workspace } = mountWorkspace();
    workspace.element
      .querySelector<HTMLTableCellElement>('td.flowline-cell')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const cell = workspace.element.querySelector<HTMLTextAreaElement>('.cm-flow-cell')!;
    cell.focus();

    workspace.find('impact');

    expect(document.activeElement).toBe(cell);
    expect(workspace.element.querySelector('.cm-flow-find')?.textContent).toContain('impact');
  });

  it('uses Ctrl/Cmd+S in a cell for onRequestSave and prevents default', () => {
    const { onRequestSave, workspace } = mountWorkspace();
    const cell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    cell.click();
    const ctrlEvent = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    const metaEvent = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });

    cell.dispatchEvent(ctrlEvent);
    cell.dispatchEvent(metaEvent);

    expect(onRequestSave).toHaveBeenCalledTimes(2);
    expect(ctrlEvent.defaultPrevented).toBe(true);
    expect(metaEvent.defaultPrevented).toBe(true);
    expect(cell.querySelector('textarea')).toBeNull();
  });

  it('toggles cell bold with Ctrl/Cmd+B and persists it in the round', () => {
    const { workspace } = mountWorkspace();
    const cell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    cell.click();

    const boldEvent = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(boldEvent);

    expect(boldEvent.defaultPrevented).toBe(true);
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.bold).toBe(true);
    expect(cell.querySelector('.cell-value')!.classList.contains('is-bold')).toBe(true);

    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }));
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.bold).toBeUndefined();
    expect(cell.querySelector('.cell-value')!.classList.contains('is-bold')).toBe(false);
  });

  it('copies with Ctrl+C, cuts with Ctrl+X, and pastes TSV across cells with Ctrl+V', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const readText = vi.fn(() => Promise.resolve('resp one\tresp two'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText },
    });

    let round = createRound({ format: 'ld', title: 'Round' });
    round = setCellText(round, round.flows[0]!.id, 0, 0, 'aff case');
    const { workspace } = mountWorkspace(round);
    const cell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    cell.click();

    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(writeText).toHaveBeenCalledWith('aff case');

    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('');

    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('resp one');
    expect(workspace.getRound().flows[0]!.rows[0]![1]!.text).toBe('resp two');
    expect(workspace.element.querySelectorAll('.cell-value')[1]!.textContent).toBe('resp two');
  });

  it('opens the editor with F2 keeping existing text and exits with Escape', () => {
    let round = createRound({ format: 'ld', title: 'Round' });
    round = setCellText(round, round.flows[0]!.id, 0, 0, 'extend the DA');
    const { workspace } = mountWorkspace(round);
    const cell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    cell.click();

    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    const editor = cell.querySelector<HTMLTextAreaElement>('.cell-editor.cm-flow-cell')!;
    expect(editor).not.toBeNull();
    expect(editor.value).toBe('extend the DA');

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(cell.querySelector('.cell-editor')).toBeNull();
    expect(cell.classList.contains('is-editing')).toBe(false);
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('extend the DA');
  });

  it('inserts a line break with Alt+Enter instead of moving the selection', () => {
    const { workspace } = mountWorkspace();
    const cell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = cell.querySelector<HTMLTextAreaElement>('.cell-editor.cm-flow-cell')!;
    input(editor, 'line one');

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));

    expect(cell.querySelector('.cell-editor')).not.toBeNull();
    expect(editor.value).toBe('line one\n');
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('line one\n');
  });

  it('swaps to a new round with setRound and re-renders tabs and cells', () => {
    const { workspace } = mountWorkspace(createRound({ format: 'ld', title: 'LD' }));
    let nextRound = createRound({ format: 'pf', title: 'PF' });
    nextRound = setCellText(nextRound, nextRound.flows[1]!.id, 0, 0, 'neg case');

    workspace.setRound(nextRound);

    expect(workspace.element.querySelector<HTMLInputElement>('.cm-flow-title')).toBeNull();
    expect([...workspace.element.querySelectorAll('.cm-flow-tab')].map((tab) => tab.textContent?.trim())).toEqual([
      'AFF 1',
      'neg case',
    ]);
    expect([...workspace.element.querySelectorAll('.cm-flow-column-header')].map((cell) => cell.textContent)).toEqual([
      'AC',
      'NC',
      'AR',
      'NR',
      'AS',
      'NS',
      'AF',
      'NF',
    ]);

    workspace.element.querySelectorAll<HTMLButtonElement>('.cm-flow-tab')[1]!.click();
    const firstCell = workspace.element.querySelector<HTMLTableCellElement>('td.flowline-cell')!;
    expect(firstCell.querySelector('.cell-value')?.textContent).toBe('neg case');
    firstCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(firstCell.querySelector<HTMLTextAreaElement>('.cm-flow-cell')?.value).toBe('neg case');
  });

  it("returns stable .cmflow default names for each debate format", () => {
    expect(defaultFlowName('ld')).toBe('ld.cmflow');
    expect(defaultFlowName('pf')).toBe('pf.cmflow');
    expect(defaultFlowName('policy')).toBe('policy.cmflow');
  });

  it('keeps flow controls border-boxed and the tab strip in a shrinkable scroll track', () => {
    expect(ruleBody('.cm-flow-workspace, .cm-flow-workspace *')).toContain('box-sizing: border-box;');
    expect(ruleBody('.flowline-shell')).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(ruleBody('.flow-tabs')).toContain('min-width: 80px;');
    expect(ruleBody('.flow-tabs')).toContain('overflow-x: auto;');
  });

  it('uses floating Flow tabs instead of a heavy toolbar strip', () => {
    const toolbarBackground = declarationValue('.cm-flow-toolbar', 'background');
    expect(toolbarBackground).toBe('transparent');

    const toolbarBorder = declarationValue('.cm-flow-toolbar', 'border-color');
    expect(toolbarBorder).toBe('transparent');

    const activeAffBackground = declarationValue('.sheet-tab.side-aff[aria-selected="true"]', 'background');
    expect(activeAffBackground).toContain('var(--aff)');

    const activeNegBackground = declarationValue('.sheet-tab.side-neg[aria-selected="true"]', 'background');
    expect(activeNegBackground).toContain('var(--neg)');
  });

  it('overlays compact Flow tabs on top of the sheet without reserving a white strip', () => {
    expect(ruleBody('.flowline-sheet td:focus')).toContain('outline: none;');
    expect(ruleBody('.cm-flow-tab-close')).toContain('opacity: 0;');
    expect(ruleBody('.cm-flow-tab-close')).toContain('position: absolute;');
    expect(ruleBody('.cm-flow-tab-close')).toContain('pointer-events: none;');
    expect(ruleBody('.cm-flow-tab:hover .cm-flow-tab-close')).toContain('opacity: 1;');
    expect(ruleBody('.cm-flow-tab:hover .cm-flow-tab-close')).toContain('pointer-events: auto;');
    expect(ruleBody('.cm-flow-tab:hover .sheet-tab-label')).toContain('padding-right: 22px;');
    expect(declarationValue('.flowline-flow', 'grid-template-rows')).toBe('minmax(0, 1fr)');
    expect(ruleBody('.sheet-frame')).toContain('padding-bottom: 36px;');
    expect(ruleBody('.sheet-tabs')).toContain('background: transparent;');
    expect(ruleBody('.sheet-tabs')).toContain('position: absolute;');
    expect(ruleBody('.sheet-tabs')).toContain('left: 0;');
    expect(ruleBody('.sheet-tabs')).toContain('right: 0;');
    expect(ruleBody('.sheet-tabs')).toContain('bottom: 0;');
    expect(ruleBody('.sheet-tabs')).toContain('pointer-events: none;');
    expect(ruleBody('.flow-tabs')).toContain('pointer-events: auto;');
    expect(ruleBody('.flow-tabs')).toContain('overflow-y: visible;');
    // Segmented bar: the .flow-tabs GROUP carries the surface/border; the
    // tabs are flat segments inside it — no per-tab borders, fills, or
    // floating drop shadows (field feedback 2026-07-19, twice).
    expect(ruleBody('.flow-tabs')).toContain('border: 1px solid var(--line, #dcdcde);');
    expect(ruleBody('.flow-tabs')).toContain('border-radius: 7px;');
    expect(ruleBody('.sheet-tab')).toContain('background: transparent;');
    expect(ruleBody('.sheet-tab')).toContain('border-radius: 5px;');
    expect(ruleBody('.sheet-tab')).toContain('box-shadow: none;');
    expect(ruleBody('.sheet-tab:hover')).not.toContain('translateY');
    expect(ruleBody('.sheet-tab:hover')).toContain('box-shadow: none;');
  });

  it('uses a lighter gray for Flow column headers', () => {
    expect(ruleBody('.cm-flow-workspace')).toContain(
      '--header: color-mix(in srgb, var(--pmd-c-ribbon, #adadb0) 34%, #fff);',
    );
    expect(ruleBody('.flowline-sheet th')).toContain('background: var(--header);');
    expect(ruleBody('.flowline-row-header')).toContain('background: var(--header);');
  });
});
