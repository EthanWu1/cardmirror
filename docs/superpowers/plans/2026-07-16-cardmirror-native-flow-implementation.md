# CardMirror Native Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native CardMirror Flow workspace backed by `.cmflow` files and compatible with Verba Flowline JSON.

**Architecture:** Add a focused Flow model/file/UI module under `src/editor/flow/`, then integrate it through existing CardMirror host, home, ribbon, settings, single-pane, and multi-pane entry points. The old Windows Verbatim/Excel bridge remains available as legacy commands, while `createFlow` becomes the native CardMirror Flow command.

**Tech Stack:** TypeScript, DOM APIs, Vitest/jsdom, existing CardMirror host abstractions, existing ribbon/settings/home modules.

---

## File Map

- Create `src/editor/flow/flow-types.ts`: Flow data model types shared by codec, UI, settings, and pane state.
- Create `src/editor/flow/flow-model.ts`: Verba Flowline-compatible round creation and mutations.
- Create `src/editor/flow/flow-file.ts`: `.cmflow` wrapper parse/serialize and `.flowline.json` import/export.
- Create `src/editor/flow/flow-workspace.ts`: Native Flow DOM controller, selection, editing, copy/paste, find, zoom, dirty callback.
- Create `src/editor/flow/flow-workspace.css`: Flow-specific chrome and grid styles, imported by `src/editor/index.ts`.
- Modify `src/editor/file-search.ts`: include `.cmflow` in search format helpers.
- Modify `src/editor/recents-store.ts`: persist `.cmflow` recents.
- Modify `src/editor/home-screen.ts`: add sidebar `FLOW`, bottom `Flows` section, and search result rendering for `.cmflow`.
- Modify `src/editor/host/types.ts`: add `cmflow` to journal/format unions where a persisted editor file format is needed.
- Modify `src/editor/host/browser-host.ts`: accept `.cmflow` and `.flowline.json` picker/save filters.
- Modify `src/editor/host/electron-host.ts`: pass `.cmflow` and `.flowline.json` filters through unchanged.
- Modify `apps/desktop/src/main.ts`: recognize `.cmflow` in OS-open paths and recursive search.
- Modify `apps/desktop/src/preload.ts`: expose existing open/save plumbing unchanged; update comments and filter-facing types only if compile requires it.
- Modify `src/editor/ribbon-commands.ts`: add native Flow command IDs and keep legacy Excel bridge IDs separate.
- Modify `src/editor/ribbon-groups.ts`: place native Flow commands in Paperless/Flow group and legacy command in a legacy spot.
- Modify `src/editor/flow-port.ts`: rename exported Excel create function to `runCreateLegacyExcelFlow`.
- Modify `src/editor/settings.ts`: add Flow settings and move `flowHostOnLaunch` to the Flow category.
- Modify `src/editor/settings-categories.ts`: add `Flow` tab.
- Modify `src/editor/index.ts`: mount Flow in single-pane mode, route open/save/dirty/autosave/ribbon commands, and import `flow-workspace.css`.
- Modify `src/editor/multi-pane-shell.ts`: allow slots to hold Flow records and route create/open into slot or separate window.
- Modify `MANUAL.md`: add a short Flow section and clarify old Excel bridge behavior.
- Test files listed inside each task below.

## Pre-Flight

- [ ] **Step 1: Confirm the dirty tree before implementation**

Run:

```powershell
git status --short
```

Expected: existing user and generated changes are visible. Do not revert files outside the task being implemented.

- [ ] **Step 2: Keep Verba Flowline open as the behavior reference**

Read these files before Task 1:

```powershell
Get-Content C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\flowline-model.js
Get-Content C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\flowline-grid.js
Get-Content C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\flowline-store.js
Get-Content C:\Users\ethan\OneDrive\Desktop\verba\test\flowline-grid.test.js
```

Expected: the implementer can point to the source behavior for round defaults, columns, tabs, TSV paste, and bold range behavior.

### Task 1: Flow Model

**Files:**
- Create: `src/editor/flow/flow-types.ts`
- Create: `src/editor/flow/flow-model.ts`
- Test: `tests/editor/flow-model.test.ts`

- [ ] **Step 1: Write failing model tests**

Add `tests/editor/flow-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addFlow,
  copyRangeAsTsv,
  createRound,
  deleteFlow,
  pasteTsv,
  reorderFlow,
  setCellText,
  toggleBoldRange,
} from '../../src/editor/flow/flow-model.js';

describe('flow model', () => {
  it('creates a Verba-compatible LD round with two default flows and 40 rows', () => {
    const round = createRound({ format: 'ld', title: 'Unnamed1' });
    expect(round.title).toBe('Unnamed1');
    expect(round.format).toBe('ld');
    expect(round.flows.map((flow) => flow.title)).toEqual(['AFF 1', 'NEG 1']);
    expect(round.flows[0]?.rows).toHaveLength(40);
    expect(round.flows[0]?.columns.length).toBeGreaterThan(1);
  });

  it('adds, deletes, and reorders AFF and NEG flows', () => {
    let round = createRound({ format: 'policy', title: 'Round' });
    round = addFlow(round, 'aff');
    round = addFlow(round, 'neg');
    expect(round.flows.map((flow) => flow.title)).toEqual(['AFF 1', 'NEG 1', 'AFF 2', 'NEG 2']);

    round = reorderFlow(round, round.flows[2]!.id, 0);
    expect(round.flows[0]?.title).toBe('AFF 2');

    round = deleteFlow(round, round.flows[0]!.id);
    expect(round.flows.map((flow) => flow.title)).toEqual(['AFF 1', 'NEG 1', 'NEG 2']);
  });

  it('updates cells, copies TSV, pastes TSV, and toggles bold across a range', () => {
    let round = createRound({ format: 'ld', title: 'Round' });
    const flowId = round.flows[0]!.id;
    round = setCellText(round, flowId, 0, 0, 'link');
    round = setCellText(round, flowId, 0, 1, 'impact');
    expect(copyRangeAsTsv(round, { flowId, startRow: 0, startCol: 0, endRow: 0, endCol: 1 })).toBe('link\timpact');

    round = pasteTsv(round, { flowId, row: 1, col: 0 }, 'a\tb\nc\td');
    expect(round.flows[0]!.rows[1]![0]!.text).toBe('a');
    expect(round.flows[0]!.rows[2]![1]!.text).toBe('d');

    round = toggleBoldRange(round, { flowId, startRow: 1, startCol: 0, endRow: 2, endCol: 1 });
    expect(round.flows[0]!.rows[1]![0]!.bold).toBe(true);
    expect(round.flows[0]!.rows[2]![1]!.bold).toBe(true);
  });
});
```

- [ ] **Step 2: Run model tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/flow-model.test.ts
```

Expected: fail because `src/editor/flow/flow-model.ts` does not exist.

- [ ] **Step 3: Implement Flow types**

Create `src/editor/flow/flow-types.ts`:

```ts
export type FlowFormat = 'ld' | 'pf' | 'policy';
export type FlowSide = 'aff' | 'neg';

export interface FlowCell {
  text: string;
  bold?: boolean;
}

export interface FlowColumn {
  id: string;
  label: string;
  side: FlowSide;
}

export interface FlowSheet {
  id: string;
  title: string;
  side: FlowSide;
  columns: FlowColumn[];
  rows: FlowCell[][];
}

export interface FlowRoundSettings {
  rowCount: number;
  zoom: number;
  affColor: string;
  negColor: string;
  selectionColor: string;
}

export interface FlowRound {
  id: string;
  title: string;
  format: FlowFormat;
  settings: FlowRoundSettings;
  flows: FlowSheet[];
}

