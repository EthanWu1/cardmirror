import type { Selection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { sectionEndFromHeading, TYPE_TO_LEVEL } from './headings.js';
import type { DragItem } from './drag-controller.js';

export interface DragSelectionCandidate {
  from: number;
  to: number;
  type: string;
  level: number;
  label: string;
  id?: string | null;
}

const TOP_LEVEL_DRAG_TYPES = new Set([
  'card',
  'analytic_unit',
  'pocket',
  'hat',
  'block',
  'transclusion_ref',
  'self_ref',
]);

function candidateToItem(candidate: DragSelectionCandidate): DragItem {
  return {
    from: candidate.from,
    to: candidate.to,
    id: candidate.id ?? null,
    type: candidate.type,
    level: candidate.level,
    label: candidate.label,
  };
}

export function dragItemsForPersistentSelection(
  selected: readonly DragSelectionCandidate[],
  fallback: DragSelectionCandidate,
): DragItem[] {
  return selected.length > 0
    ? [...selected].sort((a, b) => a.from - b.from).map(candidateToItem)
    : [candidateToItem(fallback)];
}

function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

function firstHeadingText(node: PMNode): string {
  return node.firstChild?.textContent ?? node.textContent ?? '';
}

function topLevelItemForChild(
  doc: PMNode,
  child: PMNode,
  index: number,
  from: number,
): DragItem | null {
  const type = child.type.name;
  if (!TOP_LEVEL_DRAG_TYPES.has(type)) return null;
  if (type === 'card' || type === 'analytic_unit') {
    return {
      from,
      to: from + child.nodeSize,
      id: null,
      type,
      level: 4,
      label: firstHeadingText(child),
    };
  }
  if (type === 'transclusion_ref' || type === 'self_ref') {
    return {
      from,
      to: from + child.nodeSize,
      id: null,
      type,
      level: 0,
      label: String(child.attrs['source_label'] || firstHeadingText(child) || 'Live view')
        .replace(/^\u21b3\s*/, ''),
    };
  }
  const level = TYPE_TO_LEVEL[type];
  if (level === undefined) return null;
  const to = sectionEndFromHeading(doc, index, from + child.nodeSize, level);
  return {
    from,
    to,
    id: typeof child.attrs['id'] === 'string' ? child.attrs['id'] : null,
    type,
    level,
    label: child.textContent,
  };
}

function selectedTopLevelItems(doc: PMNode, from: number, to: number): DragItem[] {
  const items: DragItem[] = [];
  let offset = 0;
  let coveredUntil = -1;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    const childFrom = offset;
    const childTo = childFrom + child.nodeSize;
    offset = childTo;
    if (childFrom < coveredUntil) continue;
    if (!rangesOverlap(childFrom, childTo, from, to)) continue;
    const item = topLevelItemForChild(doc, child, index, childFrom);
    if (!item) continue;
    items.push(item);
    coveredUntil = Math.max(coveredUntil, item.to);
  }
  return items;
}

export function dragItemsForSelection(
  doc: PMNode,
  selection: Pick<Selection, 'from' | 'to' | 'empty'>,
  fallback: DragSelectionCandidate,
): DragItem[] {
  if (selection.empty) return [candidateToItem(fallback)];
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (!rangesOverlap(fallback.from, fallback.to, from, to)) {
    return [candidateToItem(fallback)];
  }
  const selected = selectedTopLevelItems(doc, from, to);
  return selected.length > 0 ? selected : [candidateToItem(fallback)];
}
