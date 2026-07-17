/**
 * Normalizer round guard: every appended normalizer transaction carries
 * the origin + round metas, rounds accumulate across cascades, and the
 * cap drops the pass instead of letting a normalizer fight loop forever.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  guardNormalizerTr,
  normalizerRound,
  NORMALIZER_META,
  NORMALIZER_ROUND_META,
  NORMALIZER_ROUND_CAP,
} from '../../src/editor/normalizer-guard.js';
import { citeClassifierPlugin } from '../../src/editor/cite-classifier-plugin.js';

function para(text: string) {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function makeState() {
  const doc = schema.nodes['doc']!.createChecked(null, [para('some cite text here')]);
  return EditorState.create({ doc, plugins: [citeClassifierPlugin] });
}

afterEach(() => vi.restoreAllMocks());

describe('guardNormalizerTr', () => {
  it('stamps origin and round 1 on a fresh cascade', () => {
    const state = makeState();
    const tr = guardNormalizerTr([state.tr], state.tr.insertText('x', 1))!;
    expect(tr.getMeta(NORMALIZER_META)).toBe(true);
    expect(tr.getMeta(NORMALIZER_ROUND_META)).toBe(1);
  });

  it('increments the round past prior normalizer output', () => {
    const state = makeState();
    const incoming = state.tr.setMeta(NORMALIZER_ROUND_META, 3);
    const tr = guardNormalizerTr([incoming], state.tr.insertText('x', 1))!;
    expect(tr.getMeta(NORMALIZER_ROUND_META)).toBe(4);
  });

  it('drops the pass (with a warning) at the cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = makeState();
    const incoming = state.tr.setMeta(NORMALIZER_ROUND_META, NORMALIZER_ROUND_CAP);
    expect(guardNormalizerTr([incoming], state.tr.insertText('x', 1))).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('normalizerRound takes the max across incoming transactions', () => {
    const state = makeState();
    const a = state.tr.setMeta(NORMALIZER_ROUND_META, 2);
    const b = state.tr.setMeta(NORMALIZER_ROUND_META, 5);
    expect(normalizerRound([a, state.tr, b])).toBe(5);
  });
});

describe('normalizers stamp their appended transactions', () => {
  it('cite classifier output carries the metas', () => {
    const state = makeState();
    // Marking the paragraph's text as cite retypes it to cite_paragraph
    // via the classifier's appendTransaction.
    const root = state.tr.addMark(1, 10, schema.marks['cite_mark']!.create());
    const { state: next, transactions } = state.applyTransaction(root);
    expect(next.doc.child(0).type.name).toBe('cite_paragraph');
    const appended = transactions.find((t) => t.getMeta(NORMALIZER_META) === true);
    expect(appended).toBeDefined();
    expect(appended!.getMeta(NORMALIZER_ROUND_META)).toBe(1);
  });
});
