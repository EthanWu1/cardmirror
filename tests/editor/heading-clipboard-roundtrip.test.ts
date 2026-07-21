// @vitest-environment jsdom
/**
 * Full-stack clipboard round trip for headings — the REAL app path, not the
 * unit helpers: PM's own `view.serializeForClipboard` (with CardMirror's
 * custom clipboardSerializer), then `__parseFromClipboard` (which runs
 * `transformPastedHTML` → `normalizeWordClipboardHtml` and `transformPasted`
 * → freshHeadingIds/zone flattening), then the paste plugin's `handlePaste`
 * decision chain, falling back to PM's default replaceSelection exactly like
 * the editor does. Field bug 2026-07-19: "copying any heading fails".
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import * as pmViewInternals from 'prosemirror-view';

/** Runtime-only export (present in the CJS/ESM bundle, absent from the
 *  public .d.ts) — exactly what PM's own paste event handler calls. */
const __parseFromClipboard = (
  pmViewInternals as unknown as {
    __parseFromClipboard: (
      view: EditorView,
      text: string,
      html: string | null,
      plainText: boolean,
      $context: import('prosemirror-model').ResolvedPos,
    ) => Slice | null;
  }
).__parseFromClipboard;
import type { Node as PMNode, Slice } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildPastePlugin } from '../../src/editor/paste-plugin.js';
import { cardMirrorClipboardSerializer } from '../../src/editor/clipboard-export.js';
import { flattenSelfRefsInSlice } from '../../src/editor/self-transclusion.js';

const pasteCtx = {
  condenseOnPaste: () => false,
  paragraphIntegrity: () => false,
  usePilcrows: () => false,
  headingMode: () => 'respect' as const,
};

function mkAppView(doc: PMNode, cursorAt?: number): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const plugins: Plugin[] = [buildPastePlugin(pasteCtx)];
  let state = EditorState.create({ doc, plugins });
  if (cursorAt !== undefined) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursorAt)));
  }
  const view: EditorView = new EditorView(el, {
    state,
    clipboardSerializer: cardMirrorClipboardSerializer(schema, {}),
    dispatchTransaction(tx) {
      view.updateState(view.state.apply(tx));
    },
  });
  return view;
}

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.create(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}

function posInText(doc: PMNode, text: string, offset = 0): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) {
      at = pos + node.text.indexOf(text) + offset;
    }
    return at < 0;
  });
  if (at < 0) throw new Error(`text not found: ${text}`);
  return at;
}

/** Copy `slice` out of `source` the way the real copy event does. */
function appCopy(source: EditorView, slice: Slice): { html: string; text: string } {
  const flattened = flattenSelfRefsInSlice(slice, source.state.doc, newHeadingId);
  const { dom, text } = source.serializeForClipboard(flattened);
  const wrap = document.createElement('div');
  wrap.appendChild(dom);
  return { html: wrap.innerHTML, text };
}

/** Paste into `target` the way the real paste event does: parse through the
 *  view's transform hooks, offer the slice to handlePaste, and fall back to
 *  PM's default replaceSelection when every custom path declines. */
function appPaste(target: EditorView, html: string, text: string): void {
  const slice = __parseFromClipboard(target, text, html, false, target.state.selection.$from);
  if (!slice) throw new Error('clipboard parse produced no slice');
  const event = {
    clipboardData: { getData: (type: string) => (type === 'text/html' ? html : text) },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  const handled = target.someProp('handlePaste', (f) => f(target, event, slice));
  if (!handled) {
    target.dispatch(target.state.tr.replaceSelection(slice).scrollIntoView());
  }
}

function topTypes(doc: PMNode): string[] {
  const names: string[] = [];
  doc.forEach((node) => names.push(node.type.name));
  return names;
}

describe('heading clipboard round trip (real view path)', () => {
  const HEADINGS: Array<['pocket' | 'hat' | 'block', string]> = [
    ['pocket', 'Framework Pocket'],
    ['hat', 'Case Hat'],
    ['block', 'Impact Turns Block'],
  ];

  for (const [kind, label] of HEADINGS) {
    it(`CM→CM: a lone selected ${kind} heading pastes as a ${kind}`, () => {
      const source = mkAppView(
        schema.nodes['doc']!.create(null, [
          schema.nodes[kind]!.create({ id: newHeadingId() }, schema.text(label)),
          card('After', 'source body'),
        ]),
      );
      // Select the whole heading line the way triple-click / Home..Shift+End does.
      const from = posInText(source.state.doc, label);
      const to = from + label.length;
      source.dispatch(
        source.state.tr.setSelection(TextSelection.create(source.state.doc, from, to)),
      );
      const { html, text } = appCopy(source, source.state.selection.content());
      expect(html).toContain(label);

      const target = mkAppView(
        schema.nodes['doc']!.create(null, [card('Existing', 'before after')]),
      );
      target.dispatch(
        target.state.tr.setSelection(
          TextSelection.create(target.state.doc, posInText(target.state.doc, 'after')),
        ),
      );
      appPaste(target, html, text);

      expect(target.state.doc.textContent).toContain(label);
      expect(topTypes(target.state.doc), `${kind} should survive as structure`).toContain(kind);
      source.destroy();
      target.destroy();
    });
  }

  it('CM→CM: pasting a heading while the caret sits on another heading keeps it structural', () => {
    const source = mkAppView(
      schema.nodes['doc']!.create(null, [
        schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Copied Block')),
      ]),
    );
    const from = posInText(source.state.doc, 'Copied Block');
    source.dispatch(
      source.state.tr.setSelection(
        TextSelection.create(source.state.doc, from, from + 'Copied Block'.length),
      ),
    );
    const { html, text } = appCopy(source, source.state.selection.content());

    const target = mkAppView(
      schema.nodes['doc']!.create(null, [
        schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Landing Block')),
        card('Under', 'body text'),
      ]),
      undefined,
    );
    // Caret at the END of the landing heading — the common "click the heading
    // line, paste" gesture.
    const at = posInText(target.state.doc, 'Landing Block') + 'Landing Block'.length;
    target.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, at)));
    appPaste(target, html, text);

    expect(target.state.doc.textContent).toContain('Copied Block');
    source.destroy();
    target.destroy();
  });

  it('Word→CM: a lone Word heading pastes as the mapped CardMirror heading', () => {
    const wordHtml = `
      <html><body>
      <h3 style='mso-outline-level:3'><span>Word Block Heading</span></h3>
      </body></html>`;
    const target = mkAppView(
      schema.nodes['doc']!.create(null, [card('Existing', 'before after')]),
    );
    target.dispatch(
      target.state.tr.setSelection(
        TextSelection.create(target.state.doc, posInText(target.state.doc, 'after')),
      ),
    );
    appPaste(target, wordHtml, 'Word Block Heading');

    expect(target.state.doc.textContent).toContain('Word Block Heading');
    expect(topTypes(target.state.doc)).toContain('block');
    target.destroy();
  });
});