export interface FlowRange {
  flowId: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface FlowPoint {
  flowId: string;
  row: number;
  col: number;
}
```

- [ ] **Step 4: Implement Flow model functions**

Create `src/editor/flow/flow-model.ts` with these exported functions and keep the Verba column labels aligned with `flowline-model.js`:

```ts
import type { FlowCell, FlowFormat, FlowPoint, FlowRange, FlowRound, FlowSheet, FlowSide } from './flow-types.js';

const FLOWLINE_VERSION = 34;
const DEFAULT_ROW_COUNT = 40;

const FORMAT_COLUMNS: Record<FlowFormat, readonly string[]> = {
  ld: ['AC', 'NC', '1AR', 'NR', '2AR'],
  pf: ['Pro', 'Con', 'Summary', 'Final Focus'],
  policy: ['1AC', '1NC', '2AC', '2NC', '1NR', '1AR', '2NR', '2AR'],
};

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

function cloneRound(round: FlowRound): FlowRound {
  return {
    ...round,
    settings: { ...round.settings },
    flows: round.flows.map((flow) => ({
      ...flow,
      columns: flow.columns.map((column) => ({ ...column })),
      rows: flow.rows.map((row) => row.map((cell) => ({ ...cell }))),
    })),
  };
}

function blankRows(rowCount: number, columnCount: number): FlowCell[][] {
  return Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => ({ text: '' })),
  );
}

function makeFlow(format: FlowFormat, side: FlowSide, index: number): FlowSheet {
  const labels = FORMAT_COLUMNS[format];
  return {
    id: nextId(`flow-${side}`),
    title: `${side.toUpperCase()} ${index}`,
    side,
    columns: labels.map((label) => ({ id: nextId('col'), label, side })),
    rows: blankRows(DEFAULT_ROW_COUNT, labels.length),
  };
}

export function createRound(opts: { format: FlowFormat; title: string }): FlowRound {
  return {
    id: nextId('round'),
    title: opts.title,
    format: opts.format,
    settings: {
      rowCount: DEFAULT_ROW_COUNT,
      zoom: 1,
      affColor: '#dff3ff',
      negColor: '#ffe8e1',
      selectionColor: '#7db9e8',
    },
    flows: [makeFlow(opts.format, 'aff', 1), makeFlow(opts.format, 'neg', 1)],
  };
}

export function normalizeRound(input: unknown): FlowRound {
  if (!input || typeof input !== 'object') return createRound({ format: 'ld', title: 'Unnamed1' });
  const raw = input as Partial<FlowRound>;
  const format: FlowFormat = raw.format === 'pf' || raw.format === 'policy' ? raw.format : 'ld';
  const fallback = createRound({ format, title: typeof raw.title === 'string' && raw.title ? raw.title : 'Unnamed1' });
  const flows = Array.isArray(raw.flows) && raw.flows.length > 0 ? raw.flows : fallback.flows;
  return {
    ...fallback,
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : fallback.title,
    settings: { ...fallback.settings, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
    flows: flows.map((flow, index) => normalizeFlow(flow, format, index)),
  };
}

function normalizeFlow(input: unknown, format: FlowFormat, index: number): FlowSheet {
  const fallback = makeFlow(format, index % 2 === 0 ? 'aff' : 'neg', Math.floor(index / 2) + 1);
  if (!input || typeof input !== 'object') return fallback;
  const raw = input as Partial<FlowSheet>;
  const side: FlowSide = raw.side === 'neg' ? 'neg' : 'aff';
  const labels = Array.isArray(raw.columns) && raw.columns.length > 0
    ? raw.columns.map((column, colIndex) => {
        const label = column && typeof column === 'object' && typeof (column as { label?: unknown }).label === 'string'
          ? (column as { label: string }).label
          : FORMAT_COLUMNS[format][colIndex] ?? `Col ${colIndex + 1}`;
        return { id: nextId('col'), label, side };
      })
    : fallback.columns;
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : fallback.title,
    side,
    columns: labels,
    rows: Array.from({ length: Math.max(DEFAULT_ROW_COUNT, rows.length) }, (_, rowIndex) =>
      labels.map((_, colIndex) => {
        const cell = rows[rowIndex]?.[colIndex] as FlowCell | string | undefined;
        if (typeof cell === 'string') return { text: cell };
        if (cell && typeof cell === 'object') return { text: String(cell.text ?? ''), bold: cell.bold === true || undefined };
        return { text: '' };
      }),
    ),
  };
}

export function flowlineVersion(): number {
  return FLOWLINE_VERSION;
}

export function addFlow(round: FlowRound, side: FlowSide): FlowRound {
  const next = cloneRound(round);
  const count = next.flows.filter((flow) => flow.side === side).length + 1;
  next.flows.push(makeFlow(next.format, side, count));
  return next;
}

export function deleteFlow(round: FlowRound, flowId: string): FlowRound {
  const next = cloneRound(round);
  if (next.flows.length <= 1) return next;
  next.flows = next.flows.filter((flow) => flow.id !== flowId);
  return next;
}

export function reorderFlow(round: FlowRound, flowId: string, toIndex: number): FlowRound {
  const next = cloneRound(round);
  const fromIndex = next.flows.findIndex((flow) => flow.id === flowId);
  if (fromIndex < 0) return next;
  const [flow] = next.flows.splice(fromIndex, 1);
  next.flows.splice(Math.max(0, Math.min(toIndex, next.flows.length)), 0, flow!);
  return next;
}

export function setCellText(round: FlowRound, flowId: string, row: number, col: number, text: string): FlowRound {
  const next = cloneRound(round);
  const flow = next.flows.find((item) => item.id === flowId);
  const cell = flow?.rows[row]?.[col];
  if (cell) cell.text = text;
  return next;
}

function orderedRange(range: FlowRange): FlowRange {
  return {
    flowId: range.flowId,
    startRow: Math.min(range.startRow, range.endRow),
    endRow: Math.max(range.startRow, range.endRow),
    startCol: Math.min(range.startCol, range.endCol),
    endCol: Math.max(range.startCol, range.endCol),
  };
}

