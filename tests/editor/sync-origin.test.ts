/**
 * Sync-origin transactions bypass region locks: read mode admits them
 * (rejecting already-merged remote content would desynchronize the
 * editor from the shared doc), and the AI edit coordinator releases —
 * never blocks — a lease the sync edit touches.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { markSyncOrigin, isSyncOrigin } from '../../src/editor/sync-origin.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';
import {
  editCoordinatorPlugin,
  claimRegion,
  coordinatorBlocks,
} from '../../src/editor/ai/edit-coordinator.js';

function para(text: string) {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function makeDoc(...texts: string[]) {
  return schema.nodes['doc']!.createChecked(null, texts.map(para));
}

describe('sync-origin meta', () => {
  it('round-trips through mark/is', () => {
    const state = EditorState.create({ doc: makeDoc('hello') });
    expect(isSyncOrigin(state.tr)).toBe(false);
    expect(isSyncOrigin(markSyncOrigin(state.tr))).toBe(true);
  });
});

describe('read mode admits sync-origin transactions', () => {
  function readModeState(): EditorState {
    const state = EditorState.create({ doc: makeDoc('hello world'), plugins: [readModePlugin] });
    return state.apply(state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  }

  it('still rejects a plain edit (the lock holds)', () => {
    const state = readModeState();
    const next = state.apply(state.tr.insertText('X', 2));
    expect(next.doc.eq(state.doc)).toBe(true);
  });

  it('admits a sync-origin edit', () => {
    const state = readModeState();
    const next = state.apply(markSyncOrigin(state.tr.insertText('X', 2)));
    expect(next.doc.textContent).toBe('hXello world');
  });
});

describe('coordinator leases vs sync-origin edits', () => {
  /** Minimal stand-in for an EditorView: the coordinator only touches
   *  `.state` and `.dispatch`. dispatch runs the real apply pipeline
   *  (so filterTransaction fires). */
  function fakeView(...texts: string[]): EditorView & { state: EditorState } {
    const state = EditorState.create({ doc: makeDoc(...texts), plugins: [editCoordinatorPlugin] });
    const v = {
      state,
      dispatch(tr: ReturnType<EditorState['tr']['insertText']>) {
        v.state = v.state.apply(tr);
      },
    };
    return v as unknown as EditorView & { state: EditorState };
  }

  it('blocks a plain user edit inside the lease (baseline)', () => {
    const view = fakeView('hello world');
    const lease = claimRegion(view, { from: 1, to: 8 }, { label: 'test' });
    expect(lease).not.toBeNull();
    expect(coordinatorBlocks(view.state, view.state.tr.insertText('X', 3))).toBe(true);
  });

  it('never blocks a sync-origin edit, even inside the lease', () => {
    const view = fakeView('hello world');
    claimRegion(view, { from: 1, to: 8 }, { label: 'test' });
    const tr = markSyncOrigin(view.state.tr.insertText('X', 3));
    expect(coordinatorBlocks(view.state, tr)).toBe(false);
    view.dispatch(tr);
    expect(view.state.doc.textContent).toBe('heXllo world');
  });

  it('releases a lease the sync edit touches', () => {
    const view = fakeView('hello world');
    const lease = claimRegion(view, { from: 1, to: 8 }, { label: 'test' })!;
    view.dispatch(markSyncOrigin(view.state.tr.insertText('X', 3)));
    expect(lease.region()).toBeNull();
  });

  it('keeps (and remaps) a lease the sync edit does not touch', () => {
    const view = fakeView('hello world', 'second para');
    // Lease over "second" in the second paragraph.
    const lease = claimRegion(view, { from: 14, to: 20 }, { label: 'test' })!;
    view.dispatch(markSyncOrigin(view.state.tr.insertText('XYZ', 2)));
    expect(lease.region()).toEqual({ from: 17, to: 23 });
  });
});
