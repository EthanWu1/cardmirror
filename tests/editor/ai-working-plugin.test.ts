/**
 * ai-working plugin — the purple "AI is working here" boxes. Multiple AI
 * ops run concurrently (the edit coordinator makes that safe), so the
 * plugin keeps ONE decoration per op, keyed by a token; one op's box must
 * not clobber another's.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { DecorationSet } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { aiWorkingPlugin, setAiWorking } from '../../src/editor/ai/ai-working-plugin.js';

function makeDoc() {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text('hello world')),
    schema.nodes['paragraph']!.create(null, schema.text('second one')),
  ]);
}

function fakeView() {
  const state = EditorState.create({ doc: makeDoc(), plugins: [aiWorkingPlugin] });
  const v = {
    state,
    dispatch(tr: ReturnType<EditorState['tr']['setMeta']>) {
      v.state = v.state.apply(tr);
    },
  };
  return v as unknown as EditorView & { state: EditorState };
}

function boxCount(view: EditorView & { state: EditorState }): number {
  const decos = aiWorkingPlugin.props.decorations!.call(
    aiWorkingPlugin,
    view.state,
  ) as DecorationSet | null;
  return decos ? decos.find().length : 0;
}

describe('ai-working plugin: concurrent boxes', () => {
  it('keeps one box per token; a new op does not clobber the old', () => {
    const view = fakeView();
    setAiWorking(view, 'op-a', { from: 1, to: 6 }, 'selection');
    expect(boxCount(view)).toBe(1);

    // Second concurrent op → a second box, the first survives.
    setAiWorking(view, 'op-b', { from: 14, to: 20 }, 'selection');
    expect(boxCount(view)).toBe(2);
  });

  it('clearing one op leaves the other box intact', () => {
    const view = fakeView();
    setAiWorking(view, 'op-a', { from: 1, to: 6 }, 'selection');
    setAiWorking(view, 'op-b', { from: 14, to: 20 }, 'selection');
    setAiWorking(view, 'op-a', null);
    expect(boxCount(view)).toBe(1);
    setAiWorking(view, 'op-b', null);
    expect(boxCount(view)).toBe(0);
  });

  it('remaps each box through an edit elsewhere in the doc', () => {
    const view = fakeView();
    setAiWorking(view, 'op-a', { from: 14, to: 20 }, 'selection');
    expect(boxCount(view)).toBe(1);
    // Insert text in para1 (before the box) — the box should survive.
    view.dispatch(view.state.tr.insertText('XX', 1));
    expect(boxCount(view)).toBe(1);
  });
});
