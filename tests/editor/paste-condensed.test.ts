/**
 * Paste-and-Condense core: paste plain text like F2, then destructively condense
 * just the inserted range with paragraph integrity OFF. The clipboard read +
 * desktop gating are exercised live; here we drive the shared
 * `pasteTextAndCondense` helper directly.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { pasteTextAndCondense } from '../../src/editor/ribbon-commands.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

/** Minimal view over `d` with the cursor at the end of the first card_body. */
function fakeView(d: PMNode) {
  let state = EditorState.create({ doc: d });
  let pos = 1;
  d.descendants((n, p) => {
    if (n.type.name === 'card_body') pos = p + 1 + n.content.size;
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  return {
    get state() {
      return state;
    },
    dispatch(tr: unknown) {
      state = state.apply(tr as never);
    },
  };
}

function bodyTexts(d: PMNode): string[] {
  const out: string[] = [];
  d.descendants((n) => {
    if (n.type.name === 'card_body') out.push(n.textContent);
  });
  return out;
}

describe('pasteTextAndCondense', () => {
  it('merges a multi-line paste into a single card_body (destructive, no integrity)', () => {
    const view = fakeView(doc(card(tag('T'), cardBody('start '))));
    pasteTextAndCondense(view as never, 'one\ntwo\nthree', 'respect');
    const bodies = bodyTexts(view.state.doc);
    // The three pasted lines + the original body are one consecutive collapsible
    // run, so the destructive condense merges them into a single card_body.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('one');
    expect(bodies[0]).toContain('two');
    expect(bodies[0]).toContain('three');
    // No paragraph break survived between the pasted lines.
    expect(bodies[0]).not.toMatch(/\n/);
  });

  it('is a no-op on empty clipboard text', () => {
    const view = fakeView(doc(card(tag('T'), cardBody('body'))));
    const before = view.state.doc;
    pasteTextAndCondense(view as never, '', 'respect');
    expect(view.state.doc.eq(before)).toBe(true);
  });
});
