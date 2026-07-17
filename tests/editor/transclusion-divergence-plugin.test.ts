// @vitest-environment jsdom
/**
 * The divergence indicator end-to-end through a real EditorView: a mocked source
 * read drives `checkAllZoneDivergence`, and the plugin's decoration lights up the
 * zone's NodeView glyph (class + tooltip). Also covers the badge clearing when a
 * later read shows the source back in sync (the post-refresh path).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  contentHash,
  idIndependentHash,
  zoneIdentity,
} from '../../src/editor/transclusion.js';
import { transclusionNodeViews } from '../../src/editor/transclusion-nodeview.js';
import type { ResolveOutcome } from '../../src/editor/transclusion-resolve.js';
import { createSelfRefNode } from '../../src/editor/self-transclusion.js';

// Mock the source-read layer: pretend we're on desktop and return whatever
// content the test wants the "source now" to be.
const resolveMock = vi.fn<(...a: unknown[]) => Promise<ResolveOutcome>>();
vi.mock('../../src/editor/transclusion-resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/editor/transclusion-resolve.js')>();
  return {
    ...actual,
    transclusionSupported: () => true,
    resolveTransclusion: (...args: unknown[]) => resolveMock(...args),
  };
});

// Imported AFTER the mock is registered so they pick up the mocked resolve.
const { checkAllZoneDivergence } = await import('../../src/editor/transclusion-divergence.js');
const {
  makeTransclusionDivergencePlugin,
  transclusionDivergenceKey,
  requestDivergenceCheck,
  checkLiveZoneSources,
} = await import('../../src/editor/transclusion-divergence-plugin.js');

function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
const frag = (...c: PMNode[]): Fragment => Fragment.fromArray(c);

/** A cross-file zone whose stored shape matches `pulled`. */
function interZone(pulled: Fragment): PMNode {
  return createTransclusionNode(
    schema,
    {
      source_ref: '../Other.cmir',
      source_heading_id: 'sec-1',
      source_content_hash: contentHash(pulled),
      source_shape_hash: idIndependentHash(pulled),
      source_label: 'Other › Sec',
    } as never,
    pulled,
  );
}

/** ok outcome carrying `content` as the freshly-read source. */
function sourced(content: Fragment): ResolveOutcome {
  return { ok: true, result: { content, headingLabel: 'Sec', headingType: 'block' }, sourceName: 'Other.cmir' };
}

function makeView(doc: PMNode): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, {
    state: EditorState.create({ doc, plugins: [makeTransclusionDivergencePlugin()] }),
    nodeViews: transclusionNodeViews,
  });
}

const PULLED = frag(card('A', 'a'), card('B', 'b'));
function docWithZone(): PMNode {
  return schema.nodes['doc']!.create(null, [
    schema.nodes['block']!.create({ id: 'h' }, schema.text('Heading')),
    interZone(PULLED),
  ]);
}

beforeEach(() => resolveMock.mockReset());

describe('checkAllZoneDivergence', () => {
  it('flags a zone whose source changed', async () => {
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a'), card('B', 'CHANGED'))));
    const view = makeView(docWithZone());
    const { diverged, checked } = await checkAllZoneDivergence(view);
    expect(checked).toBe(1);
    expect(diverged.size).toBe(1);
    view.destroy();
  });

  it('leaves an unchanged source unflagged', async () => {
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a', 'z1'), card('B', 'b', 'z2'))));
    const view = makeView(docWithZone());
    const { diverged, checked } = await checkAllZoneDivergence(view);
    expect(checked).toBe(1);
    expect(diverged.size).toBe(0);
    view.destroy();
  });

  it('does not flag an unreadable source (transient, keeps cache)', async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: 'source-unreadable' });
    const view = makeView(docWithZone());
    const { diverged, checked } = await checkAllZoneDivergence(view);
    expect(checked).toBe(0);
    expect(diverged.size).toBe(0);
    view.destroy();
  });
});

