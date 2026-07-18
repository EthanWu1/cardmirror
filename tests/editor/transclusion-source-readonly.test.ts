// @vitest-environment jsdom
/**
 * Invariant: operating on a FILE-backed live zone never writes the source file.
 *
 * A user reported (under co-editing) that editing the doc a live zone was
 * imported FROM seemed to change the source. This pins the guarantee that it
 * can't: with a mock desktop host whose source READ returns real bytes but whose
 * every WRITE path is a spy, refreshing / editing-inside / detaching / deleting a
 * live zone must never invoke a source write. The transclusion module resolves
 * the source read-only; the only source write in the app is the Word-anchor
 * bookmark at zone-creation time (consent-gated), which none of these do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { serializeNative } from '../../src/native/index.js';
import { createTransclusionNode, isTransclusionNode } from '../../src/editor/transclusion.js';
import {
  refreshZoneAtPos,
  detachZoneAtPos,
  deleteZoneAtPos,
} from '../../src/editor/transclusion-actions.js';
import { setViewDocPath } from '../../src/editor/transclusion-doc-path.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newId(tag) }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
let idc = 0;
function newId(seed: string): string {
  return `${seed}-${idc++}`;
}

/** Source doc B: a block heading `H` with a card section under it. */
function sourceDoc(bodyText = 'Original source body from doc B, unchanged.'): PMNode {
  return schema.nodes['doc']!.create(null, [
    schema.nodes['block']!.create({ id: 'H' }, schema.text('Source section')),
    card('Src card', bodyText),
    schema.nodes['block']!.create({ id: 'end' }, schema.text('End')),
  ]);
}

/** Doc A: a file-backed live zone (transclusion_ref → B.cmir#H) between paras. */
function docWithFileZone(): PMNode {
  const zone = createTransclusionNode(
    schema,
    {
      source_ref: 'B.cmir',
      source_ref_base: 'doc',
      source_heading_id: 'H',
      source_content_hash: 'stale',
    },
    Fragment.fromArray([card('Cached', 'Cached body from an earlier refresh.')]),
  );
  return schema.nodes['doc']!.create(null, [
    schema.nodes['paragraph']!.create(null, schema.text('Doc A intro.')),
    zone,
    schema.nodes['paragraph']!.create(null, schema.text('Doc A outro.')),
  ]);
}

// ── Mock desktop host: real source READ, every WRITE path a spy ──────────────
const writes = {
  writeSourceAnchor: vi.fn(async () => ({ ok: true })),
  writeFileAtPath: vi.fn(async () => undefined),
  saveExisting: vi.fn(async () => undefined),
  saveAs: vi.fn(async () => ({ ok: false })),
  saveSendDoc: vi.fn(async () => ({ ok: false })),
};
const readCmirFile = vi.fn(async () => ({ bytes: serializeNative(sourceDoc()), name: 'B.cmir' }));
// Set BEFORE the host singleton is first resolved (getHost() is lazy, so any
// transclusion call in a test below picks up this Electron bridge).
(window as unknown as { electronAPI: unknown }).electronAPI = {
  readCmirFile,
  resolveCmirPath: vi.fn(async () => '/abs/B.cmir'),
  ...writes,
};

function noSourceWrite(): void {
  for (const [name, spy] of Object.entries(writes)) {
    expect(spy, `${name} must not be called`).not.toHaveBeenCalled();
  }
}

function zonePos(doc: PMNode): number {
  let p = -1;
  doc.forEach((n, off) => {
    if (p < 0 && isTransclusionNode(n)) p = off;
  });
  return p;
}
function bodyInZone(doc: PMNode): number {
  let at = -1;
  const walk = (node: PMNode, base: number, inZone: boolean): void => {
    node.forEach((child, offset) => {
      const pos = base + offset;
      if (at < 0 && child.type.name === 'card_body' && inZone) at = pos + 1;
      if (child.content.size) walk(child, pos + 1, inZone || isTransclusionNode(child));
    });
  };
  walk(doc, 0, false);
  return at;
}

function makeView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc: docWithFileZone() }) });
  setViewDocPath(view, '/abs/A.cmir');
  return view;
}

describe('a file-backed live zone never writes its source', () => {
  beforeEach(() => {
    Object.values(writes).forEach((s) => s.mockClear());
    readCmirFile.mockClear();
  });

  it('refresh READS the source but writes nothing back', async () => {
    const view = makeView();
    const outcome = await refreshZoneAtPos(view, zonePos(view.state.doc), { confirmEdits: false });
    expect(outcome.ok, 'refresh should succeed from the mock source').toBe(true);
    expect(readCmirFile, 'refresh must read the source').toHaveBeenCalled();
    // The zone was re-pulled (cache replaced with the source card)…
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, ' ')).toContain('Original source body');
    // …but the source itself was never written.
    noSourceWrite();
    view.destroy();
  });

  it('editing inside the zone writes nothing to the source', () => {
    const view = makeView();
    const at = bodyInZone(view.state.doc);
    view.dispatch(view.state.tr.insertText(' EDITED IN COPY', at));
    noSourceWrite();
    view.destroy();
  });

  it('detach writes nothing to the source', () => {
    const view = makeView();
    detachZoneAtPos(view, zonePos(view.state.doc));
    expect(zonePos(view.state.doc), 'zone should be unwrapped').toBe(-1);
    noSourceWrite();
    view.destroy();
  });

  it('delete writes nothing to the source', () => {
    const view = makeView();
    deleteZoneAtPos(view, zonePos(view.state.doc));
    noSourceWrite();
    view.destroy();
  });

  it('edit-then-refresh-then-detach in sequence still writes nothing', async () => {
    const view = makeView();
    view.dispatch(view.state.tr.insertText(' local edit', bodyInZone(view.state.doc)));
    await refreshZoneAtPos(view, zonePos(view.state.doc), { confirmEdits: false });
    const zp = zonePos(view.state.doc);
    if (zp >= 0) detachZoneAtPos(view, zp);
    noSourceWrite();
    view.destroy();
  });
});
