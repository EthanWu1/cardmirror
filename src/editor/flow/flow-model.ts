import type {
  FlowCell,
  FlowColumn,
  FlowFormat,
  FlowPoint,
  FlowRange,
  FlowRound,
  FlowRoundSettings,
  FlowSheet,
  FlowSide,
} from './flow-types.js';

export type {
  FlowCell,
  FlowColumn,
  FlowFormat,
  FlowPoint,
  FlowRange,
  FlowRound,
  FlowRoundSettings,
  FlowSheet,
  FlowSide,
} from './flow-types.js';

const FLOWLINE_VERSION = 34;

export function flowlineVersion(): number {
  return FLOWLINE_VERSION;
}

const DEFAULT_ROW_COUNT = 40;
const MAX_ROW_COUNT = 1000;
const MAX_RANGE_CELLS = 10000;
const DEFAULT_ZOOM_PERCENT = 100;
const MIN_ZOOM_PERCENT = 70;
const MAX_ZOOM_PERCENT = 160;

const DEFAULT_COLORS = {
  aff: '#1f4e79',
  neg: '#db3434',
  selection: '#60666f',
} as const;

const COLUMN_LABELS: Record<FlowFormat, Record<FlowSide, readonly string[]>> = {
  ld: {
    aff: ['1AC', '1NC', '1AR', '2NR', '2AR'],
    neg: ['1NC', '1AR', '2NR', '2AR'],
  },
  pf: {
    aff: ['AC', 'NC', 'AR', 'NR', 'AS', 'NS', 'AF', 'NF'],
    neg: ['NC', 'AC', 'NR', 'AR', 'NS', 'AS', 'NF', 'AF'],
  },
  policy: {
    aff: ['1AC', '1NC', '2AC', 'Block', '1AR', '2NR', '2AR'],
    neg: ['1NC', '2AC', 'Block', '1AR', '2NR', '2AR'],
  },
};

type RawRecord = Record<string, unknown>;

