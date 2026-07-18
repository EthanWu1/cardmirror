import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { flipQuoteDirection } from '../../src/editor/flip-quote-direction.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (...content: PMNode[]) => schema.nodes['card_body']!.create(null, content);
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

function bodyText(d: PMNode): string {
  let out = '';
  d.descendants((node) => {
    if (node.type.name === 'card_body') out = node.textContent;
  });
  return out;
}

/** Select the whole first card_body and run the command. */
function flipWholeBody(d: PMNode) {
  let state = EditorState.create({ doc: d });
  let from = 0,
    to = 0;
  d.descendants((node, pos) => {
    if (node.type.name === 'card_body') {
      from = pos + 1;
      to = pos + 1 + node.content.size;
    }
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  let dispatched = false;
  const ret = flipQuoteDirection(state, (tr) => {
    state = state.apply(tr);
    dispatched = true;
  });
  return { ret, state, dispatched };
}

describe('flipQuoteDirection', () => {
  it('flips every curly quote in the selection to the opposite direction', () => {
    const d = doc(card(tag('T'), cardBody(schema.text('“hi” and ‘yo’'))));
    const { ret, state } = flipWholeBody(d);
    expect(ret).toBe(true);
    expect(bodyText(state.doc)).toBe('”hi“ and ’yo‘');
  });

  it('leaves straight quotes and other characters untouched (and reports no-op)', () => {
    const d = doc(card(tag('T'), cardBody(schema.text(`it's "fine" - ok`))));
    const { ret, state } = flipWholeBody(d);
    expect(ret).toBe(false); // no curly quotes in range → nothing to flip
    expect(bodyText(state.doc)).toBe(`it's "fine" - ok`);
  });

  it('preserves marks on the flipped characters', () => {
    const bold = schema.marks['bold']!.create();
    const d = doc(card(tag('T'), cardBody(schema.text('“x”', [bold]))));
    const { state } = flipWholeBody(d);
    expect(bodyText(state.doc)).toBe('”x“');
    let allBold = true;
    state.doc.descendants((node, _pos, parent) => {
      if (node.isText && parent?.type.name === 'card_body') {
        if (!node.marks.some((m) => m.type.name === 'bold')) allBold = false;
      }
    });
    expect(allBold).toBe(true);
  });

  it('does nothing with an empty selection (selection-only)', () => {
    const d = doc(card(tag('T'), cardBody(schema.text('“hi”'))));
    let state = EditorState.create({ doc: d });
    let pos = 0;
    d.descendants((node, p) => {
      if (node.type.name === 'card_body') pos = p + 2;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    const ret = flipQuoteDirection(state, () => {
      throw new Error('should not dispatch on an empty selection');
    });
    expect(ret).toBe(false);
  });
});
