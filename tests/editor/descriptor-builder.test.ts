// @vitest-environment jsdom
/**
 * `createDescriptorBuilder` merges the two forks' versions: upstream's
 * flatten-once closure API, plus the fork's binary search and quote cap.
 * Both additions exist for the bulk evidence indexer, which builds thousands
 * of descriptors against one document.
 */

import { describe, it, expect } from 'vitest';
import { schema } from '../../src/schema/index.js';
import {
  createDescriptorBuilder,
  resolveDescriptor,
} from '../../src/editor/learn-anchor.js';

function docOfParagraphs(texts: string[]) {
  return schema.nodes['doc']!.create(
    null,
    texts.map((t) => schema.nodes['paragraph']!.create(null, [schema.text(t)])),
  );
}

describe('createDescriptorBuilder', () => {
  it('caps the stored quote but still resolves back to the passage', () => {
    const body = 'The evidence overwhelmingly demonstrates the impact. '.repeat(20);
    const doc = docOfParagraphs(['intro paragraph', body, 'closing paragraph']);

    const from = doc.child(0).nodeSize + 1;
    const to = from + body.length;

    const uncapped = createDescriptorBuilder(doc)(from, to);
    const capped = createDescriptorBuilder(doc, 40)(from, to);

    expect(uncapped.quote.length).toBeGreaterThan(200);
    expect(capped.quote.length).toBe(40);
    // The cap must not break relocation — that is the whole premise of
    // storing prefix/suffix context alongside a short quote.
    expect(resolveDescriptor(doc, capped)).not.toBeNull();
    expect(capped.prefix).toBe(uncapped.prefix);
  });

  it('agrees with an uncapped build for short ranges', () => {
    const doc = docOfParagraphs(['alpha bravo', 'charlie delta', 'echo foxtrot']);
    const build = createDescriptorBuilder(doc);
    const buildCapped = createDescriptorBuilder(doc, 10_000);
    for (let from = 1; from < doc.content.size - 2; from += 3) {
      expect(buildCapped(from, from + 4)).toEqual(build(from, from + 4));
    }
  });

  it('resolves descriptors built across many ranges of one document', () => {
    const doc = docOfParagraphs(
      Array.from({ length: 40 }, (_, i) => `paragraph number ${i} with some body text`),
    );
    const build = createDescriptorBuilder(doc, 400);
    let resolved = 0;
    for (let i = 0; i < 40; i++) {
      const d = build(2 + i * 5, 8 + i * 5);
      if (resolveDescriptor(doc, d)) resolved++;
    }
    expect(resolved).toBe(40);
  });
});
