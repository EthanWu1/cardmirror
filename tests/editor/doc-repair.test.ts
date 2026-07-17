/**
 * Deterministic document repair (`src/doc-repair.ts`): ragged tables,
 * excluded-mark co-presence, and container first-child violations —
 * states externally built content can carry but local editing cannot
 * produce. The pass must be idempotent and leave valid docs untouched.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { buildDocRepairTr, repairDoc } from '../../src/doc-repair.js';

const n = schema.nodes;
const m = schema.marks;

function para(text: string) {
  return n['paragraph']!.create(null, schema.text(text));
}
function cell(text: string) {
  return n['table_cell']!.create(null, [para(text)]);
}
function row(...cells: ReturnType<typeof cell>[]) {
  return n['table_row']!.create(null, cells);
}
function rowWidths(doc: PMNode): number[][] {
  const shapes: number[][] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'table') return true;
    const widths: number[] = [];
    node.forEach((r) => {
      let w = 0;
      r.forEach((c) => { w += (c.attrs['colspan'] as number) ?? 1; });
      widths.push(w);
    });
    shapes.push(widths);
    return false;
  });
  return shapes;
}

describe('table repair', () => {
  it('pads ragged rows to a rectangle, idempotently', () => {
    const table = n['table']!.create(null, [
      row(cell('a'), cell('b'), cell('c')),
      row(cell('d')),
      row(cell('e'), cell('f')),
    ]);
    const doc = n['doc']!.create(null, [table]);
    const repaired = repairDoc(doc);
    expect(rowWidths(repaired)).toEqual([[3, 3, 3]]);
    expect(() => repaired.check()).not.toThrow();
    // Cell content survives the padding.
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(repaired.textContent).toContain(text);
    }
    expect(repairDoc(repaired)).toBe(repaired);
  });
});

describe('excluded-mark sweep', () => {
  it('keeps the earlier-declared mark of a co-present pair', () => {
    // Node construction skips Mark.addToSet, so both marks of an
    // `excludes` pair can co-exist until repaired.
    const text = schema.text('shouty', [m['bold']!.create(), m['bold_off']!.create()]);
    const doc = n['doc']!.create(null, [n['paragraph']!.create(null, text)]);
    const repaired = repairDoc(doc);
    const marks = repaired.child(0).firstChild!.marks.map((x) => x.type.name);
    expect(marks).toContain('bold');
    expect(marks).not.toContain('bold_off');
    expect(repairDoc(repaired)).toBe(repaired);
  });
});

describe('container first-child repair', () => {
  it('inserts the missing tag so the card satisfies its content expression', () => {
    const card = n['card']!.create(null, [
      n['card_body']!.create(null, schema.text('evidence text')),
    ]);
    const doc = n['doc']!.create(null, [card]);
    expect(() => doc.check()).toThrow();
    const repaired = repairDoc(doc);
    expect(() => repaired.check()).not.toThrow();
    expect(repaired.child(0).firstChild!.type.name).toBe('tag');
    expect(repaired.textContent).toContain('evidence text');
    expect(repairDoc(repaired)).toBe(repaired);
  });
});

describe('no-op on valid docs', () => {
  it('returns null / the same node for an already-valid doc', () => {
    const doc = n['doc']!.createChecked(null, [para('all is well')]);
    expect(buildDocRepairTr(EditorState.create({ doc }))).toBeNull();
    expect(repairDoc(doc)).toBe(doc);
  });
});
