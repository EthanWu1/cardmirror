import { describe, expect, it } from 'vitest';
import {
  addFlow,
  copyRangeAsTsv,
  createRound,
  deleteFlow,
  flowlineVersion,
  normalizeRound,
  pasteTsv,
  reorderFlow,
  setCellText,
  toggleBoldRange,
} from '../../src/editor/flow/flow-model.js';

describe('flow model', () => {
  const MAX_ROW_COUNT = 1000;
  const MAX_RANGE_CELLS = 10000;

  it('reports the native flowline model version', () => {
    expect(flowlineVersion()).toBe(34);
    expect(createRound({ format: 'ld', title: 'Round' }).flowlineVersion).toBe(34);
  });

  it('creates a Verba-compatible LD round with two default flows and 40 rows', () => {
    const round = createRound({ format: 'ld', title: 'Unnamed1' });
    expect(round.title).toBe('Unnamed1');
    expect(round.format).toBe('ld');
    expect(round.flows.map((flow) => flow.title)).toEqual(['AFF 1', 'NEG 1']);
    expect(round.flows[0]?.rows).toHaveLength(40);
    expect(round.flows[0]?.columns.length).toBeGreaterThan(1);
  });

  it('uses Verba Flowline side-sensitive column labels for every format', () => {
    const expected = {
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
    } as const;

    for (const format of ['ld', 'pf', 'policy'] as const) {
      const round = createRound({ format, title: 'Round' });
      expect(round.flows[0]?.columns.map((column) => column.label)).toEqual(expected[format].aff);
      expect(round.flows[1]?.columns.map((column) => column.label)).toEqual(expected[format].neg);
    }
  });

  it('maps generic PF legacy aliases by flow side', () => {
    const affRound = normalizeRound({
      format: 'pf',
      flows: [
        {
          title: 'AFF legacy',
          side: 'aff',
          rows: [{ cells: { case: { text: 'aff case' }, rebuttal: { text: 'aff rebuttal' } } }],
        },
      ],
    });
    const affRow = affRound.flows[0]!.rows[0]!;
    expect(affRow[0]!.text).toBe('aff case');
    expect(affRow[1]!.text).toBe('');
    expect(affRow[2]!.text).toBe('aff rebuttal');
    expect(affRow[3]!.text).toBe('');

    const negRound = normalizeRound({
      format: 'pf',
      flows: [
        {
          title: 'NEG legacy',
          side: 'neg',
          rows: [{ cells: { case: { text: 'neg case' }, rebuttal: { text: 'neg rebuttal' } } }],
        },
      ],
    });
    const negRow = negRound.flows[0]!.rows[0]!;
    expect(negRow[0]!.text).toBe('neg case');
    expect(negRow[1]!.text).toBe('');
    expect(negRow[2]!.text).toBe('neg rebuttal');
    expect(negRow[3]!.text).toBe('');
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

  it('pastes CRLF TSV rows the same way as LF rows', () => {
    const lfRound = createRound({ format: 'ld', title: 'Round' });
    const lfFlowId = lfRound.flows[0]!.id;
    const crlfRound = createRound({ format: 'ld', title: 'Round' });
    const crlfFlowId = crlfRound.flows[0]!.id;

    const lfPasted = pasteTsv(lfRound, { flowId: lfFlowId, row: 1, col: 0 }, 'a\tb\nc\td');
    const crlfPasted = pasteTsv(crlfRound, { flowId: crlfFlowId, row: 1, col: 0 }, 'a\tb\r\nc\td');

    expect(crlfPasted.flows[0]!.rows[1]![0]!.text).toBe(lfPasted.flows[0]!.rows[1]![0]!.text);
    expect(crlfPasted.flows[0]!.rows[1]![1]!.text).toBe(lfPasted.flows[0]!.rows[1]![1]!.text);
    expect(crlfPasted.flows[0]!.rows[2]![0]!.text).toBe(lfPasted.flows[0]!.rows[2]![0]!.text);
    expect(crlfPasted.flows[0]!.rows[2]![1]!.text).toBe(lfPasted.flows[0]!.rows[2]![1]!.text);
  });

  it('caps hostile saved row counts and stringifies object cell text', () => {
    const round = normalizeRound({
      format: 'ld',
      settings: { rowCount: 999999 },
      flows: [
        {
          side: 'aff',
          rows: Array.from({ length: MAX_ROW_COUNT + 1 }, (_, index) =>
            index === 0 ? { cells: { '1ac': { text: 123 } } } : undefined,
          ),
        },
      ],
    });

    expect(round.settings.rowCount).toBe(MAX_ROW_COUNT);
    expect(round.flows[0]!.rows).toHaveLength(MAX_ROW_COUNT);
    expect(round.flows[0]!.rows[0]![0]!.text).toBe('123');
  });

  it('does not grow rows beyond the cap for out-of-range writes and pastes', () => {
    const round = createRound({ format: 'ld', title: 'Round' });
    const flowId = round.flows[0]!.id;

    const written = setCellText(round, flowId, MAX_ROW_COUNT, 0, 'too far');
    expect(written.settings.rowCount).toBe(40);
    expect(written.flows.map((flow) => flow.rows.length)).toEqual([40, 40]);

    const pasted = pasteTsv(round, { flowId, row: MAX_ROW_COUNT, col: 0 }, 'too far');
    expect(pasted.settings.rowCount).toBe(40);
    expect(pasted.flows.map((flow) => flow.rows.length)).toEqual([40, 40]);
  });

  it('bounds huge copy ranges to the normalized flow dimensions', () => {
    const round = createRound({ format: 'ld', title: 'Round' });
    const flowId = round.flows[0]!.id;
    const copied = copyRangeAsTsv(round, {
      flowId,
      startRow: 0,
      startCol: 0,
      endRow: 45,
      endCol: MAX_ROW_COUNT,
    });
    const lines = copied.split('\n');

    expect(lines).toHaveLength(40);
    expect(lines[0]!.split('\t')).toHaveLength(5);
    expect(lines.length * lines[0]!.split('\t').length).toBeLessThanOrEqual(MAX_RANGE_CELLS);
  });

  it('bounds huge bold ranges to capped rows and range cells', () => {
    const round = createRound({ format: 'ld', title: 'Round' });
    const flowId = round.flows[0]!.id;
    const next = toggleBoldRange(round, {
      flowId,
      startRow: 0,
      startCol: 0,
      endRow: MAX_ROW_COUNT,
      endCol: MAX_ROW_COUNT,
    });
    const boldCount = next.flows[0]!.rows.reduce(
      (count, row) => count + row.filter((cell) => cell.bold === true).length,
      0,
    );

    expect(next.settings.rowCount).toBe(MAX_ROW_COUNT);
    expect(next.flows.map((flow) => flow.rows.length)).toEqual([MAX_ROW_COUNT, MAX_ROW_COUNT]);
    expect(boldCount).toBeLessThanOrEqual(MAX_RANGE_CELLS);
  });

  it('extends every flow when mutations grow past the default row count', () => {
    let textRound = createRound({ format: 'ld', title: 'Round' });
    textRound = setCellText(textRound, textRound.flows[0]!.id, 45, 0, 'late');
    expect(textRound.settings.rowCount).toBe(46);
    expect(textRound.flows.map((flow) => flow.rows.length)).toEqual([46, 46]);

    let pasteRound = createRound({ format: 'ld', title: 'Round' });
    pasteRound = pasteTsv(pasteRound, { flowId: pasteRound.flows[0]!.id, row: 45, col: 0 }, 'late');
    expect(pasteRound.settings.rowCount).toBe(46);
    expect(pasteRound.flows.map((flow) => flow.rows.length)).toEqual([46, 46]);

    let boldRound = createRound({ format: 'ld', title: 'Round' });
    boldRound = toggleBoldRange(boldRound, {
      flowId: boldRound.flows[0]!.id,
      startRow: 45,
      startCol: 0,
      endRow: 45,
      endCol: 0,
    });
    expect(boldRound.settings.rowCount).toBe(46);
    expect(boldRound.flows.map((flow) => flow.rows.length)).toEqual([46, 46]);
  });

  it('sets a mixed bold range to bold instead of inverting each cell independently', () => {
    let round = createRound({ format: 'ld', title: 'Round' });
    const flowId = round.flows[0]!.id;

    round = toggleBoldRange(round, { flowId, startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    round = toggleBoldRange(round, { flowId, startRow: 0, startCol: 0, endRow: 0, endCol: 1 });

    expect(round.flows[0]!.rows[0]![0]!.bold).toBe(true);
    expect(round.flows[0]!.rows[0]![1]!.bold).toBe(true);
  });

  it('clears an all-bold range', () => {
    let round = createRound({ format: 'ld', title: 'Round' });
    const flowId = round.flows[0]!.id;

    round = toggleBoldRange(round, { flowId, startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
    round = toggleBoldRange(round, { flowId, startRow: 0, startCol: 0, endRow: 0, endCol: 1 });

    expect(round.flows[0]!.rows[0]![0]!.bold).toBeUndefined();
    expect(round.flows[0]!.rows[0]![1]!.bold).toBeUndefined();
  });

  it('normalizes partial legacy rounds into a valid FlowRound', () => {
    const round = normalizeRound({
      title: '  Legacy round  ',
      settings: { defaultFormat: 'policy', rowCount: 2, zoomPercent: 999 },
      flows: [
        {
          id: 'legacy-flow',
          name: 'NEG legacy',
          side: 'neg',
          rows: [{ cells: { '2nc': { id: 'legacy-cell', text: 'block text' } } }],
        },
      ],
    });

    expect(round.title).toBe('Legacy round');
    expect(round.format).toBe('policy');
    expect(round.flowlineVersion).toBe(34);
    expect(round.settings.rowCount).toBe(40);
    expect(round.settings.zoomPercent).toBe(160);
    expect(round.flows[0]?.title).toBe('NEG legacy');
    expect(round.flows[0]?.columns.map((column) => column.label)).toEqual([
      '1NC',
      '2AC',
      'Block',
      '1AR',
      '2NR',
      '2AR',
    ]);
    expect(round.flows[0]?.rows).toHaveLength(40);
    expect(round.flows[0]?.rows[0]?.[2]?.text).toBe('block text');
  });

  it('keeps source rounds immutable and updates affected sheet timestamps for cell mutations', () => {
    const original = createRound({ format: 'ld', title: 'Round' });
    const flowId = original.flows[0]!.id;
    const stale = '2000-01-01T00:00:00.000Z';
    const round = {
      ...original,
      flows: [{ ...original.flows[0]!, updatedAt: stale }, original.flows[1]!],
    };

    const textNext = setCellText(round, flowId, 0, 0, 'link');
    const pasteNext = pasteTsv(round, { flowId, row: 1, col: 0 }, 'a');
    const boldNext = toggleBoldRange(round, { flowId, startRow: 0, startCol: 0, endRow: 0, endCol: 0 });

    expect(round.flows[0]!.rows[0]![0]!.text).toBe('');
    expect(round.flows[0]!.rows[1]![0]!.text).toBe('');
    expect(round.flows[0]!.rows[0]![0]!.bold).toBeUndefined();
    expect(round.flows[0]!.updatedAt).toBe(stale);
    expect(textNext.flows[0]).not.toBe(round.flows[0]);
    expect(textNext.flows[0]!.rows).not.toBe(round.flows[0]!.rows);
    expect(textNext.flows[0]!.updatedAt).not.toBe(stale);
    expect(pasteNext.flows[0]!.updatedAt).not.toBe(stale);
    expect(boldNext.flows[0]!.updatedAt).not.toBe(stale);
  });
});
