// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildExternalInsertTransaction } from '../../src/editor/external-insert.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';

function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}
function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}
function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}
function cardWith(...children: any[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function makeState(doc: any): EditorState {
  return EditorState.create({ doc, plugins: [absorbPlugin] });
}

function shapeOf(doc: any): string[] {
  const out: string[] = [];
  doc.forEach((child: any) => {
    if (child.type.name === 'card' || child.type.name === 'analytic_unit') {
      const inner: string[] = [];
      child.forEach((g: any) => inner.push(`${g.type.name}("${g.textContent}")`));
      out.push(`${child.type.name}[${inner.join(', ')}]`);
    } else {
      out.push(`${child.type.name}("${child.textContent}")`);
    }
  });
  return out;
}

function findPos(doc: any, predicate: (n: any) => boolean, off = 0): number {
  let pos = -1;
  doc.descendants((n: any, p: number) => {
    if (pos !== -1) return false;
    if (predicate(n)) {
      pos = n.isText ? p + off : p + 1 + off;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error('predicate not matched');
  return pos;
}

describe('buildExternalInsertTransaction — newParagraph=true (card / cite)', () => {
  it('single-line text mid-card_body → splits at cursor; merges with after-half', () => {
    // Mirrors "press Return; F2 paste 'X'" with cursor mid-card_body.
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello world')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'X', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello "), card_body("Xworld")]',
    ]);
  });

  it('multi-line text mid-card_body → multiple card_body siblings, all in the same card', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello world')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'X\nY\nZ', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello "), card_body("X"), card_body("Y"), card_body("Zworld")]',
    ]);
  });

  it('multi-line text at END of card_body → trailing bodies become siblings, last merges with empty after-half', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 5)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'X\nY', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello"), card_body("X"), card_body("Y")]',
    ]);
  });

  it('text at START of card_body → leading bodies become siblings before original content', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 0)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'X\nY', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    // Empty before-split collapses (no orphan empty card_body left);
    // X is the new first sibling; Y's content merges with the
    // remaining "hello" via the open end.
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("X"), card_body("Yhello")]',
    ]);
  });

  it('text in card with multi-line — every line is a card_body, no tag promotion, no escape', () => {
    // Critical test mirroring the spec's §9 multi-line `card` curl
    // case. Multi-line `card`-role insert must keep every line as a
    // card_body inside the SAME card, no matter how many newlines.
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('body')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'body', 4)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, {
      text: 'First line of the card.\nSecond line.\nThird line.',
      newParagraph: true,
    });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("body"), card_body("First line of the card."), card_body("Second line."), card_body("Third line.")]',
    ]);
  });

  it('at doc level (no card / analytic_unit ancestor): uses `paragraph`, not `card_body`', () => {
    const doc = makeDoc([
      paragraph('top-level paragraph'),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'top-level paragraph', 9)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'X\nY', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'paragraph("top-level")',
      'paragraph("X")',
      'paragraph("Y paragraph")',
    ]);
  });

  it('newParagraph=true with empty text — still inserts a fresh empty body paragraph', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 5)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: '', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello"), card_body("")]',
    ]);
  });

  it('text ends in newline → trailing empty body paragraph (matches the F2 "fresh line" case)', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 5)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'X\n', newParagraph: true });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello"), card_body("X"), card_body("")]',
    ]);
  });
});

describe('buildExternalInsertTransaction — newParagraph=false (inline)', () => {
  it('inserts text at cursor with no block break', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello world')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: 'INSERTED', newParagraph: false });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello INSERTEDworld")]',
    ]);
  });

  it('with leading space (client convention) — inserts as-is', () => {
    // §4.2: "The client may include a leading space in `text`;
    // insert it as-is. CardMirror should not add or trim spacing."
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('see also')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'see also', 8)),
      ),
    );
    const tr = buildExternalInsertTransaction(state, { text: ' citation note', newParagraph: false });
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("see also citation note")]',
    ]);
  });
});
