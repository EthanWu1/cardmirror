/**
 * External-insert primitive — backs the `POST /insert` endpoint
 * defined in `reference-docs/fdp-integration-f2-fix-note.md` / the
 * Fast Debate Paste integration spec (§4.2).
 *
 * Wire-contract goal: reproduce the observable result of the
 * keystroke bridge's "Return + F2 paste plain text" sequence (for
 * `newParagraph: true`) or "F2 paste plain text inline" (for
 * `newParagraph: false`), in ONE transaction so a single Cmd-Z
 * removes the whole insert.
 *
 *   - `newParagraph: true` — split `text` on `\r\n` / `\n` / `\r`,
 *     build a closed-start / open-end Slice of body paragraphs
 *     (`card_body` when the cursor lives inside a `card` /
 *     `analytic_unit`, `paragraph` at doc level), and
 *     `tr.replaceSelection(slice)`. The slice's closed start makes
 *     the first inserted body a fresh sibling rather than text
 *     merged into the cursor's textblock; the open end merges the
 *     last body's content with whatever was after the cursor in
 *     the original textblock — which is exactly the shape
 *     "Return + F2" produces (and the same shape F2's own
 *     `tryPasteAsCardBodies` fix lands inside the schema's content
 *     expression for `card` / `analytic_unit`, so a pasted line
 *     can NEVER be elevated to a tag).
 *
 *   - `newParagraph: false` — `tr.insertText(text)` at the current
 *     selection. Plain inline characters, no marks, no new block.
 *
 * No equation-marker handling (§4.4) in v1 — the spec lets v1
 * insert the placeholder as plain body text.
 */

import { Fragment, Slice } from 'prosemirror-model';
import { type EditorState, type Transaction } from 'prosemirror-state';

export type ExternalInsertRole = 'card' | 'cite' | 'inline';

export interface ExternalInsertOpts {
  text: string;
  newParagraph: boolean;
}

/** Build the insertion transaction for an external `/insert` call.
 *  Returns `null` only when the schema doesn't carry the body type
 *  we need — never happens in our schema; the null is a defensive
 *  rail for callers in other host contexts. */
export function buildExternalInsertTransaction(
  state: EditorState,
  opts: ExternalInsertOpts,
): Transaction | null {
  const { text, newParagraph } = opts;

  if (!newParagraph) {
    // Inline mode: drop the text into the current selection as
    // plain characters. `insertText` clears the active mark set
    // implicitly on the inserted run; `setStoredMarks([])` then
    // prevents stored marks from leaking into the next keystroke
    // the user types.
    const tr = state.tr.insertText(text);
    tr.setStoredMarks([]);
    return tr;
  }

  // `card` / `cite` mode: build sibling body paragraphs from the
  // newline-separated pieces and insert them at the cursor.
  const lines = text.split(/\r\n|\r|\n/);
  const $from = state.selection.$from;

  // Pick the body type by walking up from the cursor until we
  // hit a `card` / `analytic_unit` — `card_body` belongs there.
  // No such ancestor → cursor is at doc level; use the generic
  // `paragraph` instead. (Both have `inline*` content, so the
  // slice's open end semantics are identical between the two.)
  let bodyTypeName: 'card_body' | 'paragraph' = 'paragraph';
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name;
    if (t === 'card' || t === 'analytic_unit') {
      bodyTypeName = 'card_body';
      break;
    }
  }
  const bodyType = state.schema.nodes[bodyTypeName];
  if (!bodyType) return null;

  const bodies = lines.map((line) =>
    bodyType.create(null, line ? state.schema.text(line) : null),
  );
  // Closed start so the first inserted body is a fresh sibling at
  // the cursor (mirrors the keystroke bridge's "press Return
  // first"); open end so the last body's content merges into
  // whatever was after the cursor in the original textblock
  // (mirrors what F2 paste does after the Return).
  const slice = new Slice(Fragment.fromArray(bodies), 0, 1);
  const tr = state.tr.replaceSelection(slice);
  tr.setStoredMarks([]);
  return tr;
}
