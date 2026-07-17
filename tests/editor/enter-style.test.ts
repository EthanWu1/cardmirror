/**
 * "New paragraph on Enter" (enter-style.ts + the enterAfter* settings).
 *
 * The contract under test: with a non-'normal' choice, Enter at the
 * end of a structural block behaves exactly like Enter followed by
 * that style's command — so these tests assert the composed outcomes,
 * including the card-split semantics inherited from setTag/setHeading.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { history, undo } from 'prosemirror-history';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import { enterWithConfiguredStyle } from '../../src/editor/enter-style.js';

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, text ? schema.text(text) : []);
}
function analytic(text: string) {
  return schema.nodes['analytic']!.create({ id: newHeadingId() }, text ? schema.text(text) : []);
}
function cardWith(...children: PMNode[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function body(text: string) {
  return schema.nodes['card_body']!.create(null, text ? schema.text(text) : []);
}
function pocket(text: string) {
  return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
}
function analyticUnit(...children: PMNode[]) {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}
function makeDoc(children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** State with the cursor at the very END of the first node matching `name`. */
function stateWithCursorAtEndOf(doc: PMNode, name: string, plugins: any[] = []): EditorState {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos === -1 && n.type.name === name) pos = p + 1 + n.content.size;
    return pos === -1;
  });
  if (pos < 0) throw new Error(`no ${name} in doc`);
  const base = EditorState.create({ doc, plugins });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
}

/** Minimal view stand-in: dispatch folds transactions back into
 *  `state`, matching how the command uses the real view after its
 *  first dispatch. Returns the final state (or null if the command
 *  declined without dispatching). */
function runWithFakeView(state: EditorState, cmd: Command): EditorState | null {
  const fake = {
    state,
    dispatch(tr: Transaction) {
      fake.state = fake.state.apply(tr);
    },
  };
  const ok = cmd(fake.state, fake.dispatch.bind(fake), fake as never);
  return ok ? fake.state : null;
}

const ENTER_KEYS = [
  'enterAfterPocket',
  'enterAfterHat',
  'enterAfterBlock',
  'enterAfterTag',
  'enterAfterAnalytic',
  'enterAfterUndertag',
] as const;

afterEach(() => {
  for (const k of ENTER_KEYS) settings.set(k, 'normal');
});

describe('enterWithConfiguredStyle', () => {
  it('all-normal defaults: declines everywhere (untouched pipeline)', () => {
    const state = stateWithCursorAtEndOf(makeDoc([pocket('P')]), 'pocket');
    expect(runWithFakeView(state, enterWithConfiguredStyle)).toBeNull();
  });

  it('declines mid-block even with a style configured', () => {
    settings.set('enterAfterPocket', 'block');
    const doc = makeDoc([pocket('Pock')]);
    const base = EditorState.create({ doc });
    // Cursor after "Po" — inside, not at the end.
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 3)));
    expect(runWithFakeView(state, enterWithConfiguredStyle)).toBeNull();
  });

  it('pocket → block: Enter at end of a pocket creates an empty block', () => {
    settings.set('enterAfterPocket', 'block');
    const state = stateWithCursorAtEndOf(makeDoc([pocket('P')]), 'pocket');
    const next = runWithFakeView(state, enterWithConfiguredStyle);
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('pocket');
    expect(next!.doc.child(1).type.name).toBe('block');
    expect(next!.doc.child(1).textContent).toBe('');
    // Cursor sits in the fresh block.
    expect(next!.selection.$from.parent.type.name).toBe('block');
  });

  it('pocket → pocket: Enter continues the style', () => {
    settings.set('enterAfterPocket', 'pocket');
    const state = stateWithCursorAtEndOf(makeDoc([pocket('P')]), 'pocket');
    const next = runWithFakeView(state, enterWithConfiguredStyle);
    expect(next).not.toBeNull();
    expect(next!.doc.child(1).type.name).toBe('pocket');
    expect(next!.doc.child(1).textContent).toBe('');
  });

  // Enter at end of a tag inserts the new body line directly UNDER
  // the tag (above any existing bodies — tag-keymap case 4), so the
  // conversions below inherit the mid-body split semantics of the
  // style commands. That's the feature's contract: identical to
  // pressing Enter and then the style key.
  it('tag → tag: new card with an empty tag takes over the rest of the card', () => {
    settings.set('enterAfterTag', 'tag');
    const doc = makeDoc([cardWith(tag('T'), body('b'))]);
    const state = stateWithCursorAtEndOf(doc, 'tag');
    const next = runWithFakeView(state, enterWithConfiguredStyle);
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('card');
    expect(next!.doc.child(0).textContent).toBe('T');
    expect(next!.doc.child(1).type.name).toBe('card');
    expect(next!.doc.child(1).child(0).type.name).toBe('tag');
    expect(next!.doc.child(1).child(0).textContent).toBe('');
    expect(next!.doc.child(1).textContent).toBe('b');
  });

  it('tag → pocket: mid-body split — empty pocket after the tag-only card, body becomes loose', () => {
    settings.set('enterAfterTag', 'pocket');
    const doc = makeDoc([cardWith(tag('T'), body('b'))]);
    const state = stateWithCursorAtEndOf(doc, 'tag');
    const next = runWithFakeView(state, enterWithConfiguredStyle);
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(3);
    expect(next!.doc.child(0).type.name).toBe('card');
    expect(next!.doc.child(0).textContent).toBe('T');
    expect(next!.doc.child(1).type.name).toBe('pocket');
    expect(next!.doc.child(1).textContent).toBe('');
    expect(next!.doc.child(2).type.name).toBe('paragraph');
    expect(next!.doc.child(2).textContent).toBe('b');
  });

  it('analytic → analytic: a new analytic_unit with an empty analytic', () => {
    settings.set('enterAfterAnalytic', 'analytic');
    const doc = makeDoc([analyticUnit(analytic('A'))]);
    const state = stateWithCursorAtEndOf(doc, 'analytic');
    const next = runWithFakeView(state, enterWithConfiguredStyle);
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('analytic_unit');
    expect(next!.doc.child(0).textContent).toBe('A');
    expect(next!.doc.child(1).type.name).toBe('analytic_unit');
    expect(next!.doc.child(1).child(0).type.name).toBe('analytic');
    expect(next!.doc.child(1).textContent).toBe('');
  });

  it('one Ctrl-Z undoes the whole thing (split + conversion group)', () => {
    settings.set('enterAfterPocket', 'block');
    const doc = makeDoc([pocket('P')]);
    const state = stateWithCursorAtEndOf(doc, 'pocket', [history()]);
    const fake = {
      state,
      dispatch(tr: Transaction) {
        fake.state = fake.state.apply(tr);
      },
    };
    const ok = enterWithConfiguredStyle(fake.state, fake.dispatch.bind(fake), fake as never);
    expect(ok).toBe(true);
    expect(fake.state.doc.childCount).toBe(2);
    undo(fake.state, fake.dispatch.bind(fake));
    expect(fake.state.doc.eq(doc)).toBe(true);
  });
});
