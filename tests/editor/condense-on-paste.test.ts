/**
 * Condense after Paste Text (F2) — the `condenseOnPaste` setting path
 * through `applyPlainPasteFromText`. The condense must scope to the
 * PASTED RANGE: an empty-selection condense would scope to the
 * enclosing card, or no-op entirely at doc level (the reported bug —
 * doc-level blob pastes kept all their intraparagraph whitespace).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { applyPlainPasteFromText } from '../../src/editor/paste-plugin.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const para = (t: string) =>
  schema.nodes['paragraph']!.create(null, t ? schema.text(t) : undefined);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

/** Minimal view over `d` with the cursor placed at `pos`. */
function fakeView(d: PMNode, pos: number) {
  let state = EditorState.create({ doc: d });
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

function blockTexts(d: PMNode): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = [];
  d.descendants((n) => {
    if (n.isTextblock) out.push({ type: n.type.name, text: n.textContent });
    return true;
  });
  return out;
}

const CTX = (integrity: boolean) => ({
  condenseOnPaste: () => true,
  paragraphIntegrity: () => integrity,
  usePilcrows: () => false,
  headingMode: () => 'respect' as const,
});

describe('condense after Paste Text (F2)', () => {
  it('cleans intraparagraph whitespace of a doc-level paste (integrity on)', () => {
    // Cursor in an empty doc-level paragraph — no enclosing card, so
    // the pre-fix empty-selection condense no-opped here.
    const view = fakeView(doc(para('')), 1);
    applyPlainPasteFromText(view as never, 'one   two\tthree\n\nfour    five', CTX(true));
    const blocks = blockTexts(view.state.doc).filter((b) => b.text !== '');
    expect(blocks.map((b) => b.text)).toEqual(['one two three', 'four five']);
    // Paragraph integrity preserved: still two separate paragraphs.
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true);
  });

  it('leaves content outside the pasted range untouched', () => {
    // Cursor at the end of card 1's body; card 2's messy body must
    // survive — the condense scopes to the paste, not the document.
    const messy = 'messy     spacing';
    const d = doc(
      card(tag('T1'), cardBody('start')),
      card(tag('T2'), cardBody(messy)),
    );
    let pos = 1;
    d.descendants((n, p) => {
      if (n.type.name === 'card_body' && n.textContent === 'start') pos = p + 1 + n.content.size;
    });
    const view = fakeView(d, pos);
    applyPlainPasteFromText(view as never, '  padded   text', CTX(true));
    const bodies = blockTexts(view.state.doc).filter((b) => b.type === 'card_body');
    // The touched body was cleaned (the paste's leading double space
    // and interior run both collapse to one space)…
    expect(bodies[0]!.text).toBe('start padded text');
    // …the other card's whitespace is untouched.
    expect(bodies[1]!.text).toBe(messy);
  });

  it('merges pasted lines when paragraph integrity is off', () => {
    const view = fakeView(doc(card(tag('T'), cardBody('start '))), 1);
    let pos = 1;
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'card_body') pos = p + 1 + n.content.size;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    applyPlainPasteFromText(view as never, 'one\ntwo\nthree', CTX(false));
    const bodies = blockTexts(view.state.doc).filter((b) => b.type === 'card_body');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.text).toContain('one');
    expect(bodies[0]!.text).toContain('three');
  });

  it('ends with a collapsed cursor at the end of the pasted content', () => {
    const view = fakeView(doc(para('')), 1);
    applyPlainPasteFromText(view as never, 'a   b\n\nc   d', CTX(true));
    expect(view.state.selection.empty).toBe(true);
    // Cursor parked at the end of the last pasted (condensed) block.
    const $from = view.state.selection.$from;
    expect($from.parent.textContent).toBe('c d');
    expect($from.parentOffset).toBe($from.parent.content.size);
  });

  it('condenseOnPaste off: paste is untouched', () => {
    const view = fakeView(doc(para('')), 1);
    applyPlainPasteFromText(view as never, 'one   two', {
      ...CTX(true),
      condenseOnPaste: () => false,
    });
    const blocks = blockTexts(view.state.doc).filter((b) => b.text !== '');
    expect(blocks.map((b) => b.text)).toEqual(['one   two']);
  });
});
