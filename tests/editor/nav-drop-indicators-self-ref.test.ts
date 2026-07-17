// @vitest-environment jsdom
/**
 * Dragging a LIVE VIEW (`self_ref`) row in the outline must offer doc-level drop
 * slots at EVERY heading boundary — a live view moves as a doc-level unit, just
 * like a linked copy. Regression: the nav pane computed `srcIsZone` with
 * `isTransclusionNode` only (not `isSelfRef`), so a self_ref (picked up at
 * level 0) hit `entry.level > 0 → skip` for every heading and the ONLY drop slot
 * left was the end-of-doc one — the live view could only be dropped at the very
 * bottom of the document.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { dragController, type DragItem } from '../../src/editor/drag-controller.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function setup(children: PMNode[]) {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc }) });
  const nav = new NavigationPanel(document.createElement('div'));
  nav.attach(view);
  nav.update(view.state.doc);
  return { view, nav };
}
function posOf(doc: PMNode, pred: (n: PMNode) => boolean): number {
  let p = -1;
  doc.forEach((n, off) => {
    if (p < 0 && pred(n)) p = off;
  });
  return p;
}
function dropIndicatorPositions(nav: NavigationPanel): number[] {
  const listEl = (nav as unknown as Record<string, unknown>)['listEl'] as HTMLElement;
  return [...listEl.querySelectorAll('.pmd-nav-drop-indicator')].map((el) =>
    parseInt((el as HTMLElement).dataset['insertPos'] ?? '-1', 10),
  );
}

afterEach(() => {
  if (dragController.isActive()) dragController.cancel();
});

describe('nav pane drop indicators for a live-view drag', () => {
  it('offers a drop slot at every doc-level boundary, not just end-of-doc', () => {
    const { view: v, nav: n } = setup([
      block('Source', 'src'),
      card('Alpha', 'a'),
      block('Middle', 'mid'),
      card('Beta', 'b'),
      block('Tail', 'tail'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);

    const pos = posOf(v.state.doc, isSelfRef);
    const node = v.state.doc.nodeAt(pos)!;
    const item: DragItem = {
      from: pos,
      to: pos + node.nodeSize,
      id: null,
      type: 'self_ref',
      level: 0,
      label: 'Live view',
    };
    dragController.begin({ view: v, items: [item] });

    const positions = dropIndicatorPositions(n);
    const docEnd = v.state.doc.content.size;
    const nonEnd = positions.filter((p) => p !== docEnd && p >= 0);
    // Regression guard: pre-fix this was empty (only the end-of-doc slot).
    expect(nonEnd.length).toBeGreaterThan(1);
    // Concretely, a slot exists BEFORE the 'Middle' section (a cross-section drop).
    const midPos = posOf(v.state.doc, (nd) => nd.attrs?.['id'] === 'mid');
    expect(positions).toContain(midPos);
    v.destroy();
  });

  it('offers a slot at EVERY real section boundary (cross-section drops allowed)', () => {
    const { view: v, nav: n } = setup([
      block('Source', 'src'),
      card('Alpha', 'a'),
      block('Middle', 'mid'),
      card('Beta', 'b'),
      block('Tail', 'tail'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    const selfP = posOf(v.state.doc, isSelfRef);
    const selfNode = v.state.doc.nodeAt(selfP)!;
    dragController.begin({
      view: v,
      items: [{ from: selfP, to: selfP + selfNode.nodeSize, id: null, type: 'self_ref', level: 0, label: 'v' }],
    });
    const positions = new Set(dropIndicatorPositions(n));
    // A drop slot before each top-level section — moving the live view anywhere,
    // not just within its origin section.
    for (const id of ['src', 'mid', 'tail']) {
      expect(positions, `slot before ${id}`).toContain(posOf(v.state.doc, (nd) => nd.attrs?.['id'] === id));
    }
    v.destroy();
  });
});
