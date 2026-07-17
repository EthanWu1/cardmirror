/**
 * Typing over a Ctrl-Shift-Down-shaped selection (tail at the start of
 * the next textblock) must not eat the block boundary — the worst case
 * was selecting a whole tag that way and typing folding the cite into
 * the tag.
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { typeOverBoundaryPlugin } from '../../src/editor/type-over-boundary.js';

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}
function body(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function card(...children: PMNode[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function para(text: string) {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function makeDoc(...children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** Drive the plugin's handleTextInput with a minimal fake view. */
function typeOver(
  doc: PMNode,
  from: number,
  to: number,
  text: string,
): { handled: boolean; doc: PMNode; state: EditorState } {
  let state = EditorState.create({ doc, plugins: [typeOverBoundaryPlugin] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: import('prosemirror-state').Transaction) {
      state = state.apply(tr);
    },
  } as unknown as EditorView;
  const handler = typeOverBoundaryPlugin.props.handleTextInput!;
  const handled = (handler as (v: EditorView, f: number, t: number, s: string) => boolean)(
    view,
    from,
    to,
    text,
  );
  return { handled, doc: state.doc, state };
}

/** Block-type/text pairs for the whole doc. */
function blocks(doc: PMNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  doc.descendants((n) => {
    if (n.isTextblock) out.push([n.type.name, n.textContent]);
    return true;
  });
  return out;
}

describe('typeOverBoundaryPlugin', () => {
  it('tag selected to the start of the cite: typing keeps the cite', () => {
    const doc = makeDoc(card(tag('Old tag text'), citePara('Author 24'), body('warrant')));
    // tag content: positions 2..14; cite content starts at 16.
    let tagStart = -1;
    let citeStart = -1;
    doc.descendants((n, pos) => {
      if (n.type.name === 'tag') tagStart = pos + 1;
      if (n.type.name === 'cite_paragraph') citeStart = pos + 1;
      return true;
    });
    const { handled, doc: next } = typeOver(doc, tagStart, citeStart, 'N');
    expect(handled).toBe(true);
    expect(blocks(next)).toEqual([
      ['tag', 'N'],
      ['cite_paragraph', 'Author 24'],
      ['card_body', 'warrant'],
    ]);
  });

  it('paragraph selected to the start of the next: typing keeps the break', () => {
    const doc = makeDoc(para('first paragraph'), para('second paragraph'));
    const p2Start = doc.firstChild!.nodeSize + 1;
    const { handled, doc: next } = typeOver(doc, 1, p2Start, 'X');
    expect(handled).toBe(true);
    expect(blocks(next)).toEqual([
      ['paragraph', 'X'],
      ['paragraph', 'second paragraph'],
    ]);
  });

  it('does not interfere when the selection reaches INTO the next block', () => {
    const doc = makeDoc(para('first paragraph'), para('second paragraph'));
    const p2Start = doc.firstChild!.nodeSize + 1;
    // One character of the second paragraph is genuinely selected —
    // the user crossed the boundary on purpose; standard merge applies.
    const { handled } = typeOver(doc, 1, p2Start + 1, 'X');
    expect(handled).toBe(false);
  });

  it('does not interfere with a within-block selection', () => {
    const doc = makeDoc(para('first paragraph'));
    const { handled } = typeOver(doc, 1, 6, 'X');
    expect(handled).toBe(false);
  });

  it('does not interfere with a collapsed cursor at block start', () => {
    const doc = makeDoc(para('first'), para('second'));
    const p2Start = doc.firstChild!.nodeSize + 1;
    const { handled } = typeOver(doc, p2Start, p2Start, 'X');
    expect(handled).toBe(false);
  });

  it('collapses to a cursor after the typed text — continued typing appends', () => {
    // Live regression: without the explicit collapse, the mapped
    // selection stayed a range tail-at-block-start, so every following
    // keystroke re-entered the handler and overwrote in place.
    const doc = makeDoc(para('first paragraph'), para('second paragraph'));
    const p2Start = doc.firstChild!.nodeSize + 1;
    const first = typeOver(doc, 1, p2Start, 'X');
    expect(first.handled).toBe(true);
    const sel = first.state.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(2); // right after the typed 'X'
    // Second keystroke at the collapsed cursor: the plugin stands
    // aside and normal insertion appends.
    const second = typeOver(first.doc, sel.from, sel.to, 'Y');
    expect(second.handled).toBe(false);
  });
});