describe('divergence decoration → NodeView badge', () => {
  it('badges the zone glyph when the plugin reports divergence', async () => {
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a'), card('B', 'CHANGED'))));
    const view = makeView(docWithZone());
    await requestDivergenceCheck(view); // check → dispatch → decorate

    const state = transclusionDivergenceKey.getState(view.state);
    expect(state?.diverged.size).toBe(1);

    const zoneDom = view.dom.querySelector('.pmd-transclusion') as HTMLElement;
    expect(zoneDom.classList.contains('pmd-zone-diverged')).toBe(true);
    const glyph = zoneDom.querySelector('.pmd-transclusion-glyph-btn') as HTMLElement;
    expect(glyph.title.toLowerCase()).toContain('source has new content');
    expect(glyph.classList.contains('is-diverged')).toBe(true);
    view.destroy();
  });

  it('clears the badge once a later read shows the source back in sync', async () => {
    const view = makeView(docWithZone());
    // First: diverged.
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a'), card('B', 'CHANGED'))));
    await requestDivergenceCheck(view);
    expect(
      (view.dom.querySelector('.pmd-transclusion') as HTMLElement).classList.contains(
        'pmd-zone-diverged',
      ),
    ).toBe(true);

    // Then: source matches again (as after a Refresh) → badge clears.
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a'), card('B', 'b'))));
    await requestDivergenceCheck(view);
    expect(transclusionDivergenceKey.getState(view.state)?.diverged.size).toBe(0);
    expect(
      (view.dom.querySelector('.pmd-transclusion') as HTMLElement).classList.contains(
        'pmd-zone-diverged',
      ),
    ).toBe(false);
    view.destroy();
  });

  it('ignores an intra-doc self_ref (a separate node type, resolved live)', async () => {
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a'), card('B', 'CHANGED'))));
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['block']!.create({ id: 'h' }, schema.text('Heading')),
      createSelfRefNode(schema, 'sec-1', '↳ Sec'),
    ]);
    const view = makeView(doc);
    const { checked, diverged } = await checkAllZoneDivergence(view);
    expect(checked).toBe(0); // self_refs are never read as cross-file sources
    expect(diverged.size).toBe(0);
    expect(resolveMock).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe('checkLiveZoneSources — manual check-only command', () => {
  it('reports a changed source and lights the badge, without pulling', async () => {
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a'), card('B', 'CHANGED'))));
    const view = makeView(docWithZone());
    const before = view.state.doc.toJSON(); // content must NOT change (check-only)

    const s = await checkLiveZoneSources(view);
    expect(s).toEqual({ desktop: true, total: 1, checked: 1, diverged: 1 });
    expect(view.state.doc.toJSON()).toEqual(before); // nothing pulled
    expect(
      (view.dom.querySelector('.pmd-transclusion') as HTMLElement).classList.contains('pmd-zone-diverged'),
    ).toBe(true); // badge lit
    view.destroy();
  });

  it('reports all up to date when the source is unchanged', async () => {
    resolveMock.mockResolvedValue(sourced(frag(card('A', 'a', 'x'), card('B', 'b', 'y'))));
    const view = makeView(docWithZone());
    const s = await checkLiveZoneSources(view);
    expect(s).toEqual({ desktop: true, total: 1, checked: 1, diverged: 0 });
    view.destroy();
  });

  it('counts an unreadable source as not-checked (kept, not flagged)', async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: 'source-unreadable' });
    const view = makeView(docWithZone());
    const s = await checkLiveZoneSources(view);
    expect(s).toEqual({ desktop: true, total: 1, checked: 0, diverged: 0 });
    view.destroy();
  });

  it('excludes intra-doc self_refs from the total', async () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['block']!.create({ id: 'h' }, schema.text('Heading')),
      createSelfRefNode(schema, 'sec-1', '↳ Sec'),
    ]);
    const view = makeView(doc);
    const s = await checkLiveZoneSources(view);
    expect(s.total).toBe(0);
    expect(resolveMock).not.toHaveBeenCalled();
    view.destroy();
  });
});
