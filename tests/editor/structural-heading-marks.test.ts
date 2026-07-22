// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  normalizeUnderlineMarks,
  namedStyleNormalizerPlugin,
} from '../../src/editor/named-style-normalizer-plugin.js';

/** Marks on the first text run inside the first node of `type`. */
function runMarks(doc: PMNode, type: string): string[] {
  let out: string[] = [];
  let done = false;
  doc.descendants((n) => {
    if (done) return false;
    if (n.type.name === type) {
      n.descendants((t) => {
        if (!done && t.isText) {
          out = t.marks.map((m) => m.type.name);
          done = true;
        }
      });
    }
    return true;
  });
  return out;
}

function docWithMarkedHeading(headingType: string, markName: string): PMNode {
  const mark = schema.marks[markName]!.create();
  const heading = schema.nodes[headingType]!.create(
    headingType === 'pocket' || headingType === 'hat' || headingType === 'block' || headingType === 'tag'
      ? { id: 'h1' }
      : null,
    schema.text('Heading text', [mark]),
  );
  // Tags must live in a card; wrap when needed so the doc is schema-valid.
  if (headingType === 'tag') {
    return schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.create(null, [heading, schema.nodes['card_body']!.create(null, [schema.text('body')])]),
    ]);
  }
  return schema.nodes['doc']!.create(null, [heading]);
}

describe('structural headings never carry cite/emphasis marks', () => {
  // Emphasis / cite are body character styles. A tag that acquires one renders
  // as an emphasis box (or cite styling) and perpetuates through copy-paste,
  // since the clipboard export re-emits it. The named-style normalizer strips
  // them from structural headings — on import and on the next edit.
  for (const markName of ['emphasis_mark', 'cite_mark']) {
    it(`import helper strips ${markName} from a tag`, () => {
      const doc = docWithMarkedHeading('tag', markName);
      expect(runMarks(doc, 'tag')).toEqual([markName]);
      const cleaned = normalizeUnderlineMarks(doc);
      expect(runMarks(cleaned, 'tag')).toEqual([]);
    });

    it(`live plugin strips ${markName} from a tag on the next edit`, () => {
      const doc = docWithMarkedHeading('tag', markName);
      const state = EditorState.create({ doc, plugins: [namedStyleNormalizerPlugin] });
      const next = state.apply(state.tr.insertText('!', 2)); // edit inside the tag
      expect(runMarks(next.doc, 'tag')).toEqual([]);
    });
  }

  it('strips emphasis from other structural heads (pocket/hat/block) too', () => {
    for (const head of ['pocket', 'hat', 'block']) {
      const cleaned = normalizeUnderlineMarks(docWithMarkedHeading(head, 'emphasis_mark'));
      expect(runMarks(cleaned, head)).toEqual([]);
    }
  });

  it('leaves emphasis on body text (card_body) untouched', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag')),
        schema.nodes['card_body']!.create(null, [
          schema.text('kept', [schema.marks['emphasis_mark']!.create()]),
        ]),
      ]),
    ]);
    expect(runMarks(normalizeUnderlineMarks(doc), 'card_body')).toEqual(['emphasis_mark']);
  });
});
