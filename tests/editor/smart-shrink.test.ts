/**
 * Smart Shrink (Mod-Alt-8) — one-shot, per-paragraph shrink depth:
 * paragraphs with NO underline/emphasis go straight to 5pt; paragraphs
 * that have those marks shrink their connective text to the standard
 * 8pt. Eligibility and protections match the regular shrink cycle.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { smartShrinkText, compileShrinkProtections } from '../../src/editor/ribbon-commands.js';

const m = (name: string, attrs?: Record<string, unknown>) => schema.marks[name]!.create(attrs);
const t = (text: string, ...marks: ReturnType<typeof m>[]) => schema.text(text, marks);

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(...inlines: ReturnType<typeof t>[]) {
  return schema.nodes['card_body']!.create(null, inlines);
}
function card(...children: PMNode[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(...children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

const NORMAL_PT = 11;

/** Effective size mirroring the chip: explicit font_size mark, else Normal. */
function effectivePt(node: PMNode | null, _parent: PMNode): number {
  const mark = node?.marks.find((mk) => mk.type.name === 'font_size');
  return mark ? Number(mark.attrs['halfPoints']) / 2 : NORMAL_PT;
}

function command(restore = false) {
  return smartShrinkText(
    effectivePt,
    () => NORMAL_PT,
    () => restore,
    () => compileShrinkProtections([], '', ''),
  );
}

/** Run smart shrink with the cursor at the first text position. */
function run(doc: PMNode, restore = false, sel?: { from: number; to: number }): EditorState | null {
  let state = EditorState.create({ doc });
  if (sel) state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, sel.from, sel.to)));
  else state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
  let next: EditorState | null = null;
  const ok = command(restore)(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

/** Effective pt of the text node containing `needle`. */
function ptOf(doc: PMNode, needle: string): number {
  let found = NORMAL_PT;
  doc.descendants((node, _pos, parent) => {
    if (node.isText && node.text?.includes(needle) && parent) {
      found = effectivePt(node, parent);
      return false;
    }
    return true;
  });
  return found;
}

describe('smartShrinkText', () => {
  it('5pt for unmarked paragraphs, 8pt for connective text in marked ones', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(t('lead in '), t('the warrant', m('underline_mark')), t(' trailing words')),
        body(t('a long fully unread paragraph with no marks at all')),
      ),
    );
    const next = run(doc)!;
    expect(next).not.toBeNull();
    expect(ptOf(next.doc, 'lead in')).toBe(8);
    expect(ptOf(next.doc, 'trailing words')).toBe(8);
    expect(ptOf(next.doc, 'the warrant')).toBe(NORMAL_PT); // exempt, untouched
    expect(ptOf(next.doc, 'fully unread paragraph')).toBe(5);
  });

  it('emphasis counts as marked; direct underline counts as marked', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(t('around '), t('standout', m('emphasis_mark'))),
        body(t('connective '), t('directly', m('underline_direct'))),
      ),
    );
    const next = run(doc)!;
    expect(ptOf(next.doc, 'around')).toBe(8);
    expect(ptOf(next.doc, 'connective')).toBe(8);
  });

  it('classification reads the WHOLE paragraph even for a partial selection', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(t('selected portion here '), t('and the underline', m('underline_mark'))),
      ),
    );
    // Select only the unmarked leading text — the paragraph still
    // classifies as marked (8pt), not bare (5pt).
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text === 'selected portion here ') pos = p;
      return pos < 0;
    });
    const next = run(doc, false, { from: pos, to: pos + 10 })!;
    // The selected slice ("selected p") shrank to the MARKED depth.
    expect(ptOf(next.doc, 'selected p')).toBe(8);
    // The unselected remainder is untouched.
    expect(ptOf(next.doc, 'ortion here')).toBe(NORMAL_PT);
  });

  it('is idempotent: a second run reports false (no junk undo step)', () => {
    const doc = makeDoc(card(tag('TAG'), body(t('no marks here at all'))));
    const next = run(doc)!;
    expect(ptOf(next.doc, 'no marks')).toBe(5);
    const again = run(next.doc);
    expect(again).toBeNull(); // command returned false — nothing to change
  });

  it('protected spans stay Normal when the restore setting is on', () => {
    const doc = makeDoc(
      card(tag('TAG'), body(t('before [Text Omitted] after — no marks anywhere'))),
    );
    const next = run(doc, true)!;
    expect(ptOf(next.doc, 'before')).toBe(5);
    let omittedPt = 0;
    next.doc.descendants((node, _pos, parent) => {
      if (node.isText && node.text?.includes('Omitted') && parent) {
        omittedPt = effectivePt(node, parent);
        return false;
      }
      return true;
    });
    expect(omittedPt).toBe(NORMAL_PT);
  });

  it('cursor anywhere in a card shrinks its bodies (regular-shrink scope parity)', () => {
    const doc = makeDoc(card(tag('A tag here'), body(t('unmarked body text'))));
    // cursor inside the TAG — the card's bodies still shrink.
    const next = run(doc)!;
    expect(next).not.toBeNull();
    expect(ptOf(next.doc, 'unmarked body')).toBe(5);
    expect(ptOf(next.doc, 'A tag here')).toBe(NORMAL_PT); // tag untouched
  });

  it('refuses structural contexts outside cards (cursor in a pocket)', () => {
    const doc = makeDoc(
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket heading')),
      card(tag('TAG'), body(t('body text'))),
    );
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    const ok = command()(state, () => {});
    expect(ok).toBe(false);
  });
});
