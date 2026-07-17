/**
 * Regression: re-mounting the editor in place (home-screen New / Open)
 * must not throw "Applying a mismatched transaction".
 *
 * Root cause: some plugins dispatch a transaction from their own `view()`
 * setup — the highlight-frequency plugin runs a full-doc scan at mount and
 * dispatches it (`syncActivation`). That dispatch fires DURING
 * `new EditorView(...)`, before `mountView` has assigned the module-level
 * `view`. The editor's `dispatchTransaction` reads that module `view`:
 *
 *   - First mount: `view` is null, so the dispatch is dropped (a no-op).
 *   - Re-mount: `view` still points at the PREVIOUS, just-destroyed view,
 *     so the fresh-doc transaction is applied to the old view's (different)
 *     state → `EditorState.apply` throws "Applying a mismatched transaction".
 *
 * The fix guards `dispatchTransaction` on the identity of the dispatching
 * view (PM calls it as `dispatchTransaction.call(theView, tx)`), dropping
 * anything whose view isn't the current one — including during construction.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

const schema = new Schema({
  nodes: { doc: { content: 'text*' }, text: {} },
  marks: {},
});
const docWith = (t: string) => schema.node('doc', null, schema.text(t));

const probeKey = new PluginKey('probe');
/** Mimics a plugin that dispatches from its `view()` setup (e.g. the
 *  highlight-frequency mount scan): the dispatch fires synchronously while
 *  the EditorView is still being constructed. */
const constructionTimeDispatchPlugin = new Plugin({
  key: probeKey,
  view(v) {
    // Runs inside `new EditorView(...)`, before the caller's assignment.
    v.dispatch(v.state.tr.setMeta(probeKey, true));
    return {};
  },
});

/** A `mountView`-shaped harness parameterized by the dispatchTransaction
 *  guard, so we can exercise both the buggy and fixed variants. */
function makeMounter(guard: 'fixed' | 'buggy') {
  let current: EditorView | null = null;
  function mount(text: string): EditorView {
    if (current) current.destroy();
    // Deliberately DON'T null `current` here — reproduces the real code,
    // where the module `view` still points at the destroyed view while the
    // replacement is under construction.
    const state = EditorState.create({
      schema,
      doc: docWith(text),
      plugins: [constructionTimeDispatchPlugin],
    });
    const el = document.createElement('div');
    const v: EditorView = new EditorView(el, {
      state,
      dispatchTransaction(this: EditorView, tx) {
        if (guard === 'fixed') {
          // THE FIX: only the current, fully-mounted view applies.
          if (this !== current) return;
        } else {
          // The original guard: catches only the null (first-mount) case.
          if (!current) return;
        }
        current!.updateState(current!.state.apply(tx));
      },
    });
    current = v;
    return v;
  }
  return { mount, get: () => current };
}

describe('editor re-mount', () => {
  it('does not throw a mismatched transaction on the second in-place mount', () => {
    const m = makeMounter('fixed');
    expect(() => m.mount('one')).not.toThrow();
    // The second mount is where the home-screen New/Open crash happened.
    expect(() => m.mount('two')).not.toThrow();
    expect(m.get()!.state.doc.textContent).toBe('two');
  });

  it('the original module-view guard reproduces the crash (locks the regression in)', () => {
    const m = makeMounter('buggy');
    // First mount: `current` is null, dispatch is dropped — no throw.
    expect(() => m.mount('one')).not.toThrow();
    // Second mount: the construction-time dispatch is applied to the old,
    // destroyed view whose doc differs → the reported error.
    expect(() => m.mount('two')).toThrow(/mismatched transaction/i);
  });
});
