import { describe, expect, it, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPerfProbe, absorbPlugin } from '../../src/editor/absorb-plugin.js';
import {
  markUnreadPerfProbe,
  markUnreadPlugin,
} from '../../src/editor/mark-unread-plugin.js';
import {
  MAX_SELF_REF_RENDER_DOC_SIZE,
  makeSelfRefPlugin,
  selfRefPerfProbe,
} from '../../src/editor/self-transclusion-plugin.js';
import { createSelfRefNode } from '../../src/editor/self-transclusion.js';
import { createTransclusionNode, contentHash, idIndependentHash, zoneIdentity } from '../../src/editor/transclusion.js';
import {
  makeTransclusionDivergencePlugin,
  transclusionDivergenceKey,
  transclusionDivergencePerfProbe,
} from '../../src/editor/transclusion-divergence-plugin.js';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { settings } from '../../src/editor/settings.js';

function block(text: string, id = newHeadingId()): PMNode {
  return schema.nodes['block']!.create({ id }, schema.text(text));
}

function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}

function markedCard(tag: string, bodyAfterMarker: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, [
      schema.text('Marked 1:00', [schema.marks['font_color']!.create({ color: 'FF0000' })]),
      schema.text(bodyAfterMarker),
    ]),
  ]);
}

function para(text: string): PMNode {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}

