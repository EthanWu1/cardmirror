import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  dragItemsForPersistentSelection,
  dragItemsForSelection,
  type DragSelectionCandidate,
} from '../../src/editor/drag-selection-source.js';

function pocket(text: string) {
  return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
}

function block(text: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}

function cardWith(tagText: string, bodyText?: string) {
  const children = [schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText))];
  if (bodyText) children.push(schema.nodes['card_body']!.create(null, schema.text(bodyText)));
  return schema.nodes['card']!.createChecked(null, children);
}

function analyticUnit(text: string) {
  return schema.nodes['analytic_unit']!.createChecked(null, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(text)),
  ]);
}

function fallback(from: number, to: number, label = 'fallback'): DragSelectionCandidate {
  return { from, to, type: 'card', level: 4, label };
}

describe('dragItemsForSelection', () => {
  it('uses the hovered unit when the selection is empty', () => {
    const card = cardWith('Only');
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    const selection = { from: 1, to: 1, empty: true };

    const out = dragItemsForSelection(doc, selection, fallback(0, card.nodeSize, 'Only'));

    expect(out.map((item) => [item.from, item.to, item.type, item.label])).toEqual([
      [0, card.nodeSize, 'card', 'Only'],
    ]);
  });

  it('collects every selected card and analytic unit in document order', () => {
    const first = cardWith('A');
    const second = analyticUnit('B analytic');
    const third = cardWith('C');
    const doc = schema.nodes['doc']!.createChecked(null, [first, second, third]);
    const selection = { from: 0, to: first.nodeSize + second.nodeSize, empty: false };

    const out = dragItemsForSelection(doc, selection, fallback(0, first.nodeSize));

    expect(out.map((item) => item.type)).toEqual(['card', 'analytic_unit']);
    expect(out.map((item) => item.label)).toEqual(['A', 'B analytic']);
    expect(out.map((item) => [item.from, item.to])).toEqual([
      [0, first.nodeSize],
      [first.nodeSize, first.nodeSize + second.nodeSize],
    ]);
  });

  it('collects a selected heading as one section and does not duplicate its child cards', () => {
    const head = block('Block A');
    const child = cardWith('A card');
    const next = block('Block B');
    const doc = schema.nodes['doc']!.createChecked(null, [head, child, next]);
    const selection = { from: 0, to: head.nodeSize + child.nodeSize, empty: false };

    const out = dragItemsForSelection(doc, selection, fallback(0, head.nodeSize));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      from: 0,
      to: head.nodeSize + child.nodeSize,
      type: 'block',
      level: 3,
      label: 'Block A',
    });
  });

  it('falls back to the hovered unit when the existing selection is somewhere else', () => {
    const first = cardWith('A');
    const second = cardWith('B');
    const doc = schema.nodes['doc']!.createChecked(null, [first, second]);
    const selection = { from: 0, to: first.nodeSize, empty: false };
    const hovered = fallback(first.nodeSize, first.nodeSize + second.nodeSize, 'B');

    const out = dragItemsForSelection(doc, selection, hovered);

    expect(out.map((item) => item.label)).toEqual(['B']);
  });

  it('uses every persistent drag selection item before falling back to hovered unit', () => {
    const first = cardWith('A');
    const second = analyticUnit('B analytic');
    const doc = schema.nodes['doc']!.createChecked(null, [first, second]);
    const selected: DragSelectionCandidate[] = [
      { from: 0, to: first.nodeSize, type: 'card', level: 4, label: 'A' },
      {
        from: first.nodeSize,
        to: first.nodeSize + second.nodeSize,
        type: 'analytic_unit',
        level: 4,
        label: 'B analytic',
      },
    ];

    const out = dragItemsForPersistentSelection(selected, fallback(0, doc.nodeSize));

    expect(out.map((item) => [item.type, item.label])).toEqual([
      ['card', 'A'],
      ['analytic_unit', 'B analytic'],
    ]);
  });
});