export function createRound(options: { format?: FlowFormat; title?: string } = {}): FlowRound {
  const format = normalizeFormat(options.format);
  const title = cleanTitle(options.title, 'Unnamed1');
  const now = iso();
  const settings = createSettings(format, DEFAULT_ROW_COUNT);

  return {
    id: createId('round'),
    flowlineVersion: flowlineVersion(),
    title,
    format,
    settings,
    flows: [
      createFlowSheet({ format, side: 'aff', title: 'AFF 1', rowCount: settings.rowCount, now }),
      createFlowSheet({ format, side: 'neg', title: 'NEG 1', rowCount: settings.rowCount, now }),
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeRound(raw: unknown): FlowRound {
  const source = asRecord(raw);
  const rawSettings = asRecord(source?.settings);
  const rawFlows = Array.isArray(source?.flows) ? source.flows : [];
  const format = normalizeFormat(source?.format, normalizeFormat(rawSettings?.defaultFormat));
  const rowCount = resolveRowCount(rawSettings?.rowCount, rawFlows);
  const now = iso();
  const settings = normalizeSettings(rawSettings, format, rowCount);
  const flows = normalizeFlows(rawFlows, format, settings.rowCount);

  return {
    id: readString(source?.id) ?? createId('round'),
    flowlineVersion: flowlineVersion(),
    title: cleanTitle(source?.title, 'Unnamed1'),
    format,
    settings,
    flows: flows.length > 0 ? flows : defaultFlows(format, settings.rowCount, now),
    createdAt: readString(source?.createdAt) ?? now,
    updatedAt: readString(source?.updatedAt) ?? now,
  };
}

export function addFlow(round: FlowRound, side: FlowSide): FlowRound {
  const next = normalizeRound(round);
  const now = iso();
  const sideCount = next.flows.filter((flow) => flow.side === side).length + 1;
  next.flows = [
    ...next.flows,
    createFlowSheet({
      format: next.format,
      side,
      title: `${sideLabel(side)} ${sideCount}`,
      rowCount: next.settings.rowCount,
      now,
    }),
  ];
  touch(next, now);
  return next;
}

export function deleteFlow(round: FlowRound, flowId: string): FlowRound {
  const next = normalizeRound(round);
  if (next.flows.length <= 1) return next;

  const flows = next.flows.filter((flow) => flow.id !== flowId);
  if (flows.length === next.flows.length) return next;

  next.flows = flows;
  touch(next);
  return next;
}

export function reorderFlow(round: FlowRound, flowId: string, targetIndex: number): FlowRound {
  const next = normalizeRound(round);
  const fromIndex = next.flows.findIndex((flow) => flow.id === flowId);
  if (fromIndex < 0) return next;

  const toIndex = clampInteger(targetIndex, 0, Math.max(0, next.flows.length - 1));
  if (fromIndex === toIndex) return next;

  const flows = next.flows.slice();
  const [flow] = flows.splice(fromIndex, 1);
  if (!flow) return next;

  flows.splice(toIndex, 0, flow);
  next.flows = flows;
  touch(next);
  return next;
}

export function setCellText(
  round: FlowRound,
  flowId: string,
  rowIndex: number,
  colIndex: number,
  text: string,
): FlowRound {
  const next = normalizeRound(round);
  const flow = next.flows.find((item) => item.id === flowId);
  if (!flow) return next;

  const cell = ensureCell(flow, rowIndex, colIndex);
  if (!cell) return next;

  const now = iso();
  cell.text = String(text ?? '');
  cell.updatedAt = now;
  syncRoundRowCount(next, Math.max(next.settings.rowCount, flow.rows.length), now);
  touchFlow(flow, now);
  touch(next, now);
  return next;
}

export function copyRangeAsTsv(round: FlowRound, range: FlowRange): string {
  const normalized = normalizeRound(round);
  const flow = normalized.flows.find((item) => item.id === range.flowId);
  if (!flow) return '';

  const bounds = normalizeRange(range);
  const bounded = boundRangeToDimensions(bounds, flow.rows.length, flow.columns.length);
  if (!bounded) return '';

  const lines: string[] = [];
  for (let rowIndex = bounded.startRow; rowIndex <= bounded.endRow; rowIndex += 1) {
    const values: string[] = [];
    for (let colIndex = bounded.startCol; colIndex <= bounded.endCol; colIndex += 1) {
      values.push(cleanTsvCell(flow.rows[rowIndex]?.[colIndex]?.text ?? ''));
    }
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

export function pasteTsv(round: FlowRound, point: FlowPoint, text: string): FlowRound {
  const next = normalizeRound(round);
  const flow = next.flows.find((item) => item.id === point.flowId);
  if (!flow) return next;

  const startRow = nonNegativeInteger(point.row);
  const startCol = nonNegativeInteger(point.col);
  if (startRow >= MAX_ROW_COUNT) return next;

  const rows = parseTsv(text);
  const now = iso();
  let changed = false;
  const rowLimit = Math.min(rows.length, MAX_ROW_COUNT - startRow);

  for (let rowOffset = 0; rowOffset < rowLimit; rowOffset += 1) {
    const cells = rows[rowOffset];
    if (!cells) continue;
    const colLimit = Math.max(0, flow.columns.length - startCol);
    for (let colOffset = 0; colOffset < cells.length && colOffset < colLimit; colOffset += 1) {
      const cell = ensureCell(flow, startRow + rowOffset, startCol + colOffset);
      if (!cell) continue;
      cell.text = cells[colOffset] ?? '';
      cell.updatedAt = now;
      changed = true;
    }
  }

  if (!changed) return next;

  syncRoundRowCount(next, Math.max(next.settings.rowCount, flow.rows.length), now);
  touchFlow(flow, now);
  touch(next, now);
  return next;
}

export function toggleBoldRange(round: FlowRound, range: FlowRange): FlowRound {
  const next = normalizeRound(round);
  const flow = next.flows.find((item) => item.id === range.flowId);
  if (!flow) return next;

  const bounds = normalizeRange(range);
  const bounded = boundRangeToDimensions(bounds, MAX_ROW_COUNT, flow.columns.length);
  if (!bounded) return next;

  const cells: FlowCell[] = [];
  for (let rowIndex = bounded.startRow; rowIndex <= bounded.endRow; rowIndex += 1) {
    for (let colIndex = bounded.startCol; colIndex <= bounded.endCol; colIndex += 1) {
      const cell = ensureCell(flow, rowIndex, colIndex);
      if (!cell) continue;
      cells.push(cell);
    }
  }

  if (cells.length === 0) return next;

  const now = iso();
  const shouldBold = !cells.every((cell) => cell.bold === true);
  cells.forEach((cell) => {
    if (shouldBold) {
      cell.bold = true;
    } else {
      delete cell.bold;
    }
    cell.updatedAt = now;
  });

  syncRoundRowCount(next, Math.max(next.settings.rowCount, flow.rows.length), now);
  touchFlow(flow, now);
  touch(next, now);
  return next;
}

function normalizeFlows(rawFlows: unknown[], format: FlowFormat, rowCount: number): FlowSheet[] {
  const sideCounts: Record<FlowSide, number> = { aff: 0, neg: 0 };
  return rawFlows.map((rawFlow, index) => {
    const flow = asRecord(rawFlow);
    const title = readString(flow?.title) ?? readString(flow?.name);
    const side = readSide(flow?.side) ?? inferSide(title, index);
    sideCounts[side] += 1;
    return normalizeFlow(flow, format, rowCount, side, title ?? `${sideLabel(side)} ${sideCounts[side]}`);
  });
}

function normalizeFlow(
  rawFlow: RawRecord | undefined,
  format: FlowFormat,
  rowCount: number,
  side: FlowSide,
  fallbackTitle: string,
): FlowSheet {
  const columns = columnsForFlow(format, side);
  const rawRows = Array.isArray(rawFlow?.rows) ? rawFlow.rows : [];
  const now = iso();
  const normalizedRowCount = clampRowCount(Math.max(rowCount, rawRows.length));
  const rows = Array.from({ length: normalizedRowCount }, (_, index) =>
    normalizeRow(rawRows[index], columns, side),
  );

  return {
    id: readString(rawFlow?.id) ?? createId('flow'),
    title: cleanTitle(fallbackTitle, `${sideLabel(side)} flow`),
    side,
    columns,
    rows,
    createdAt: readString(rawFlow?.createdAt) ?? now,
    updatedAt: readString(rawFlow?.updatedAt) ?? now,
  };
}

function normalizeRow(rawRow: unknown, columns: FlowColumn[], side: FlowSide): FlowCell[] {
  if (Array.isArray(rawRow)) {
    return columns.map((_, index) => normalizeCell(rawRow[index]));
  }

  const row = asRecord(rawRow);
  const cellsByColumn = asRecord(row?.cells);
  if (cellsByColumn) {
    return columns.map((column) => normalizeCell(readMappedCell(cellsByColumn, column, side)));
  }

  return createRow(columns);
}

function normalizeCell(rawCell: unknown): FlowCell {
  if (!isRecord(rawCell)) {
    return createCell(rawCell == null ? '' : String(rawCell));
  }

  const marks = asRecord(rawCell.marks);
  return {
    id: readString(rawCell.id) ?? createId('cell'),
    text: String(rawCell.text ?? ''),
    ...(readBoolean(rawCell.bold) ?? readBoolean(marks?.bold) ? { bold: true } : {}),
    ...(readBoolean(rawCell.italic) ?? readBoolean(marks?.italic) ? { italic: true } : {}),
    ...(readBoolean(rawCell.underline) ?? readBoolean(marks?.underline) ? { underline: true } : {}),
    ...(readString(rawCell.color) ? { color: readString(rawCell.color) } : {}),
    ...(readString(rawCell.backgroundColor) ? { backgroundColor: readString(rawCell.backgroundColor) } : {}),
    ...(readString(rawCell.updatedAt) ? { updatedAt: readString(rawCell.updatedAt) } : {}),
  };
}

function readMappedCell(cellsByColumn: RawRecord, column: FlowColumn, side: FlowSide): unknown {
  const aliases = columnAliases(column, side);
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(cellsByColumn, key)) return cellsByColumn[key];
  }
  return undefined;
}

function columnAliases(column: FlowColumn, side: FlowSide): string[] {
  const base = [column.id, column.label, slug(column.label)];
  const legacyAliases: Record<string, string[]> = {
    '1ac': ['ac'],
    '1nc': ['nc'],
    '2nr': ['nr'],
    block: ['2nc', '1nr'],
    ac: side === 'aff' ? ['case', 'pro-case'] : ['pro-case'],
    nc: side === 'neg' ? ['case', 'con-case'] : ['con-case'],
    ar: side === 'aff' ? ['rebuttal', 'pro-rebuttal'] : ['pro-rebuttal'],
    nr: side === 'neg' ? ['rebuttal', 'con-rebuttal'] : ['con-rebuttal'],
    as: side === 'aff' ? ['summary', 'pro-summary'] : ['pro-summary'],
    ns: side === 'neg' ? ['summary', 'con-summary'] : ['con-summary'],
    af: side === 'aff' ? ['final-focus', 'pro-final-focus'] : ['pro-final-focus'],
    nf: side === 'neg' ? ['final-focus', 'con-final-focus'] : ['con-final-focus'],
  };
  return [...base, ...(legacyAliases[column.id] ?? [])];
}

function normalizeSettings(
  rawSettings: RawRecord | undefined,
  format: FlowFormat,
  rowCount: number,
): FlowRoundSettings {
  const rawLayout = asRecord(rawSettings?.layout);
  const rawColors = asRecord(rawSettings?.colors);

  return {
    defaultFormat: normalizeFormat(rawSettings?.defaultFormat, format),
    rowCount,
    zoomPercent: clampZoom(rawSettings?.zoomPercent),
    layout: {
      flowWidthPercent: clampNumber(rawLayout?.flowWidthPercent, 30, 100, 70),
      collapsed: readBoolean(rawLayout?.collapsed) ?? false,
    },
    colors: {
      aff: normalizeColor(rawColors?.aff, DEFAULT_COLORS.aff),
      neg: normalizeColor(rawColors?.neg, DEFAULT_COLORS.neg),
      selection: normalizeColor(rawColors?.selection, DEFAULT_COLORS.selection),
    },
  };
}

function createSettings(format: FlowFormat, rowCount: number): FlowRoundSettings {
  return {
    defaultFormat: format,
    rowCount,
    zoomPercent: DEFAULT_ZOOM_PERCENT,
    layout: { flowWidthPercent: 70, collapsed: false },
    colors: { ...DEFAULT_COLORS },
  };
}

function defaultFlows(format: FlowFormat, rowCount: number, now: string): FlowSheet[] {
  return [
    createFlowSheet({ format, side: 'aff', title: 'AFF 1', rowCount, now }),
    createFlowSheet({ format, side: 'neg', title: 'NEG 1', rowCount, now }),
  ];
}

function createFlowSheet(options: {
  format: FlowFormat;
  side: FlowSide;
  title: string;
  rowCount: number;
  now: string;
}): FlowSheet {
  const columns = columnsForFlow(options.format, options.side);
  return {
    id: createId('flow'),
    title: options.title,
    side: options.side,
    columns,
    rows: createRows(options.rowCount, columns),
    createdAt: options.now,
    updatedAt: options.now,
  };
}

function columnsForFlow(format: FlowFormat, side: FlowSide): FlowColumn[] {
  return COLUMN_LABELS[format][side].map((label) => ({ id: slug(label), label }));
}

function createRows(count: number, columns: FlowColumn[]): FlowCell[][] {
  return Array.from({ length: clampRowCount(count) }, () => createRow(columns));
}

function createRow(columns: FlowColumn[]): FlowCell[] {
  return columns.map(() => createCell(''));
}

function createCell(text: string): FlowCell {
  return {
    id: createId('cell'),
    text,
  };
}

function ensureCell(flow: FlowSheet, rowIndex: number, colIndex: number): FlowCell | undefined {
  const safeRow = nonNegativeInteger(rowIndex);
  if (safeRow >= MAX_ROW_COUNT) return undefined;

  const safeCol = nonNegativeInteger(colIndex);
  if (safeCol >= flow.columns.length) return undefined;

  const row = ensureRow(flow, safeRow);
  let cell = row[safeCol];
  if (!cell) {
    cell = createCell('');
    row[safeCol] = cell;
  }
  return cell;
}

function syncRoundRowCount(round: FlowRound, rowCount: number, now: string): void {
  const nextRowCount = clampRowCount(Math.max(round.settings.rowCount, rowCount));
  round.settings.rowCount = nextRowCount;
  round.flows.forEach((flow) => {
    if (flow.rows.length >= nextRowCount) return;
    while (flow.rows.length < nextRowCount) {
      flow.rows.push(createRow(flow.columns));
    }
    touchFlow(flow, now);
  });
}

function ensureRow(flow: FlowSheet, rowIndex: number): FlowCell[] {
  const safeRow = nonNegativeInteger(rowIndex);
  while (flow.rows.length <= safeRow) {
    flow.rows.push(createRow(flow.columns));
  }
  const row = flow.rows[safeRow];
  if (row) return row;

  const next = createRow(flow.columns);
  flow.rows[safeRow] = next;
  return next;
}

function normalizeRange(range: FlowRange): FlowRange {
  return {
    flowId: range.flowId,
    startRow: Math.min(nonNegativeInteger(range.startRow), nonNegativeInteger(range.endRow)),
    startCol: Math.min(nonNegativeInteger(range.startCol), nonNegativeInteger(range.endCol)),
    endRow: Math.max(nonNegativeInteger(range.startRow), nonNegativeInteger(range.endRow)),
    endCol: Math.max(nonNegativeInteger(range.startCol), nonNegativeInteger(range.endCol)),
  };
}

function boundRangeToDimensions(range: FlowRange, rowLimit: number, colLimit: number): FlowRange | undefined {
  const safeRowLimit = clampInteger(rowLimit, 0, MAX_ROW_COUNT);
  const safeColLimit = nonNegativeInteger(colLimit);
  if (safeRowLimit <= 0 || safeColLimit <= 0) return undefined;
  if (range.startRow >= safeRowLimit || range.startCol >= safeColLimit) return undefined;

  const startRow = range.startRow;
  const startCol = range.startCol;
  let endRow = Math.min(range.endRow, safeRowLimit - 1);
  let endCol = Math.min(range.endCol, safeColLimit - 1);
  if (endRow < startRow || endCol < startCol) return undefined;

  const requestedCols = endCol - startCol + 1;
  if (requestedCols > MAX_RANGE_CELLS) {
    endCol = startCol + MAX_RANGE_CELLS - 1;
    endRow = startRow;
    return { flowId: range.flowId, startRow, startCol, endRow, endCol };
  }

  const maxRows = Math.max(1, Math.floor(MAX_RANGE_CELLS / requestedCols));
  endRow = Math.min(endRow, startRow + maxRows - 1);
  return { flowId: range.flowId, startRow, startCol, endRow, endCol };
}

function parseTsv(text: string): string[][] {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((row) => row.split('\t'));
}

function cleanTsvCell(text: string): string {
  return String(text ?? '').replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ');
}

function resolveRowCount(rawRowCount: unknown, rawFlows: unknown[]): number {
  const rowCount = readPositiveInteger(rawRowCount) ?? DEFAULT_ROW_COUNT;
  const maxFlowRows = rawFlows.reduce<number>((max, flow) => {
    const rows = asRecord(flow)?.rows;
    return Array.isArray(rows) ? Math.max(max, rows.length) : max;
  }, 0);
  return clampRowCount(Math.max(rowCount, maxFlowRows));
}

function clampRowCount(value: unknown): number {
  return clampInteger(value, DEFAULT_ROW_COUNT, MAX_ROW_COUNT);
}

function normalizeFormat(value: unknown, fallback: FlowFormat = 'ld'): FlowFormat {
  return value === 'ld' || value === 'pf' || value === 'policy' ? value : fallback;
}

function readSide(value: unknown): FlowSide | undefined {
  if (value === 'aff' || value === 'neg') return value;
  return undefined;
}

function inferSide(title: string | undefined, index: number): FlowSide {
  const normalizedTitle = title?.trim().toLowerCase() ?? '';
  if (normalizedTitle.startsWith('neg')) return 'neg';
  if (normalizedTitle.startsWith('aff')) return 'aff';
  return index % 2 === 1 ? 'neg' : 'aff';
}

function sideLabel(side: FlowSide): string {
  return side === 'neg' ? 'NEG' : 'AFF';
}

function touch(round: FlowRound, now = iso()): void {
  round.updatedAt = now;
}

function touchFlow(flow: FlowSheet, now = iso()): void {
  flow.updatedAt = now;
}

function cleanTitle(value: unknown, fallback: string): string {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return title || fallback;
}

function clampZoom(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ZOOM_PERCENT;
  return clampInteger(Math.round(numeric / 10) * 10, MIN_ZOOM_PERCENT, MAX_ZOOM_PERCENT);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function nonNegativeInteger(value: unknown): number {
  return clampInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeColor(value: unknown, fallback: string): string {
  const color = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return undefined;
  return numeric;
}

function asRecord(value: unknown): RawRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function iso(): string {
  return new Date().toISOString();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