function docOf(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

function bodyEnd(doc: PMNode, needle: string): number {
  let pos = -1;
  doc.descendants((node, nodePos) => {
    if (pos >= 0) return false;
    if (node.type.name === 'card_body' && node.textContent === needle) {
      pos = nodePos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error(`body not found: ${needle}`);
  return pos;
}

beforeEach(() => {
  absorbPerfProbe.fullScans = 0;
  absorbPerfProbe.topLevelVisited = 0;
  markUnreadPerfProbe.fullBuilds = 0;
  markUnreadPerfProbe.rangeBuilds = 0;
  selfRefPerfProbe.rederiveScans = 0;
  transclusionDivergencePerfProbe.rebuilds = 0;
  settings.set('markUnreadAfterMarker', false);
});

describe('large-doc edit fast paths', () => {
  it('does not scan the document for self-ref rederive when the doc has no self refs', () => {
    const children: PMNode[] = [];
    for (let i = 0; i < 250; i++) children.push(card(`T${i}`, `body ${i}`));
    let state = EditorState.create({
      doc: docOf(children),
      plugins: [makeSelfRefPlugin()],
    });

    state = state.apply(state.tr.insertText('x', bodyEnd(state.doc, 'body 200')));

    expect(selfRefPerfProbe.rederiveScans).toBe(0);
  });

  it('keeps self-ref projection live when a referenced source changes', () => {
    const doc = docOf([
      block('Source', 'src'),
      card('A', 'alpha'),
      block('Other', 'other'),
      createSelfRefNode(schema, 'src', 'Source'),
    ]);
    let state = EditorState.create({ doc, plugins: [makeSelfRefPlugin()] });

    state = state.apply(state.tr.insertText(' beta', bodyEnd(state.doc, 'alpha')));

    let mirrored = '';
    state.doc.descendants((node) => {
      if (node.type.name === 'self_ref') mirrored = node.textContent;
      return true;
    });
    expect(mirrored).toContain('alpha beta');
    expect(selfRefPerfProbe.rederiveScans).toBeGreaterThan(0);
  });

  it('bounds derived self-ref render content so large docs do not balloon', () => {
    const largeBody = 'x'.repeat(9_000);
    const doc = docOf([
      block('Source', 'src'),
      card('A', largeBody),
      block('Other', 'other'),
      createSelfRefNode(schema, 'src', 'Source'),
      createSelfRefNode(schema, 'src', 'Source'),
    ]);
    let state = EditorState.create({ doc, plugins: [makeSelfRefPlugin()] });

    state = state.apply(state.tr.insertText('!', bodyEnd(state.doc, largeBody)));

    const renderedSizes: number[] = [];
    state.doc.descendants((node) => {
      if (node.type.name === 'self_ref') renderedSizes.push(node.content.size);
      return true;
    });
    expect(state.doc.nodeSize).toBeLessThanOrEqual(MAX_SELF_REF_RENDER_DOC_SIZE);
    expect(renderedSizes.filter((size) => size > 0)).toHaveLength(1);
  });

  it('scopes absorption to the touched top-level neighborhood on ordinary typing', () => {
    const children: PMNode[] = [];
    for (let i = 0; i < 300; i++) children.push(card(`T${i}`, `body ${i}`));
    let state = EditorState.create({
      doc: docOf(children),
      plugins: [absorbPlugin],
    });

    state = state.apply(state.tr.insertText('x', bodyEnd(state.doc, 'body 240')));

    expect(absorbPerfProbe.fullScans).toBe(0);
    expect(absorbPerfProbe.topLevelVisited).toBeLessThan(12);
  });

  it('still absorbs loose body content adjacent to the edited card', () => {
    const children: PMNode[] = [];
    for (let i = 0; i < 40; i++) children.push(card(`Before ${i}`, `before ${i}`));
    children.push(card('Target', 'target body'), para('loose body'));
    for (let i = 0; i < 40; i++) children.push(card(`After ${i}`, `after ${i}`));
    let state = EditorState.create({
      doc: docOf(children),
      plugins: [absorbPlugin],
    });

    state = state.apply(state.tr.insertText('x', bodyEnd(state.doc, 'target body')));

    let targetCard: PMNode | undefined;
    state.doc.forEach((node) => {
      if (node.type.name === 'card' && node.firstChild?.textContent === 'Target') targetCard = node;
    });
    expect(targetCard).toBeDefined();
    expect(targetCard!.lastChild?.type.name).toBe('card_body');
    expect(targetCard!.lastChild?.textContent).toBe('loose body');
    expect(absorbPerfProbe.fullScans).toBe(0);
    expect(absorbPerfProbe.topLevelVisited).toBeLessThan(12);
  });

  it('maps divergence decorations through typing instead of rebuilding the whole doc', () => {
    const pulled = Fragment.fromArray([card('Pulled', 'source')]);
    const zone = createTransclusionNode(
      schema,
      {
        source_ref: '../Other.cmir',
        source_heading_id: 'sec-1',
        source_content_hash: contentHash(pulled),
        source_shape_hash: idIndependentHash(pulled),
        source_label: 'Other > Sec',
      } as never,
      pulled,
    );
    let state = EditorState.create({
      doc: docOf([card('Local', 'local body'), zone]),
      plugins: [makeTransclusionDivergencePlugin()],
    });

    const diverged = new Set([zoneIdentity(zone)]);
    state = state.apply(state.tr.setMeta(transclusionDivergenceKey, diverged));
    expect(transclusionDivergencePerfProbe.rebuilds).toBe(1);

    state = state.apply(state.tr.insertText('x', bodyEnd(state.doc, 'local body')));

    expect(transclusionDivergencePerfProbe.rebuilds).toBe(1);
    expect(transclusionDivergenceKey.getState(state)?.decoSet.find()).toHaveLength(1);
  });

  it('updates unread-marker decorations in the edited card instead of rebuilding the whole doc', () => {
    settings.set('markUnreadAfterMarker', true);
    let state = EditorState.create({
      doc: docOf([markedCard('A', ' after marker'), ...Array.from({ length: 200 }, (_, i) => card(`T${i}`, `body ${i}`))]),
      plugins: [markUnreadPlugin],
    });
    expect(markUnreadPerfProbe.fullBuilds).toBe(1);

    state = state.apply(state.tr.insertText('x', bodyEnd(state.doc, 'Marked 1:00 after marker')));

    expect(markUnreadPerfProbe.fullBuilds).toBe(1);
    expect(markUnreadPerfProbe.rangeBuilds).toBeGreaterThan(0);
    expect(markUnreadPlugin.getState(state)?.find().length).toBeGreaterThan(0);
  });
});
