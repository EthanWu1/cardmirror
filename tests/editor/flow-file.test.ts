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
    expect(parsed.version).toBe(1);
    expect(parsed.flowlineVersion).toBe(34);
    expect(parsed.round.title).toBe('Case Flow');
    expect(parsed.round.flows).toHaveLength(2);
  });

  it('serializes a raw cmflow wrapper payload', () => {
    const round = createRound({ format: 'ld', title: 'Raw Wrapper' });
    const bytes = serializeFlowFile({
      round,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T01:00:00.000Z',
    });
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    expect(raw.kind).toBe('cardmirror-flow');
    expect(raw.version).toBe(1);
    expect(raw.flowlineVersion).toBe(34);
    expect(raw.round).toEqual(expect.objectContaining({ title: 'Raw Wrapper', format: 'ld', flowlineVersion: 34 }));
    expect(raw.round.flows).toHaveLength(2);
    expect(raw.createdAt).toBe('2026-07-16T00:00:00.000Z');
    expect(raw.updatedAt).toBe('2026-07-16T01:00:00.000Z');
  });

  it('imports and exports Verba Flowline JSON payloads', () => {
    const round = createRound({ format: 'pf', title: 'PF Round' });
    const flowline = exportFlowlineJson(round);
    const exported = JSON.parse(flowline);
    expect(exported.kind).toBeUndefined();
    expect(exported.title).toBe('PF Round');
    const imported = parseFlowlineJson(new TextEncoder().encode(flowline));
    expect(imported.title).toBe('PF Round');
    expect(imported.format).toBe('pf');
  });

  it('imports Flowline JSON with a round property', () => {
    const round = createRound({ format: 'policy', title: 'Wrapped Round' });
    const bytes = new TextEncoder().encode(JSON.stringify({ round }));
    expect(parseFlowlineJson(bytes).title).toBe('Wrapped Round');
  });

  it('normalizes partial flow payloads on import', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ title: 'Partial', format: 'ld', flows: [] }));
    const imported = parseFlowlineJson(bytes);
    expect(imported.title).toBe('Partial');
    expect(imported.flows.map((flow) => flow.title)).toEqual(['AFF 1', 'NEG 1']);
  });

  it('rejects invalid JSON with a stable error message', () => {
    expectThrownMessage(() => parseFlowFile(new TextEncoder().encode('{')), 'Flow file is not valid JSON.');
  });

  it('rejects wrappers that are not CardMirror Flow files', () => {
    const wrongKind = new TextEncoder().encode(JSON.stringify({ kind: 'other' }));
    const missingKind = new TextEncoder().encode(JSON.stringify({ version: 1, round: createRound() }));
    expectThrownMessage(() => parseFlowFile(wrongKind), 'Flow file is not a CardMirror Flow wrapper.');
    expectThrownMessage(() => parseFlowFile(missingKind), 'Flow file is not a CardMirror Flow wrapper.');
  });

  it('rejects cmflow wrappers without an object round payload', () => {
    const missingRound = new TextEncoder().encode(JSON.stringify({ kind: 'cardmirror-flow', version: 1 }));
    const nullRound = new TextEncoder().encode(JSON.stringify({ kind: 'cardmirror-flow', version: 1, round: null }));
    const arrayRound = new TextEncoder().encode(JSON.stringify({ kind: 'cardmirror-flow', version: 1, round: [] }));
    expect(() => parseFlowFile(missingRound)).toThrow(/CardMirror Flow round/);
    expect(() => parseFlowFile(nullRound)).toThrow(/CardMirror Flow round/);
    expect(() => parseFlowFile(arrayRound)).toThrow(/CardMirror Flow round/);
  });

  it('rejects unsupported cmflow wrapper versions', () => {
    const unsupported = new TextEncoder().encode(
      JSON.stringify({ kind: 'cardmirror-flow', version: 2, round: createRound() }),
    );
    const missing = new TextEncoder().encode(JSON.stringify({ kind: 'cardmirror-flow', round: createRound() }));
    expect(() => parseFlowFile(unsupported)).toThrow(/CardMirror Flow version/);
    expect(() => parseFlowFile(missing)).toThrow(/CardMirror Flow version/);
  });

  it('rejects Flowline JSON that is not an object round payload', () => {
    const scalar = new TextEncoder().encode(JSON.stringify('not a round'));
    const directNull = new TextEncoder().encode(JSON.stringify(null));
    const directArray = new TextEncoder().encode(JSON.stringify([]));
    const nullRound = new TextEncoder().encode(JSON.stringify({ round: null }));
    expect(() => parseFlowlineJson(scalar)).toThrow(/Flowline JSON/);
    expect(() => parseFlowlineJson(directNull)).toThrow(/Flowline JSON/);
    expect(() => parseFlowlineJson(directArray)).toThrow(/Flowline JSON/);
    expect(() => parseFlowlineJson(nullRound)).toThrow(/Flowline JSON/);
  });
});

function expectThrownMessage(run: () => unknown, message: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(message);
}
