import type { Mark, Node as PMNode } from 'prosemirror-model';

export function isReadModeBodyMarkName(markName: string): boolean {
  return markName === 'highlight' || markName === 'shading';
}

export function hasReadModeBodyMark(marks: readonly Mark[]): boolean {
  return marks.some((m) => isReadModeBodyMarkName(m.type.name));
}

export function textHasReadModeMark(node: PMNode, markName: string): boolean {
  if (markName === 'highlight') return hasReadModeBodyMark(node.marks);
  return node.marks.some((m) => m.type.name === markName);
}