export function copyRangeAsTsv(round: FlowRound, range: FlowRange): string {
  const r = orderedRange(range);
  const flow = round.flows.find((item) => item.id === r.flowId);
  if (!flow) return '';
  const lines: string[] = [];
  for (let row = r.startRow; row <= r.endRow; row += 1) {
    const cells: string[] = [];
    for (let col = r.startCol; col <= r.endCol; col += 1) cells.push(flow.rows[row]?.[col]?.text ?? '');
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

export function pasteTsv(round: FlowRound, point: FlowPoint, tsv: string): FlowRound {
  let next = cloneRound(round);
  for (const [rowOffset, line] of tsv.replace(/\r\n/g, '\n').split('\n').entries()) {
    for (const [colOffset, text] of line.split('\t').entries()) {
      next = setCellText(next, point.flowId, point.row + rowOffset, point.col + colOffset, text);
    }
  }
  return next;
}

export function toggleBoldRange(round: FlowRound, range: FlowRange): FlowRound {
  const next = cloneRound(round);
  const r = orderedRange(range);
  const flow = next.flows.find((item) => item.id === r.flowId);
  if (!flow) return next;
  for (let row = r.startRow; row <= r.endRow; row += 1) {
    for (let col = r.startCol; col <= r.endCol; col += 1) {
      const cell = flow.rows[row]?.[col];
      if (cell) cell.bold = cell.bold === true ? undefined : true;
    }
  }
  return next;
}
```

- [ ] **Step 5: Run model tests and commit**

Run:

```powershell
npm test -- tests/editor/flow-model.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/flow/flow-types.ts src/editor/flow/flow-model.ts tests/editor/flow-model.test.ts
git commit -m "feat: add native flow model"
```

### Task 2: Flow File Codec

**Files:**
- Create: `src/editor/flow/flow-file.ts`
- Test: `tests/editor/flow-file.test.ts`

- [ ] **Step 1: Write failing codec tests**

Add `tests/editor/flow-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRound } from '../../src/editor/flow/flow-model.js';
import {
  exportFlowlineJson,
  parseFlowFile,
  parseFlowlineJson,
  serializeFlowFile,
} from '../../src/editor/flow/flow-file.js';

describe('flow file codec', () => {
  it('serializes and parses a cmflow wrapper', () => {
    const round = createRound({ format: 'ld', title: 'Case Flow' });
    const bytes = serializeFlowFile({ round, createdAt: '2026-07-16T00:00:00.000Z' });
    const parsed = parseFlowFile(bytes);
    expect(parsed.kind).toBe('cardmirror-flow');
    expect(parsed.round.title).toBe('Case Flow');
    expect(parsed.round.flows).toHaveLength(2);
  });

  it('imports and exports Verba Flowline JSON payloads', () => {
    const round = createRound({ format: 'pf', title: 'PF Round' });
    const flowline = exportFlowlineJson(round);
    const imported = parseFlowlineJson(new TextEncoder().encode(flowline));
    expect(imported.title).toBe('PF Round');
    expect(imported.format).toBe('pf');
  });

  it('rejects invalid JSON with a stable error message', () => {
    expect(() => parseFlowFile(new TextEncoder().encode('{'))).toThrow('Flow file is not valid JSON.');
  });
});
```

- [ ] **Step 2: Run codec tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/flow-file.test.ts
```

Expected: fail because `flow-file.ts` does not exist.

- [ ] **Step 3: Implement `.cmflow` and `.flowline.json` codec**

Create `src/editor/flow/flow-file.ts`:

```ts
import { flowlineVersion, normalizeRound } from './flow-model.js';
import type { FlowRound } from './flow-types.js';

export interface CardMirrorFlowFile {
  kind: 'cardmirror-flow';
  version: 1;
  flowlineVersion: number;
  round: FlowRound;
  createdAt: string;
  updatedAt: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('Flow file is not valid JSON.');
  }
}

export function parseFlowFile(bytes: Uint8Array): CardMirrorFlowFile {
  const raw = parseJson(bytes);
  if (!raw || typeof raw !== 'object') throw new Error('Flow file is missing its wrapper.');
  const obj = raw as Partial<CardMirrorFlowFile>;
  if (obj.kind !== 'cardmirror-flow') throw new Error('Flow file is not a CardMirror Flow document.');
  return {
    kind: 'cardmirror-flow',
    version: 1,
    flowlineVersion: typeof obj.flowlineVersion === 'number' ? obj.flowlineVersion : flowlineVersion(),
    round: normalizeRound(obj.round),
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

export function parseFlowlineJson(bytes: Uint8Array): FlowRound {
  const raw = parseJson(bytes);
  if (raw && typeof raw === 'object' && 'round' in raw) {
    return normalizeRound((raw as { round: unknown }).round);
  }
  return normalizeRound(raw);
}

export function serializeFlowFile(input: {
  round: FlowRound;
  createdAt?: string;
  updatedAt?: string;
}): Uint8Array {
  const now = new Date().toISOString();
  const wrapped: CardMirrorFlowFile = {
    kind: 'cardmirror-flow',
    version: 1,
    flowlineVersion: flowlineVersion(),
    round: normalizeRound(input.round),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  return encoder.encode(`${JSON.stringify(wrapped, null, 2)}\n`);
}

export function exportFlowlineJson(round: FlowRound): string {
  return `${JSON.stringify(normalizeRound(round), null, 2)}\n`;
}
```

- [ ] **Step 4: Run codec tests and commit**

Run:

```powershell
npm test -- tests/editor/flow-file.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/flow/flow-file.ts tests/editor/flow-file.test.ts
git commit -m "feat: add cmflow file codec"
```

### Task 3: Flow Workspace Controller

**Files:**
- Create: `src/editor/flow/flow-workspace.ts`
- Create: `src/editor/flow/flow-workspace.css`
- Test: `tests/editor/flow-workspace.test.ts`

- [ ] **Step 1: Write failing workspace tests**

Add `tests/editor/flow-workspace.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRound } from '../../src/editor/flow/flow-model.js';
import { createFlowWorkspace } from '../../src/editor/flow/flow-workspace.js';

describe('flow workspace', () => {
  it('renders tabs, editable cells, and calls onChange when a cell edits', () => {
    const host = document.createElement('div');
    const onChange = vi.fn();
    const workspace = createFlowWorkspace({
      mount: host,
      round: createRound({ format: 'ld', title: 'Round' }),
      onChange,
    });

    expect(host.querySelector('.cm-flow-title')?.textContent).toContain('Round');
    expect(host.querySelectorAll('.cm-flow-tab')).toHaveLength(2);

    const cell = host.querySelector<HTMLTextAreaElement>('.cm-flow-cell textarea');
    expect(cell).not.toBeNull();
    cell!.value = 'new text';
    cell!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalled();
    expect(workspace.getRound().flows[0]!.rows[0]![0]!.text).toBe('new text');
  });

  it('supports command methods for add flow, find, zoom, and destroy', () => {
    const host = document.createElement('div');
    const workspace = createFlowWorkspace({
      mount: host,
      round: createRound({ format: 'policy', title: 'Policy' }),
      onChange: () => {},
    });
    workspace.addFlow('aff');
    expect(host.querySelectorAll('.cm-flow-tab')).toHaveLength(3);
    workspace.setZoom(1.25);
    expect(host.style.getPropertyValue('--cm-flow-zoom')).toBe('1.25');
    workspace.find('aff');
    expect(host.querySelector('.cm-flow-find')).not.toBeNull();
    workspace.destroy();
    expect(host.childElementCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run workspace tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/flow-workspace.test.ts
```

Expected: fail because `flow-workspace.ts` does not exist.

- [ ] **Step 3: Implement the workspace public API**

Create `src/editor/flow/flow-workspace.ts` with this interface and behavior:

```ts
import { addFlow, setCellText } from './flow-model.js';
import type { FlowFormat, FlowRound, FlowSide } from './flow-types.js';
import './flow-workspace.css';

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
}

export function createFlowWorkspace(opts: FlowWorkspaceOptions): FlowWorkspace {
  let round = opts.round;
  let activeFlowId = round.flows[0]?.id ?? '';
  const root = document.createElement('section');
  root.className = 'cm-flow-workspace';
  root.style.setProperty('--cm-flow-zoom', String(round.settings.zoom || 1));
  opts.mount.replaceChildren(root);

  function activeFlow() {
    return round.flows.find((flow) => flow.id === activeFlowId) ?? round.flows[0]!;
  }

  function emit(next: FlowRound): void {
    round = next;
    opts.onChange(round);
    render();
  }

  function renderTabs(tabs: HTMLElement): void {
    tabs.replaceChildren();
    for (const flow of round.flows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `cm-flow-tab${flow.id === activeFlowId ? ' cm-flow-tab-active' : ''}`;
      button.textContent = flow.title;
      button.addEventListener('click', () => {
        activeFlowId = flow.id;
        render();
      });
      tabs.appendChild(button);
    }
  }

  function renderGrid(grid: HTMLElement): void {
    const flow = activeFlow();
    grid.replaceChildren();
    grid.style.setProperty('--cm-flow-columns', String(flow.columns.length));
    for (const column of flow.columns) {
      const head = document.createElement('div');
      head.className = 'cm-flow-column-head';
      head.textContent = column.label;
      grid.appendChild(head);
    }
    for (let row = 0; row < flow.rows.length; row += 1) {
      for (let col = 0; col < flow.columns.length; col += 1) {
        const wrap = document.createElement('label');
        wrap.className = `cm-flow-cell${flow.rows[row]?.[col]?.bold ? ' cm-flow-cell-bold' : ''}`;
        const area = document.createElement('textarea');
        area.value = flow.rows[row]?.[col]?.text ?? '';
        area.addEventListener('input', () => emit(setCellText(round, flow.id, row, col, area.value)));
        area.addEventListener('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            opts.onRequestSave?.();
          }
        });
        wrap.appendChild(area);
        grid.appendChild(wrap);
      }
    }
  }

  function render(): void {
    root.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'cm-flow-toolbar';
    const title = document.createElement('input');
    title.className = 'cm-flow-title';
    title.value = round.title;
    title.addEventListener('input', () => emit({ ...round, title: title.value }));
    const tabs = document.createElement('div');
    tabs.className = 'cm-flow-tabs';
    const addAff = document.createElement('button');
    addAff.type = 'button';
    addAff.textContent = '+ AFF';
    addAff.addEventListener('click', () => emit(addFlow(round, 'aff')));
    const addNeg = document.createElement('button');
    addNeg.type = 'button';
    addNeg.textContent = '+ NEG';
    addNeg.addEventListener('click', () => emit(addFlow(round, 'neg')));
    toolbar.append(title, tabs, addAff, addNeg);
    const find = document.createElement('div');
    find.className = 'cm-flow-find';
    const grid = document.createElement('div');
    grid.className = 'cm-flow-grid';
    root.append(toolbar, find, grid);
    renderTabs(tabs);
    renderGrid(grid);
  }

  render();

  return {
    element: root,
    getRound: () => round,
    setRound(next) {
      round = next;
      activeFlowId = next.flows[0]?.id ?? '';
      render();
    },
    addFlow(side: FlowSide) {
      emit(addFlow(round, side));
    },
    find(query: string) {
      const find = root.querySelector<HTMLElement>('.cm-flow-find');
      if (find) find.textContent = query ? `Find: ${query}` : '';
    },
    setZoom(zoom: number) {
      round = { ...round, settings: { ...round.settings, zoom } };
      root.style.setProperty('--cm-flow-zoom', String(zoom));
      opts.onChange(round);
    },
    focus() {
      root.querySelector<HTMLElement>('textarea, input, button')?.focus();
    },
    destroy() {
      opts.mount.replaceChildren();
    },
  };
}

export function defaultFlowName(format: FlowFormat): string {
  return `${format.toUpperCase()} Flow.cmflow`;
}
```

- [ ] **Step 4: Add Flow workspace styles**

Create `src/editor/flow/flow-workspace.css`:

```css
.cm-flow-workspace {
  --cm-flow-zoom: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--pmd-text, #202124);
  background: #f3f3f3;
}

.cm-flow-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 10px;
  background: #d8d8d8;
  border-bottom: 1px solid #b8b8b8;
}

.cm-flow-title {
  width: 220px;
  min-width: 140px;
  border: 1px solid #a9a9a9;
  border-radius: 3px;
  padding: 5px 8px;
  font: 600 13px system-ui, sans-serif;
  background: #fff;
}

.cm-flow-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: auto;
}

.cm-flow-tab,
.cm-flow-toolbar button {
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 5px 8px;
  background: transparent;
  color: #202124;
  font: 500 12px system-ui, sans-serif;
}

.cm-flow-tab:hover,
.cm-flow-toolbar button:hover {
  background: #c7c7c7;
  border-color: #aaa;
}

.cm-flow-tab-active {
  background: #b9d7f2;
  border-color: #7aa7d8;
}

.cm-flow-find {
  min-height: 20px;
  padding: 2px 10px;
  font: 12px system-ui, sans-serif;
  color: #315f8d;
}

.cm-flow-grid {
  display: grid;
  grid-template-columns: repeat(var(--cm-flow-columns), minmax(160px, 1fr));
  gap: 1px;
  padding: 10px;
  overflow: auto;
  transform-origin: top left;
  font-size: calc(13px * var(--cm-flow-zoom));
}

.cm-flow-column-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 7px 8px;
  background: #555;
  color: #fff;
  font-weight: 650;
}

.cm-flow-cell {
  min-height: calc(42px * var(--cm-flow-zoom));
  background: #fff;
  border: 1px solid #d5d5d5;
}

.cm-flow-cell textarea {
  display: block;
  width: 100%;
  min-height: calc(42px * var(--cm-flow-zoom));
  resize: vertical;
  border: 0;
  padding: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}

.cm-flow-cell-bold textarea {
  font-weight: 700;
}
```

- [ ] **Step 5: Run workspace tests and commit**

Run:

```powershell
npm test -- tests/editor/flow-workspace.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/flow/flow-workspace.ts src/editor/flow/flow-workspace.css tests/editor/flow-workspace.test.ts
git commit -m "feat: add native flow workspace"
```

### Task 4: File Search, Recents, Host Filters, And Home

**Files:**
- Modify: `src/editor/file-search.ts`
- Modify: `src/editor/recents-store.ts`
- Modify: `src/editor/home-screen.ts`
- Modify: `src/editor/host/types.ts`
- Modify: `src/editor/host/browser-host.ts`
- Modify: `src/editor/host/electron-host.ts`
- Modify: `apps/desktop/src/main.ts`
- Test: `tests/editor/file-search.test.ts`
- Test: `tests/editor/home-screen-flow.test.ts`
- Test: `tests/editor/recents-store-flow.test.ts`

- [ ] **Step 1: Write failing file and recents tests**

Add to `tests/editor/file-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fileFormat, stripFileExt } from '../../src/editor/file-search.js';

describe('flow file search helpers', () => {
  it('recognizes cmflow files', () => {
    expect(fileFormat('round.cmflow')).toBe('cmflow');
    expect(stripFileExt('round.cmflow')).toBe('round');
  });
});
```

Add `tests/editor/recents-store-flow.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { clearRecents, listRecents, recordRecent } from '../../src/editor/recents-store.js';

describe('flow recents', () => {
  beforeEach(() => clearRecents());

  it('stores cmflow recent files', () => {
    recordRecent({ handle: 'C:/flows/round.cmflow', filename: 'round.cmflow', format: 'cmflow' });
    expect(listRecents()[0]).toMatchObject({ filename: 'round.cmflow', format: 'cmflow' });
  });
});
```

- [ ] **Step 2: Write failing home test**

Add `tests/editor/home-screen-flow.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHomeScreen } from '../../src/editor/home-screen.js';

describe('home flow integration', () => {
  it('renders a FLOW action and a Flows recent section', () => {
    const root = document.createElement('div');
    createHomeScreen({
      mount: root,
      onAction: vi.fn(),
      onOpenRecent: vi.fn(),
      onSearchOpen: vi.fn(),
      listRecentFiles: () => [
        { handle: 'C:/x/round.cmflow', filename: 'round.cmflow', format: 'cmflow', lastOpenedAt: Date.now() },
      ],
      listSearchFiles: () => [],
    });

    expect(root.textContent).toContain('FLOW');
    expect(root.textContent).toContain('Flows');
    expect(root.textContent).toContain('round.cmflow');
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/file-search.test.ts tests/editor/recents-store-flow.test.ts tests/editor/home-screen-flow.test.ts
```

Expected: fail because unions and home actions do not include `cmflow`.

- [ ] **Step 4: Update format unions and helpers**

In `src/editor/file-search.ts`, change:

```ts
export type OpenableFileFormat = 'cmir' | 'docx' | 'cmflow';

export function fileFormat(pathOrName: string): OpenableFileFormat {
  if (/\.docx$/i.test(pathOrName)) return 'docx';
  if (/\.cmflow$/i.test(pathOrName)) return 'cmflow';
  return 'cmir';
}

export function stripFileExt(name: string): string {
  return name.replace(/\.(cmir|docx|cmflow)$/i, '');
}
```

In `src/editor/recents-store.ts`, change both format unions to:

```ts
format: 'cmir' | 'docx' | 'cmflow' | null;
```

In `src/editor/host/types.ts`, change `JournalEntry.format` to:

```ts
format: 'cmir' | 'docx' | 'cmflow' | null;
```

- [ ] **Step 5: Update desktop scan and picker recognition**

In `apps/desktop/src/main.ts`, update each `.cmir` / `.docx` detector to include `.cmflow`:

```ts
function isOpenableEditorPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.cmir') || lower.endsWith('.docx') || lower.endsWith('.cmflow');
}
```

Replace local duplicated extension checks with `isOpenableEditorPath(filePath)` where the file is being accepted for OS open or recursive home search.

For format detection, use:

```ts
function formatForPath(filePath: string): 'cmir' | 'docx' | 'cmflow' | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cmir') return 'cmir';
  if (ext === '.docx') return 'docx';
  if (ext === '.cmflow') return 'cmflow';
  return null;
}
```

- [ ] **Step 6: Update home actions**

In `src/editor/home-screen.ts`, add `FLOW` to the main action model:

```ts
const HOME_ACTIONS = [
  { id: 'open', label: 'OPEN', icon: 'folder' },
  { id: 'newDoc', label: 'NEW', icon: 'file-plus' },
  { id: 'cards', label: 'CARDS', icon: 'layers' },
  { id: 'flow', label: 'FLOW', icon: 'table' },
  { id: 'convert', label: 'CONVERT', icon: 'refresh' },
] as const;
```

Add a Flow recents bucket:

```ts
const flowRecents = recents.filter((file) => file.format === 'cmflow');
renderRecentSection('Flows', flowRecents);
```

Wire the action callback:

```ts
if (action.id === 'flow') callbacks.onAction('flow');
```

Use the exact callback type already used by the home screen and extend its action union with `'flow'`.

- [ ] **Step 7: Run tests and commit**

Run:

```powershell
npm test -- tests/editor/file-search.test.ts tests/editor/recents-store-flow.test.ts tests/editor/home-screen-flow.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/file-search.ts src/editor/recents-store.ts src/editor/home-screen.ts src/editor/host/types.ts src/editor/host/browser-host.ts src/editor/host/electron-host.ts apps/desktop/src/main.ts tests/editor/file-search.test.ts tests/editor/recents-store-flow.test.ts tests/editor/home-screen-flow.test.ts
git commit -m "feat: show flow files in home and search"
```

### Task 5: Ribbon Commands And Legacy Flow Bridge

**Files:**
- Modify: `src/editor/ribbon-commands.ts`
- Modify: `src/editor/ribbon-groups.ts`
- Modify: `src/editor/flow-port.ts`
- Modify: `src/editor/index.ts`
- Test: `tests/editor/ribbon-flow.test.ts`
- Test: `tests/editor/ribbon-groups.test.ts`

- [ ] **Step 1: Write failing ribbon tests**

Add `tests/editor/ribbon-flow.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  runRibbonCommand,
} from '../../src/editor/ribbon-commands.js';

describe('flow ribbon commands', () => {
  it('exposes native flow commands and keeps legacy Excel command separate', () => {
    expect(RIBBON_COMMAND_IDS).toContain('createFlow');
    expect(RIBBON_COMMAND_IDS).toContain('openFlow');
    expect(RIBBON_COMMAND_IDS).toContain('importFlowlineJson');
    expect(RIBBON_COMMAND_IDS).toContain('exportFlowlineJson');
    expect(RIBBON_COMMAND_IDS).toContain('createLegacyExcelFlow');
    expect(RIBBON_COMMAND_LABELS.createFlow).toBe('Create Flow');
    expect(RIBBON_COMMAND_LABELS.createLegacyExcelFlow).toBe('Create Excel Flow (Legacy)');
  });

  it('runs native create flow through RibbonContext', () => {
    const createFlow = vi.fn();
    runRibbonCommand('createFlow', { createFlow } as never);
    expect(createFlow).toHaveBeenCalled();
  });

  it('uses Flowline shortcut defaults without overriding Save', () => {
    expect(DEFAULT_RIBBON_KEYS.flowFind).toBe('Ctrl+Alt+F');
    expect(DEFAULT_RIBBON_KEYS.flowSaveNow).toBe('Ctrl+Alt+S');
  });
});
```

- [ ] **Step 2: Run ribbon tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/ribbon-flow.test.ts tests/editor/ribbon-groups.test.ts
```

Expected: fail because new command IDs are missing and `createFlow` still labels old behavior.

- [ ] **Step 3: Rename the legacy Excel create export**

In `src/editor/flow-port.ts`, rename:

```ts
export async function runCreateFlow(): Promise<void> {
```

to:

```ts
export async function runCreateLegacyExcelFlow(): Promise<void> {
```

In `src/editor/index.ts`, update the import:

```ts
import {
  runCreateLegacyExcelFlow,
  runPullFromFlow,
  runSendToFlow,
  runStartFlowHost,
} from './flow-port.js';
```

- [ ] **Step 4: Add native and legacy ribbon command IDs**

In `src/editor/ribbon-commands.ts`, add these IDs to `RibbonCommandId` and `RIBBON_COMMAND_IDS`:

```ts
| 'openFlow'
| 'importFlowlineJson'
| 'exportFlowlineJson'
| 'flowFind'
| 'flowSaveNow'
| 'createLegacyExcelFlow'
```

Set labels:

```ts
createFlow: 'Create Flow',
openFlow: 'Open Flow',
importFlowlineJson: 'Import Flowline JSON',
exportFlowlineJson: 'Export Flowline JSON',
flowFind: 'Find in Flow',
flowSaveNow: 'Save Flow',
createLegacyExcelFlow: 'Create Excel Flow (Legacy)',
startFlowHost: 'Start Excel Flow Bridge',
```

Set default keys:

```ts
flowFind: 'Ctrl+Alt+F',
flowSaveNow: 'Ctrl+Alt+S',
openFlow: 'Ctrl+Shift+O',
importFlowlineJson: '',
exportFlowlineJson: '',
createLegacyExcelFlow: '',
```

Extend `RibbonContext`:

```ts
openFlow: () => void;
importFlowlineJson: () => void;
exportFlowlineJson: () => void;
flowFind: () => void;
flowSaveNow: () => void;
createLegacyExcelFlow: () => void;
```

In `commandFor`, route each new command to its context method.

- [ ] **Step 5: Update ribbon groups**

In `src/editor/ribbon-groups.ts`, put native Flow commands near paperless tools:

```ts
'createFlow',
'openFlow',
'importFlowlineJson',
'exportFlowlineJson',
'flowFind',
'flowSaveNow',
```

Put legacy bridge commands next to each other:

```ts
'createLegacyExcelFlow',
'startFlowHost',
```

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
npm test -- tests/editor/ribbon-flow.test.ts tests/editor/ribbon-groups.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/ribbon-commands.ts src/editor/ribbon-groups.ts src/editor/flow-port.ts src/editor/index.ts tests/editor/ribbon-flow.test.ts tests/editor/ribbon-groups.test.ts
git commit -m "feat: add native flow ribbon commands"
```

### Task 6: Flow Settings Category

**Files:**
- Modify: `src/editor/settings.ts`
- Modify: `src/editor/settings-categories.ts`
- Test: `tests/editor/settings-flow.test.ts`
- Test: `tests/editor/setting-toggles.test.ts`

- [ ] **Step 1: Write failing settings tests**

Add `tests/editor/settings-flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CATEGORY_TABS } from '../../src/editor/settings-categories.js';
import { defaultSettings } from '../../src/editor/settings.js';

describe('flow settings', () => {
  it('has a Flow category and default values', () => {
    expect(CATEGORY_TABS.map((tab) => tab.id)).toContain('flow');
    expect(defaultSettings.defaultFlowFormat).toBe('ld');
    expect(defaultSettings.flowZoomDefault).toBe(1);
    expect(defaultSettings.flowAffColor).toMatch(/^#/);
    expect(defaultSettings.flowNegColor).toMatch(/^#/);
    expect(defaultSettings.flowSelectionColor).toMatch(/^#/);
  });
});
```

- [ ] **Step 2: Run settings tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/settings-flow.test.ts tests/editor/setting-toggles.test.ts
```

Expected: fail because the Flow category and defaults do not exist.

- [ ] **Step 3: Add settings fields and defaults**

In `src/editor/settings.ts`, extend the settings interface:

```ts
defaultFlowFormat: 'ld' | 'pf' | 'policy';
flowAffColor: string;
flowNegColor: string;
flowSelectionColor: string;
flowZoomDefault: number;
```

In `defaultSettings`, add:

```ts
defaultFlowFormat: 'ld',
flowAffColor: '#dff3ff',
flowNegColor: '#ffe8e1',
flowSelectionColor: '#7db9e8',
flowZoomDefault: 1,
```

In settings normalization, add:

```ts
defaultFlowFormat: s.defaultFlowFormat === 'pf' || s.defaultFlowFormat === 'policy' ? s.defaultFlowFormat : 'ld',
flowAffColor: typeof s.flowAffColor === 'string' ? s.flowAffColor : defaultSettings.flowAffColor,
flowNegColor: typeof s.flowNegColor === 'string' ? s.flowNegColor : defaultSettings.flowNegColor,
flowSelectionColor: typeof s.flowSelectionColor === 'string' ? s.flowSelectionColor : defaultSettings.flowSelectionColor,
flowZoomDefault: typeof s.flowZoomDefault === 'number' ? Math.min(5, Math.max(0.5, s.flowZoomDefault)) : 1,
```

- [ ] **Step 4: Add Flow category UI rows**

In `src/editor/settings-categories.ts`, add:

```ts
{ id: 'flow', label: 'Flow' },
```

In the settings row registry in `src/editor/settings.ts`, move the existing `flowHostOnLaunch` row to category `flow` and add these rows:

```ts
{
  key: 'defaultFlowFormat',
  category: 'flow',
  label: 'Default Flow format',
  kind: 'select',
  options: [
    { value: 'ld', label: 'LD' },
    { value: 'pf', label: 'PF' },
    { value: 'policy', label: 'Policy' },
  ],
},
{
  key: 'flowZoomDefault',
  category: 'flow',
  label: 'Default Flow zoom',
  kind: 'number',
  min: 0.5,
  max: 5,
  step: 0.1,
},
{
  key: 'flowAffColor',
  category: 'flow',
  label: 'AFF color',
  kind: 'color',
},
{
  key: 'flowNegColor',
  category: 'flow',
  label: 'NEG color',
  kind: 'color',
},
{
  key: 'flowSelectionColor',
  category: 'flow',
  label: 'Selection color',
  kind: 'color',
},
```

Use the local row shape already present in `settings.ts`. If the local row registry uses named helper functions instead of object literals, translate the five rows into that helper syntax with the same keys and labels.

- [ ] **Step 5: Run settings tests and commit**

Run:

```powershell
npm test -- tests/editor/settings-flow.test.ts tests/editor/setting-toggles.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/settings.ts src/editor/settings-categories.ts tests/editor/settings-flow.test.ts tests/editor/setting-toggles.test.ts
git commit -m "feat: add flow settings"
```

### Task 7: Single-Pane Flow Open, Save, Dirty, And Autosave

**Files:**
- Modify: `src/editor/index.ts`
- Modify: `src/editor/host/types.ts`
- Test: `tests/editor/flow-single-pane.test.ts`

- [ ] **Step 1: Write failing single-pane tests against extracted helpers**

Add exported helpers from `src/editor/index.ts` in Step 3, then add `tests/editor/flow-single-pane.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRound } from '../../src/editor/flow/flow-model.js';
import {
  flowDirtyEquals,
  flowFormatForFilename,
  suggestedFlowSaveName,
} from '../../src/editor/index.js';

describe('single-pane flow helpers', () => {
  it('detects flow formats from filenames', () => {
    expect(flowFormatForFilename('round.cmflow')).toBe('cmflow');
    expect(flowFormatForFilename('round.flowline.json')).toBe('flowline-json');
    expect(flowFormatForFilename('round.docx')).toBe(null);
  });

  it('suggests cmflow save names for imported Flowline JSON', () => {
    expect(suggestedFlowSaveName('round.flowline.json')).toBe('round.cmflow');
  });

  it('tracks dirty state by normalized JSON baseline', () => {
    const round = createRound({ format: 'ld', title: 'Round' });
    const baseline = JSON.stringify(round);
    expect(flowDirtyEquals(round, baseline)).toBe(false);
    expect(flowDirtyEquals({ ...round, title: 'Changed' }, baseline)).toBe(true);
  });
});
```

- [ ] **Step 2: Run single-pane tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/flow-single-pane.test.ts
```

Expected: fail because helpers do not exist.

- [ ] **Step 3: Add Flow state and helper exports to `index.ts`**

In `src/editor/index.ts`, import:

```ts
import { createRound } from './flow/flow-model.js';
import { exportFlowlineJson, parseFlowFile, parseFlowlineJson, serializeFlowFile } from './flow/flow-file.js';
import { createFlowWorkspace, defaultFlowName, type FlowWorkspace } from './flow/flow-workspace.js';
import './flow/flow-workspace.css';
```

Add these helper exports near existing pure helpers:

```ts
export type OpenedFlowFormat = 'cmflow' | 'flowline-json';

export function flowFormatForFilename(name: string): OpenedFlowFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.cmflow')) return 'cmflow';
  if (lower.endsWith('.flowline.json')) return 'flowline-json';
  return null;
}

export function suggestedFlowSaveName(name: string): string {
  return name.replace(/\.flowline\.json$/i, '.cmflow').replace(/\.json$/i, '.cmflow');
}

export function flowDirtyEquals(round: unknown, baselineJson: string | null): boolean {
  if (baselineJson == null) return true;
  return JSON.stringify(round) !== baselineJson;
}
```

Add module state:

```ts
let activeFlowWorkspace: FlowWorkspace | null = null;
let activeFlowHandle: unknown = null;
let activeFlowFilename: string | null = null;
let activeFlowFormat: OpenedFlowFormat | null = null;
let activeFlowBaseline: string | null = null;
let activeFlowCreatedAt: string | null = null;
```

- [ ] **Step 4: Implement single-pane mount/open/save commands**

Add functions in `src/editor/index.ts`:

```ts
function mountFlowWorkspace(round: FlowRound, opts: {
  filename: string;
  handle: unknown;
  format: OpenedFlowFormat | null;
  createdAt?: string;
}): void {
  activeFlowWorkspace?.destroy();
  const mount = document.getElementById('editor') ?? document.body;
  activeFlowFilename = opts.filename;
  activeFlowHandle = opts.handle;
  activeFlowFormat = opts.format;
  activeFlowCreatedAt = opts.createdAt ?? new Date().toISOString();
  activeFlowBaseline = JSON.stringify(round);
  activeFlowWorkspace = createFlowWorkspace({
    mount,
    round,
    onChange: (nextRound) => {
      activeFlowBaseline = activeFlowBaseline;
      markDirty?.();
      scheduleFlowAutosave();
    },
    onRequestSave: () => {
      void saveActiveFlow();
    },
  });
  hideHomeScreenIfVisible();
  updateWindowTitle();
}

async function openFlowFile(opened: OpenedFile): Promise<boolean> {
  const format = flowFormatForFilename(opened.name);
  if (!format) return false;
  if (format === 'cmflow') {
    const parsed = parseFlowFile(opened.bytes);
    mountFlowWorkspace(parsed.round, {
      filename: opened.name,
      handle: opened.handle ?? null,
      format,
      createdAt: parsed.createdAt,
    });
  } else {
    const round = parseFlowlineJson(opened.bytes);
    mountFlowWorkspace(round, {
      filename: suggestedFlowSaveName(opened.name),
      handle: null,
      format,
    });
  }
  return true;
}

async function createNativeFlow(): Promise<void> {
  const format = settings.get('defaultFlowFormat');
  mountFlowWorkspace(createRound({ format, title: 'Unnamed1' }), {
    filename: defaultFlowName(format),
    handle: null,
    format: null,
  });
}

async function saveActiveFlow(): Promise<boolean> {
  if (!activeFlowWorkspace) return false;
  const round = activeFlowWorkspace.getRound();
  const bytes = serializeFlowFile({ round, createdAt: activeFlowCreatedAt ?? undefined });
  if (activeFlowHandle && activeFlowFormat === 'cmflow') {
    await host.saveExisting(activeFlowHandle, bytes);
  } else {
    const result = await host.saveAs(activeFlowFilename ?? 'Untitled.cmflow', bytes, {
      filters: [{ name: 'CardMirror Flow', extensions: ['cmflow'] }],
    });
    if (!result) return false;
    activeFlowFilename = result.name;
    activeFlowHandle = result.handle ?? null;
    activeFlowFormat = 'cmflow';
  }
  activeFlowBaseline = JSON.stringify(round);
  recordRecent({ filename: activeFlowFilename, handle: typeof activeFlowHandle === 'string' ? activeFlowHandle : null, format: 'cmflow' });
  updateWindowTitle();
  return true;
}

async function exportActiveFlowlineJson(): Promise<void> {
  if (!activeFlowWorkspace) return;
  await host.saveAs(
    (activeFlowFilename ?? 'Untitled.cmflow').replace(/\.cmflow$/i, '.flowline.json'),
    new TextEncoder().encode(exportFlowlineJson(activeFlowWorkspace.getRound())),
    { filters: [{ name: 'Flowline JSON', extensions: ['flowline.json', 'json'] }] },
  );
}
```

Use the actual local names for `host`, `settings`, `markDirty`, `hideHomeScreenIfVisible`, and `recordRecent` in `index.ts`. If `markDirty` is not a function, call the existing dirty-state setter used by document edits.

- [ ] **Step 5: Wire open/create/save paths**

In `routeOpenedFile` or the current open-file dispatcher in `src/editor/index.ts`, call:

```ts
if (await openFlowFile(opened)) return;
```

In `ribbonContext`, change:

```ts
createFlow: () => {
  void createNativeFlow();
},
openFlow: () => {
  void runOpenFlow();
},
importFlowlineJson: () => {
  void runImportFlowlineJson();
},
exportFlowlineJson: () => {
  void exportActiveFlowlineJson();
},
flowSaveNow: () => {
  void saveActiveFlow();
},
createLegacyExcelFlow: () => {
  void runCreateLegacyExcelFlow();
},
```

Implement `runOpenFlow()` with:

```ts
const opened = await host.openFile({
  filters: [
    { name: 'Flow files', extensions: ['cmflow', 'flowline.json', 'json'] },
    { name: 'CardMirror Flow', extensions: ['cmflow'] },
    { name: 'Flowline JSON', extensions: ['json'] },
  ],
});
if (opened) await openFlowFile(opened);
```

Implement `runImportFlowlineJson()` with the same filter and force `parseFlowlineJson`.

- [ ] **Step 6: Run single-pane tests and commit**

Run:

```powershell
npm test -- tests/editor/flow-single-pane.test.ts
npm run typecheck
```

Expected: tests pass and typecheck passes.

Commit:

```powershell
git add src/editor/index.ts src/editor/host/types.ts tests/editor/flow-single-pane.test.ts
git commit -m "feat: open and save native flow files"
```

### Task 8: Multi-Pane Flow Routing

**Files:**
- Modify: `src/editor/multi-pane-shell.ts`
- Modify: `src/editor/index.ts`
- Test: `tests/editor/multi-pane-flow-routing.test.ts`

- [ ] **Step 1: Write failing route-choice tests**

Add `tests/editor/multi-pane-flow-routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { flowRouteChoices, type FlowRouteChoice } from '../../src/editor/multi-pane-shell.js';

describe('multi-pane flow routing', () => {
  it('offers three slots and open separate for flows', () => {
    expect(flowRouteChoices().map((choice: FlowRouteChoice) => choice.id)).toEqual([
      'slot1',
      'slot2',
      'slot3',
      'separate',
    ]);
  });
});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run:

```powershell
npm test -- tests/editor/multi-pane-flow-routing.test.ts
```

Expected: fail because `flowRouteChoices` is missing.

- [ ] **Step 3: Introduce pane records**

In `src/editor/multi-pane-shell.ts`, add:

```ts
export type FlowRouteChoice =
  | { id: SlotId; label: string }
  | { id: 'separate'; label: 'Open Separate' };

export function flowRouteChoices(): FlowRouteChoice[] {
  return [
    { id: 'slot1', label: '1' },
    { id: 'slot2', label: '2' },
    { id: 'slot3', label: '3' },
    { id: 'separate', label: 'Open Separate' },
  ];
}

interface FlowRecord {
  kind: 'flow';
  uid: string;
  filename: string;
  handle: unknown;
  format: 'cmflow' | 'flowline-json' | null;
  editorEl: HTMLElement;
  navEl: HTMLElement;
  owner: Slot;
  isDirty: boolean;
  save: () => Promise<boolean>;
  destroy: () => void;
  focus: () => void;
}

type PaneRecord = DocRecord | FlowRecord;

function isFlowRecord(record: PaneRecord | null | undefined): record is FlowRecord {
  return record?.kind === 'flow';
}
```

Add `kind: 'doc'` to `DocRecord` and the object returned by `buildDocRecord`.

Change slot stacks from:

```ts
stack: DocRecord[] = [];
```

to:

```ts
stack: PaneRecord[] = [];
```

Change doc-only code paths to guard:

```ts
if (isFlowRecord(record)) {
  record.focus();
  return;
}
record.view.focus();
```

Use the same guard for journal, autosave, ProseMirror transactions, nav outline, word count, speech docs, and collab presence.

- [ ] **Step 4: Add Flow routing methods**

In `MultiPaneShell`, add:

```ts
async createNewFlow(format: FlowFormat): Promise<void> {
  const choice = await this.promptForSlotOrSeparate('Untitled Flow', true);
  if (!choice) return;
  if (choice === 'separate') {
    await this.deps.openSeparateFlow?.({ format });
    return;
  }
  const slot = this.slots[choice];
  const record = this.deps.buildFlowRecord(createRound({ format, title: 'Unnamed1' }), slot, {
    filename: defaultFlowName(format),
    handle: null,
    format: null,
  });
  slot.push(record);
}
```

Replace `promptForSlot(filename)` with an overload:

```ts
private promptForSlotOrSeparate(
  filename: string,
  includeSeparate: boolean,
): Promise<SlotId | 'separate' | null>
```

When `includeSeparate` is true, render a fourth clean list row labeled `Open Separate`.

Extend `enableMultiDocMode` deps in `src/editor/index.ts`:

```ts
onNewFlow: () => shell!.createNewFlow(settings.get('defaultFlowFormat')),
buildFlowRecord: (round, slot, opts) => buildFlowRecord(round, slot, opts),
openSeparateFlow: async ({ format }) => createNativeFlowInNewWindow(format),
```

- [ ] **Step 5: Build Flow records**

In `src/editor/multi-pane-shell.ts`, add `buildFlowRecord`:

```ts
function buildFlowRecord(
  round: FlowRound,
  slot: Slot,
  opts: { filename: string; handle: unknown; format: 'cmflow' | 'flowline-json' | null },
): FlowRecord {
  const editorEl = document.createElement('div');
  editorEl.className = 'pmd-pane-flow-host';
  const navEl = document.createElement('div');
  navEl.hidden = true;
  let isDirty = false;
  const workspace = createFlowWorkspace({
    mount: editorEl,
    round,
    onChange: () => {
      isDirty = true;
      slot.refreshChipFilename();
    },
  });
  return {
    kind: 'flow',
    uid: crypto.randomUUID?.() ?? `flow-${Date.now()}`,
    filename: opts.filename,
    handle: opts.handle,
    format: opts.format,
    editorEl,
    navEl,
    owner: slot,
    get isDirty() {
      return isDirty;
    },
    set isDirty(value: boolean) {
      isDirty = value;
    },
    save: async () => false,
    destroy: () => workspace.destroy(),
    focus: () => workspace.focus(),
  };
}
```

Wire `save` to the same serializer used by Task 7.

- [ ] **Step 6: Run route tests and typecheck**

Run:

```powershell
npm test -- tests/editor/multi-pane-flow-routing.test.ts
npm run typecheck
```

Expected: tests pass and typecheck passes.

Commit:

```powershell
git add src/editor/multi-pane-shell.ts src/editor/index.ts tests/editor/multi-pane-flow-routing.test.ts
git commit -m "feat: route flows in multi-pane workspace"
```

### Task 9: Flow UX Polish And Documentation

**Files:**
- Modify: `src/editor/flow/flow-workspace.css`
- Modify: `src/editor/style.css`
- Modify: `src/editor/home-screen.ts`
- Modify: `MANUAL.md`
- Test: `tests/editor/flow-workspace.test.ts`
- Test: `tests/editor/home-screen-flow.test.ts`

- [ ] **Step 1: Add UI assertions for CardMirror styling**

Extend `tests/editor/flow-workspace.test.ts`:

```ts
it('uses CardMirror class names for native styling', () => {
  const host = document.createElement('div');
  createFlowWorkspace({
    mount: host,
    round: createRound({ format: 'ld', title: 'Round' }),
    onChange: () => {},
  });
  expect(host.querySelector('.cm-flow-workspace')).not.toBeNull();
  expect(host.querySelector('.cm-flow-toolbar')).not.toBeNull();
  expect(host.querySelector('.cm-flow-grid')).not.toBeNull();
});
```

- [ ] **Step 2: Run UI tests**

Run:

```powershell
npm test -- tests/editor/flow-workspace.test.ts tests/editor/home-screen-flow.test.ts
```

Expected: pass after Task 3 and Task 4.

- [ ] **Step 3: Tune Flow visual style**

Update `src/editor/flow/flow-workspace.css` so the Flow toolbar uses the same darker gray ribbon family requested for CardMirror:

```css
.cm-flow-toolbar {
  background: var(--pmd-ribbon-bg, #d2d2d2);
  border-bottom-color: var(--pmd-ribbon-border, #a8a8a8);
}

.cm-flow-tab-active {
  background: color-mix(in srgb, var(--pmd-accent, #2f74b5) 22%, #ffffff);
  border-color: color-mix(in srgb, var(--pmd-accent, #2f74b5) 58%, #777777);
}
```

If `color-mix` is not used elsewhere in the repo, replace those two values with:

```css
background: #c7ddf2;
border-color: #6c9ac6;
```

- [ ] **Step 4: Add manual text**

Add this section to `MANUAL.md`:

```md
### Flow

Use `FLOW` on the home screen or `Create Flow` in the ribbon to create a native CardMirror Flow file. Native Flow files save as `.cmflow`.

CardMirror can import Verba Flowline `.flowline.json` files and export the current Flow back to Flowline JSON. The legacy Excel Flow bridge remains available as `Create Excel Flow (Legacy)` and `Start Excel Flow Bridge`.

In three-pane mode, creating or opening a Flow asks which slot to use. `Open Separate` opens the Flow in its own CardMirror window when the desktop host supports it.
```

- [ ] **Step 5: Run polish tests and commit**

Run:

```powershell
npm test -- tests/editor/flow-workspace.test.ts tests/editor/home-screen-flow.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/editor/flow/flow-workspace.css src/editor/style.css src/editor/home-screen.ts MANUAL.md tests/editor/flow-workspace.test.ts tests/editor/home-screen-flow.test.ts
git commit -m "docs: document native flow"
```

### Task 10: Full Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run focused Flow tests**

Run:

```powershell
npm test -- tests/editor/flow-model.test.ts tests/editor/flow-file.test.ts tests/editor/flow-workspace.test.ts tests/editor/home-screen-flow.test.ts tests/editor/ribbon-flow.test.ts tests/editor/settings-flow.test.ts tests/editor/multi-pane-flow-routing.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run related existing tests**

Run:

```powershell
npm test -- tests/editor/file-search.test.ts tests/editor/ribbon-groups.test.ts tests/editor/ribbon-custom-buttons.test.ts tests/editor/home-screen-shortcuts.test.ts tests/editor/setting-toggles.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 3: Run typecheck and build**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: both commands finish with exit code 0.

- [ ] **Step 4: Capture final status**

Run:

```powershell
git status --short
```

Expected: only intended Flow implementation files are changed since the branch base, plus unrelated pre-existing dirty files that were present before the plan execution.

## Self-Review

**Spec coverage:**

- `.cmflow` file model: Task 2.
- Verba Flowline import/export compatibility: Task 1 and Task 2.
- Native Flow workspace: Task 3 and Task 9.
- Home `FLOW`, `Flows`, and `.cmflow` search: Task 4.
- Ribbon custom command availability: Task 5.
- Settings `Flow` category: Task 6.
- Three-pane slot/open-separate routing: Task 8.
- Save, dirty state, and autosave entry points: Task 7 and Task 8.
- Error handling: Task 2 parser errors and Task 7 open/save surfaces.
- Testing and build: Task 10.

**Placeholder scan:**

The plan contains concrete file paths, command lines, test snippets, and implementation snippets for every task. One settings step allows translating object rows into existing helper syntax because `settings.ts` has a large local row system; it pins exact keys, labels, values, and category.

**Type consistency:**

The same names are used across tasks: `FlowRound`, `FlowFormat`, `FlowSide`, `FlowWorkspace`, `createRound`, `parseFlowFile`, `serializeFlowFile`, `parseFlowlineJson`, `exportFlowlineJson`, `createFlow`, `createLegacyExcelFlow`, `openFlow`, `importFlowlineJson`, and `exportFlowlineJson`.
