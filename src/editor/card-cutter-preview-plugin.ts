/**
 * Card-cutter preview plugin.
 *
 * A transient, view-only decoration layer for the trim checklist's hover
 * preview: when the user mouses over a row, the highlighted words that
 * row's checkbox would affect are boxed in purple — one box hugging each
 * run of words (an inline decoration per fragment), so it's clear exactly
 * which highlighting toggling that row removes/restores. Decorations, not
 * marks: never serialized, cleared the moment the mouse leaves.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

interface Range {
  from: number;
  to: number;
}

const key = new PluginKey<DecorationSet>('card-cutter-preview');

export const cardCutterPreviewPlugin = new Plugin<DecorationSet>({
  key,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(key) as Range[] | null | undefined;
      if (meta === undefined) return set.map(tr.mapping, tr.doc);
      if (meta === null || meta.length === 0) return DecorationSet.empty;
      return DecorationSet.create(
        tr.doc,
        meta
          .filter((r) => r.to > r.from)
          .map((r) => Decoration.inline(r.from, r.to, { class: 'pmd-cc-preview' })),
      );
    },
  },
  props: {
    decorations(state) {
      return key.getState(state);
    },
  },
});

/** Box the given ranges as the trim-checklist hover preview, or clear
 *  with null. */
export function setCardCutterPreview(view: EditorView, ranges: Range[] | null): void {
  try {
    view.dispatch(view.state.tr.setMeta(key, ranges));
  } catch {
    // View torn down — nothing to set.
  }
}
