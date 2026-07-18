/**
 * Fuzz skeleton for the collab track: seeded random edits against the
 * real schema with the normalizer trio active. Invariants after every
 * seed: the doc stays schema-valid, the normalizer round cap never
 * trips, and the repair pass finds nothing (or repairs idempotently).
 * The CRDT bindings slot into this harness later; the invariants stay.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { addRowAfter, addColumnAfter, deleteRow } from 'prosemirror-tables';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';
import { citeClassifierPlugin } from '../../src/editor/cite-classifier-plugin.js';
import { namedStyleNormalizerPlugin } from '../../src/editor/named-style-normalizer-plugin.js';
import { buildDocRepairTr, repairDoc } from '../../src/doc-repair.js';

const n = schema.nodes;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function para(text: string) {
  return n['paragraph']!.create(null, schema.text(text));
}
function seedDoc() {
  const cellPara = (t: string) => n['table_cell']!.create(null, [para(t)]);
  return n['doc']!.createChecked(null, [
    para('The quick fox jumped over the lazy dog near the riverbank today.'),
    n['card']!.create(null, [
      n['tag']!.create({ id: newHeadingId() }, schema.text('Warming causes conflict')),
      n['card_body']!.create(null, schema.text('Rising temperatures drive resource scarcity.')),
    ]),
    n['table']!.create(null, [
      n['table_row']!.create(null, [cellPara('c00'), cellPara('c01'), cellPara('c02')]),
      n['table_row']!.create(null, [cellPara('c10'), cellPara('c11'), cellPara('c12')]),
    ]),
    para('Second analytic paragraph with more evidence text to edit here.'),
  ]);
}

interface Block { start: number; end: number }
function textblocks(state: EditorState): Block[] {
  const out: Block[] = [];
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return false;
    }
    return true;
  });
  return out;
}

const MARKS = ['highlight', 'bold', 'cite_mark', 'shading'] as const;

function randomOp(rnd: () => number, state: EditorState): EditorState {
  const blocks = textblocks(state);
  const b = blocks[Math.floor(rnd() * blocks.length)]!;
  const pos = b.start + Math.floor(rnd() * Math.max(1, b.end - b.start));
  const roll = rnd();
  try {
    if (roll < 0.4) {
      return state.apply(state.tr.insertText(' word', pos));
    } else if (roll < 0.55) {
      const to = Math.min(b.end, pos + 1 + Math.floor(rnd() * 6));
      return to > pos ? state.apply(state.tr.delete(pos, to)) : state;
    } else if (roll < 0.75) {
      const to = Math.min(b.end, pos + 2 + Math.floor(rnd() * 10));
      if (to <= pos) return state;
      const name = MARKS[Math.floor(rnd() * MARKS.length)]!;
      const mark = name === 'highlight'
        ? schema.marks['highlight']!.create({ color: 'green' })
        : name === 'shading'
          ? schema.marks['shading']!.create({ color: 'D2D2D2' })
          : schema.marks[name]!.create();
      return state.apply(state.tr.addMark(pos, to, mark));
    } else if (roll < 0.85) {
      return state.apply(state.tr.split(pos));
    } else if (roll < 0.92) {
      return state.apply(state.tr.insert(state.doc.content.size, para('appended paragraph')));
    } else {
      const cells: number[] = [];
      state.doc.descendants((node, p) => {
        if (node.type.name === 'table_cell') { cells.push(p + 2); return false; }
        return true;
      });
      if (!cells.length) return state;
      const cellPos = cells[Math.floor(rnd() * cells.length)]!;
      const sel = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, Math.min(cellPos, state.doc.content.size))),
      );
      const cmd = [addRowAfter, addColumnAfter, deleteRow][Math.floor(rnd() * 3)]!;
      let out = sel;
      cmd(sel, (tr) => { out = sel.apply(tr); });
      return out;
    }
  } catch {
    // An op that is invalid at this position (e.g. an unsplittable
    // boundary) is simply skipped — the fuzzer probes outcomes, not
    // whether every random position is legal.
    return state;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('collab fuzz skeleton (normalizer trio, real schema)', () => {
  it('keeps the doc valid across 25 seeds x 25 random ops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed);
      let state = EditorState.create({
        doc: seedDoc(),
        plugins: [absorbPlugin, citeClassifierPlugin, namedStyleNormalizerPlugin],
      });
      for (let i = 0; i < 25; i++) state = randomOp(rnd, state);
      expect(() => state.doc.check(), `seed ${seed}`).not.toThrow();
      const repairTr = buildDocRepairTr(state);
      if (repairTr) {
        // Anything repairable must repair idempotently.
        const once = repairDoc(state.doc);
        expect(repairDoc(once), `seed ${seed} repair idempotence`).toBe(once);
      }
    }
    // The round cap warning must never fire under normal editing.
    expect(warn).not.toHaveBeenCalled();
  });
});
