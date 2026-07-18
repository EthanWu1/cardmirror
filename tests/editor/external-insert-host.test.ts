// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';
import { installExternalInsertHost } from '../../src/editor/external-insert-host.js';

function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}
function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}

function buildViewInBody(cursorText: string, cursorOffset: number): { view: EditorView; cleanup: () => void } {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      tag('TAG'),
      cardBody(cursorText),
    ]),
  ]);
  let cursorPos = -1;
  doc.descendants((n: any, p: number) => {
    if (cursorPos !== -1) return false;
    if (n.isText && n.text === cursorText) { cursorPos = p + cursorOffset; return false; }
    return true;
  });
  const state = EditorState.create({
    doc,
    plugins: [absorbPlugin],
    selection: TextSelection.create(doc, cursorPos),
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state });
  return { view, cleanup: () => { view.destroy(); container.remove(); } };
}

interface PendingRequestHandler {
  (req: any): void;
}

function installFakeBridge(): {
  fire: (req: any) => void;
  results: any[];
  uninstall: () => void;
} {
  const results: any[] = [];
  let pendingHandler: PendingRequestHandler | null = null;
  const api = {
    onExternalInsertRequest: (h: PendingRequestHandler): (() => void) => {
      pendingHandler = h;
      return () => { pendingHandler = null; };
    },
    sendExternalInsertResult: (r: any): void => { results.push(r); },
  };
  (window as any).electronAPI = api;
  return {
    fire: (req: any) => { pendingHandler?.(req); },
    results,
    uninstall: () => { delete (window as any).electronAPI; },
  };
}

describe('installExternalInsertHost', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.(); cleanup = null;
    delete (window as any).electronAPI;
  });

  it('no electronAPI present → no-op subscribe (returns unsubscribe)', () => {
    const unsubscribe = installExternalInsertHost({
      getFocusedView: () => null,
      getFocusedDocTitle: () => null,
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('happy path: card mode multi-line text → ack ok with docTitle, doc has new card_body siblings', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
    });

    bridge.fire({
      requestId: 'r1',
      text: 'X\nY',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results).toHaveLength(1);
    expect(bridge.results[0]).toEqual({
      requestId: 'r1',
      ok: true,
      docTitle: 'doc.cmir',
    });
    const shape: string[] = [];
    view.state.doc.firstChild!.forEach((c: any) => shape.push(`${c.type.name}("${c.textContent}")`));
    expect(shape).toEqual([
      'tag("TAG")',
      'card_body("hello ")',
      'card_body("X")',
      'card_body("Yworld")',
    ]);
  });

  it('inline mode: text inserts at cursor with no block break', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r2',
      text: 'INSERTED',
      role: 'inline',
      newParagraph: false,
      omitted: false,
    });

    expect(bridge.results[0]).toMatchObject({ requestId: 'r2', ok: true });
    expect(view.state.doc.textContent).toBe('TAGhello INSERTEDworld');
  });

  it('no focused view → ok:false, error:"no-target-doc"', () => {
    const bridge = installFakeBridge();
    installExternalInsertHost({ getFocusedView: () => null, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r3',
      text: 'X',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results[0]).toEqual({
      requestId: 'r3',
      ok: false,
      error: 'no-target-doc',
    });
  });

  it('focused view in read mode (editable=false) → ok:false, error:"doc-readonly"', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello', 0);
    cleanup = vc;
    // Mimic the read-mode plugin flipping editable to false.
    view.setProps({ editable: () => false });
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r4',
      text: 'X',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results[0]).toEqual({
      requestId: 'r4',
      ok: false,
      error: 'doc-readonly',
    });
  });

  it('malformed payload (missing text) → bad-request', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello', 0);
    cleanup = vc;
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r5',
      role: 'card',
      newParagraph: true,
      omitted: false,
      // text is missing
    });

    expect(bridge.results[0]).toEqual({
      requestId: 'r5',
      ok: false,
      error: 'bad-request',
    });
  });

  it('docTitle is undefined when active filename is null', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello', 0);
    cleanup = vc;
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r6',
      text: 'X',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results[0]).toEqual({ requestId: 'r6', ok: true });
    expect(bridge.results[0]).not.toHaveProperty('docTitle');
  });
});
