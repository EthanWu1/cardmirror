import {
  addFlow as addFlowToRound,
  deleteFlow as deleteFlowFromRound,
  normalizeRound,
  reorderFlow as reorderFlowInRound,
  setCellText,
  type FlowFormat,
  type FlowRound,
  type FlowSide,
  type FlowSheet,
} from './flow-model.js';

export interface FlowWorkspace {
  readonly element: HTMLElement;
  getRound(): FlowRound;
  setRound(round: FlowRound): void;
  addFlow(side: FlowSide): void;
  find(query: string): void;
  setZoom(zoom: number): void;
  focus(): void;
  destroy(): void;
}

export interface FlowWorkspaceOptions {
  mount: HTMLElement;
  round: FlowRound;
  onChange: (round: FlowRound) => void;
  onRequestSave?: () => void;
  onRequestClose?: () => void;
  onConfirmDeleteFlow?: (title: string) => boolean | Promise<boolean>;
}

export function defaultFlowName(format: FlowFormat): string {
  return `${format}.cmflow`;
}

export function createFlowWorkspace(opts: FlowWorkspaceOptions): FlowWorkspace {
  let round = normalizeRound(opts.round);
  let activeFlowId = round.flows[0]?.id ?? '';
  const activeCells = new Map<string, { row: number; col: number }>();
  let findText = '';
  let draggingFlowId: string | null = null;
  let destroyed = false;

  const root = document.createElement('div');
  root.className = 'cm-flow-workspace';
  applyZoomVariable();
  opts.mount.replaceChildren(root);

  function activeFlow(): FlowSheet | undefined {
    return round.flows.find((flow) => flow.id === activeFlowId) ?? round.flows[0];
  }

  function applyZoomVariable(): void {
    root.style.setProperty('--cm-flow-zoom', `${round.settings.zoomPercent}%`);
  }

  function emit(nextRound: FlowRound): void {
    if (destroyed) return;
    round = nextRound;
    ensureActiveFlow();
    applyZoomVariable();
    opts.onChange(round);
  }

  function touchRound(nextRound: FlowRound): FlowRound {
    return { ...nextRound, updatedAt: new Date().toISOString() };
  }

  function ensureActiveFlow(): void {
    if (round.flows.some((flow) => flow.id === activeFlowId)) return;
    activeFlowId = round.flows[0]?.id ?? '';
  }

  function activeCellFor(flow: FlowSheet): { row: number; col: number } {
    const stored = activeCells.get(flow.id);
    const maxRow = Math.max(0, flow.rows.length - 1);
    const maxCol = Math.max(0, flow.columns.length - 1);
    return {
      row: Math.min(Math.max(0, stored?.row ?? 0), maxRow),
      col: Math.min(Math.max(0, stored?.col ?? 0), maxCol),
    };
  }

  function setActiveCell(flowId: string, row: number, col: number): void {
    activeCells.set(flowId, { row, col });
    root.querySelectorAll<HTMLElement>('td.flowline-cell.is-active, td.flowline-cell.is-selected').forEach((cell) => {
      cell.classList.remove('is-active', 'is-selected');
    });

    const escape = globalThis.CSS?.escape ?? ((value: string) => value.replace(/"/g, '\\"'));
    const selector = `td.flowline-cell[data-flow-id="${escape(flowId)}"][data-row="${row}"][data-col="${col}"]`;
    const td = root.querySelector<HTMLElement>(selector);
    td?.classList.add('is-active', 'is-selected');
    positionSelectionFrame(td);
  }

  function positionSelectionFrame(td: HTMLElement | null): void {
    const frame = root.querySelector<HTMLElement>('.selection-frame');
    if (!frame) return;
    if (!td) {
      frame.classList.remove('is-visible');
      return;
    }

    const left = td.offsetLeft;
    const top = td.offsetTop;
    frame.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
    frame.style.width = `${td.offsetWidth || 1}px`;
    frame.style.height = `${td.offsetHeight || 1}px`;
    frame.classList.add('is-visible');
  }

  function render(): void {
    if (destroyed) return;
    ensureActiveFlow();

    root.replaceChildren(renderShell());
  }

  function renderShell(): HTMLElement {
    const shell = document.createElement('div');
    shell.className = 'flowline-shell';

    const workspaceEl = document.createElement('main');
    workspaceEl.className = 'flowline-workspace';

    const flowSection = document.createElement('section');
    flowSection.className = 'flowline-flow';
    flowSection.setAttribute('aria-label', 'Debate flow');

    const find = document.createElement('div');
    find.className = 'flow-find cm-flow-find';
    find.setAttribute('role', 'search');
    find.setAttribute('aria-live', 'polite');
    find.textContent = findLabel();
    flowSection.appendChild(find);

    flowSection.appendChild(renderSheetFrame());
    flowSection.appendChild(renderSheetTabs());
    workspaceEl.appendChild(flowSection);
    shell.appendChild(workspaceEl);
    return shell;
  }

  function renderSheetTabs(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'sheet-tabs cm-flow-toolbar';
    toolbar.setAttribute('aria-label', 'Flow sheets');

    const tabs = document.createElement('div');
    tabs.className = 'flow-tabs cm-flow-tabs';
    tabs.setAttribute('role', 'tablist');
    round.flows.forEach((flow) => {
      const tab = document.createElement('button');
      tab.className = `sheet-tab cm-flow-tab side-${flow.side}`;
      tab.type = 'button';
      tab.draggable = true;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', flow.id === activeFlowId ? 'true' : 'false');
      tab.dataset.flowId = flow.id;

      const label = document.createElement('span');
      label.className = 'sheet-tab-label';
      label.textContent = displayFlowTitle(flow);
      tab.appendChild(label);

      const close = document.createElement('button');
      close.className = 'cm-flow-tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', `Delete ${displayFlowTitle(flow)} flow`);
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void deleteFlowTab(flow.id);
      });
      tab.appendChild(close);

      tab.addEventListener('click', () => {
        if (destroyed) return;
        activeFlowId = flow.id;
        render();
      });
      tab.addEventListener('dragstart', (event) => {
        if (destroyed) return;
        draggingFlowId = flow.id;
        tab.classList.add('is-dragging');
        event.dataTransfer?.setData('text/plain', flow.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      tab.addEventListener('dragend', () => {
        draggingFlowId = null;
        tab.classList.remove('is-dragging');
      });
      tab.addEventListener('dragover', (event) => {
        if (!draggingFlowId || draggingFlowId === flow.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        tab.classList.add('is-drop-target');
      });
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('is-drop-target');
      });
      tab.addEventListener('drop', (event) => {
        if (destroyed) return;
        event.preventDefault();
        tab.classList.remove('is-drop-target');
        const draggedId = event.dataTransfer?.getData('text/plain') || draggingFlowId;
        draggingFlowId = null;
        if (!draggedId || draggedId === flow.id) return;
        const targetIndex = round.flows.findIndex((item) => item.id === flow.id);
        if (targetIndex < 0) return;
        activeFlowId = draggedId;
        emit(touchRound(reorderFlowInRound(round, draggedId, targetIndex)));
        render();
      });
      tabs.appendChild(tab);
    });
    toolbar.appendChild(tabs);

    return toolbar;
  }

  function displayFlowTitle(flow: FlowSheet): string {
    for (const row of flow.rows) {
      for (const cell of row) {
        const text = cell?.text?.replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 60);
      }
    }
    return flow.title;
  }

  function flowHasContent(flow: FlowSheet): boolean {
    return flow.rows.some((row) => row.some((cell) => Boolean(cell?.text?.trim())));
  }

  async function deleteFlowTab(flowId: string): Promise<void> {
    if (destroyed || round.flows.length <= 1) return;
    const latestFlow = round.flows.find((flow) => flow.id === flowId);
    if (!latestFlow) return;
    if (flowHasContent(latestFlow)) {
      const title = displayFlowTitle(latestFlow);
      const confirmed = opts.onConfirmDeleteFlow
        ? await opts.onConfirmDeleteFlow(title)
        : Boolean(globalThis.confirm?.(`Delete "${title}"?`));
      if (!confirmed || destroyed) return;
    }
    const currentIndex = round.flows.findIndex((item) => item.id === flowId);
    const fallbackFlow = round.flows[currentIndex + 1] ?? round.flows[currentIndex - 1] ?? round.flows[0];
    if (activeFlowId === flowId) activeFlowId = fallbackFlow?.id ?? '';
    emit(touchRound(deleteFlowFromRound(round, flowId)));
    render();
  }

  function updateFlowTabLabels(): void {
    round.flows.forEach((flow) => {
      const escape = globalThis.CSS?.escape ?? ((value: string) => value.replace(/"/g, '\\"'));
      const label = root.querySelector<HTMLElement>(
        `.cm-flow-tab[data-flow-id="${escape(flow.id)}"] .sheet-tab-label`,
      );
      if (label) label.textContent = displayFlowTitle(flow);
    });
  }

  function speechSideForLabel(label: string): FlowSide | null {
    const upper = label.toUpperCase();
    if (/\bBLOCKS?\b/.test(upper)) return 'neg';
    if (upper.includes('N')) return 'neg';
    if (upper.includes('A')) return 'aff';
    return null;
  }

  function speechClassForLabel(label: string): string {
    const side = speechSideForLabel(label);
    return side ? `speech-${side}` : '';
  }

  function findLabel(): string {
    return findText ? `Find: ${findText}` : 'Find:';
  }

  function updateFindFeedback(): void {
    root.querySelector<HTMLElement>('.cm-flow-find')?.replaceChildren(findLabel());
  }

  function renderSheetFrame(): HTMLElement {
    const flow = activeFlow();
    const frame = document.createElement('div');
    frame.className = 'sheet-frame';
    if (!flow) return frame;
    const sheet = flow;

    frame.style.setProperty('--cm-flow-column-count', String(sheet.columns.length));
    frame.style.setProperty('--column-count', String(sheet.columns.length));
    const flowTitle = sheet.title;

    const table = document.createElement('table');
    table.className = 'flowline-sheet cm-flow-grid';
    table.setAttribute('aria-label', `${flowTitle} sheet`);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    sheet.columns.forEach((column) => {
      const header = document.createElement('th');
      header.className = ['cm-flow-column-header', sheet.side, speechClassForLabel(column.label)]
        .filter(Boolean)
        .join(' ');
      header.scope = 'col';
      header.textContent = column.label;
      headerRow.appendChild(header);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    type EditorTarget = {
      flowId: string;
      row: number;
      col: number;
      td: HTMLTableCellElement;
      value: HTMLElement;
    };

    const tbody = document.createElement('tbody');
    const active = activeCellFor(sheet);
    const editor = document.createElement('textarea');
    editor.className = 'cell-editor cm-flow-cell';
    editor.rows = 1;
    let editorTarget: EditorTarget | undefined;
    const targetByKey = new Map<string, EditorTarget>();

    function targetKey(row: number, col: number): string {
      return `${row}:${col}`;
    }

    function activeTarget(): EditorTarget | undefined {
      const current = activeCellFor(sheet);
      return targetByKey.get(targetKey(current.row, current.col));
    }

    function commitText(target: EditorTarget, text: string): void {
      const next = setCellText(round, target.flowId, target.row, target.col, text);
      emit(next);
      target.value.textContent = text;
      updateFlowTabLabels();
    }

    function stopEditing(): void {
      if (!editorTarget) return;
      editorTarget.td.classList.remove('is-editing');
      if (editor.parentElement) editor.remove();
      editorTarget = undefined;
    }

    function focusCell(target: EditorTarget): void {
      try {
        target.td.focus({ preventScroll: true });
      } catch {
        target.td.focus();
      }
    }

    function selectTarget(target: EditorTarget, focus = true): void {
      if (destroyed) return;
      if (editorTarget?.td !== target.td) stopEditing();
      setActiveCell(sheet.id, target.row, target.col);
      if (focus) focusCell(target);
    }

    function startEditing(target: EditorTarget, initialText?: string): void {
      if (destroyed) return;
      if (editorTarget?.td !== target.td) stopEditing();
      editorTarget = target;
      editor.value = initialText ?? target.value.textContent ?? '';
      editor.setAttribute('aria-label', `${flowTitle} row ${target.row + 1} column ${target.col + 1}`);
      target.td.classList.add('is-editing');
      target.td.appendChild(editor);
      setActiveCell(sheet.id, target.row, target.col);
      if (initialText !== undefined) commitText(target, editor.value);
      try {
        editor.focus({ preventScroll: true });
      } catch {
        editor.focus();
      }
      const end = editor.value.length;
      editor.setSelectionRange(end, end);
    }

    function moveSelection(rowDelta: number, colDelta: number): void {
      const target = editorTarget ?? activeTarget();
      if (!target) return;
      stopEditing();
      const row = Math.min(Math.max(0, target.row + rowDelta), Math.max(0, sheet.rows.length - 1));
      const col = Math.min(Math.max(0, target.col + colDelta), Math.max(0, sheet.columns.length - 1));
      const next = targetByKey.get(targetKey(row, col));
      if (next) selectTarget(next);
    }

    function isPrintable(event: KeyboardEvent): boolean {
      return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    }

    function handleNavigationKey(event: KeyboardEvent): boolean {
      if (event.key === 'Enter') {
        event.preventDefault();
        moveSelection(event.shiftKey ? -1 : 1, 0);
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        moveSelection(0, event.shiftKey ? -1 : 1);
        return true;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1, 0);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1, 0);
        return true;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveSelection(0, 1);
        return true;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveSelection(0, -1);
        return true;
      }
      return false;
    }

    sheet.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      sheet.columns.forEach((column, colIndex) => {
        const cell = row[colIndex];
        const td = document.createElement('td');
        td.className = ['flowline-cell', sheet.side, speechClassForLabel(column.label)].filter(Boolean).join(' ');
        td.dataset.flowId = sheet.id;
        td.dataset.row = String(rowIndex);
        td.dataset.col = String(colIndex);
        td.tabIndex = 0;
        if (active.row === rowIndex && active.col === colIndex) td.classList.add('is-active', 'is-selected');

        const value = document.createElement('div');
        value.className = 'cell-value';
        value.textContent = cell?.text ?? '';
        if (cell?.bold) value.classList.add('is-bold');
        td.appendChild(value);

        const target = { flowId: sheet.id, row: rowIndex, col: colIndex, td, value };
        targetByKey.set(targetKey(rowIndex, colIndex), target);
        td.addEventListener('click', () => selectTarget(target));
        td.addEventListener('dblclick', (event) => {
          event.preventDefault();
          startEditing(target);
        });
        td.addEventListener('focus', () => {
          if (editorTarget?.td === td) return;
          selectTarget(target, false);
        });
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.addEventListener('keydown', (event) => {
      if (destroyed || event.target === editor) return;
      const target = activeTarget();
      if (!target) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        opts.onRequestSave?.();
        return;
      }
      if (handleNavigationKey(event)) return;
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        commitText(target, '');
        return;
      }
      if (isPrintable(event)) {
        event.preventDefault();
        startEditing(target, event.key);
      }
    });
    editor.addEventListener('input', () => {
      if (destroyed || !editorTarget || !root.contains(editorTarget.td)) return;
      commitText(editorTarget, editor.value);
    });
    editor.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (destroyed) return;
        event.preventDefault();
        opts.onRequestSave?.();
        return;
      }
      handleNavigationKey(event);
    });

    table.appendChild(tbody);
    frame.appendChild(table);

    const selection = document.createElement('div');
    selection.className = 'selection-frame';
    frame.appendChild(selection);
    queueMicrotask(() => {
      if (destroyed) return;
      const current = activeCellFor(sheet);
      setActiveCell(sheet.id, current.row, current.col);
    });
    return frame;
  }

  const workspace: FlowWorkspace = {
    element: root,
    getRound() {
      return round;
    },
    setRound(nextRound: FlowRound) {
      if (destroyed) return;
      round = normalizeRound(nextRound);
      ensureActiveFlow();
      applyZoomVariable();
      render();
    },
    addFlow(side: FlowSide) {
      if (destroyed) return;
      const next = addFlowToRound(round, side);
      const added = next.flows.at(-1);
      if (added) activeFlowId = added.id;
      emit(next);
      render();
    },
    find(query: string) {
      if (destroyed) return;
      findText = String(query ?? '');
      updateFindFeedback();
    },
    setZoom(zoom: number) {
      if (destroyed) return;
      const next = touchRound(
        normalizeRound({
          ...round,
          settings: { ...round.settings, zoomPercent: zoom },
        }),
      );
      emit(next);
      render();
    },
    focus() {
      if (destroyed) return;
      const target =
        root.querySelector<HTMLElement>('.cm-flow-tab, .cm-flow-cell, button');
      target?.focus();
    },
    destroy() {
      destroyed = true;
      if (root.parentElement === opts.mount) root.remove();
      root.replaceChildren();
    },
  };

  render();
  return workspace;
}
