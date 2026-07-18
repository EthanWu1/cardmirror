/**
 * Dragging a LIVE VIEW (`self_ref`) through the shared drag system. A live view
 * is no longer natively draggable (so a selection can be dragged through it) —
 * it moves via the same pickup-chord / nav-row drag as cards, which build
 * explicit move/copy transactions. These cover the commit side: a live view
 * moved WITHIN its doc stays a live view; copied cross-doc it's flattened
 * elsewhere (see drag-controller's cross-view path + send-self-ref.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildMoveTransaction, buildCopyTransaction, type DragItem } from '../../src/editor/drag-controller.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function selfPos(doc: PMNode): number {
  let p = -1;
  doc.forEach((n, off) => {
    if (p < 0 && isSelfRef(n)) p = off;
  });
  return p;
}
function countSelfRefs(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (isSelfRef(node)) n++;
    return true;
  });
  return n;
}
function selfRefItem(doc: PMNode): DragItem {
  const pos = selfPos(doc);
  const node = doc.nodeAt(pos)!;
  return { from: pos, to: pos + node.nodeSize, id: null, type: 'self_ref', level: 0, label: 'Live view' };
}

describe('dragging a live view within its doc (move commit)', () => {
  it('moves the self_ref to a new position and keeps it a live view', () => {
    // [Source, card, Elsewhere, self_ref] → move the self_ref up to doc start.
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', 'src'),
      card('Alpha', 'alpha'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    const state = EditorState.create({ doc, schema });
    const item = selfRefItem(doc);

    const tr = buildMoveTransaction(state, [item], 0);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    // Still exactly one live view, now the first child, still pointing at 'src'.
    expect(countSelfRefs(newDoc)).toBe(1);
    expect(isSelfRef(newDoc.child(0))).toBe(true);
    expect(newDoc.child(0).attrs['source_heading_id']).toBe('src');
    // Nothing was duplicated.
    expect(newDoc.childCount).toBe(4);
  });

  it('copies the live view as a second live view (same-doc copy)', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', 'src'),
      card('Alpha', 'alpha'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    const state = EditorState.create({ doc, schema });
    const tr = buildCopyTransaction(state, [selfRefItem(doc)], 0);
    expect(tr).not.toBeNull();
    // A same-doc copy keeps the reference live (both mirror 'src').
    expect(countSelfRefs(tr!.doc)).toBe(2);
  });
});
