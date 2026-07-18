/**
 * Viewport spellcheck word detection — a word whose styling changes
 * mid-word is split across text nodes, and must still be checked (and
 * flagged) as the whole word, not the fragments.
 */

import { describe, expect, it } from 'vitest';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { misspelledRangesIn } from '../../src/editor/viewport-spellcheck.js';

const { marks } = schema;
const u = marks['underline_mark']!.create();
const hl = marks['highlight']!.create({ color: 'yellow' });

/** A paragraph whose text content joins the given inline pieces. Returns
 *  the node and the base position (paragraph content starts at offset 1
 *  of a one-paragraph doc → doc position 1). */
function para(...inline: PMNode[]): { node: PMNode; base: number } {
  const node = schema.nodes['paragraph']!.create(null, inline);
  return { node, base: 1 };
}

const t = (text: string, ...m: Mark[]) => schema.text(text, m);

/** A dictionary that only knows the words we hand it (lowercased). */
function dict(...known: string[]): (w: string) => boolean {
  const set = new Set(known.map((w) => w.toLowerCase()));
  return (w) => set.has(w.toLowerCase());
}

/** The substring of the joined paragraph text a range covers. */
function slice(node: PMNode, base: number, r: { from: number; to: number }): string {
  return node.textBetween(r.from - base, r.to - base);
}

describe('misspelledRangesIn — styling-split words', () => {
  it('checks a word split mid-word as the whole word (real word → no flag)', () => {
    // "signifi" underlined + "cant" plain == "significant".
    const { node, base } = para(t('signifi', u), t('cant'));
    expect(misspelledRangesIn(node, base, dict('significant'))).toEqual([]);
  });

  it('flags a split word whose whole form is wrong — once, spanning both nodes', () => {
    // "signifi" + "kant" == "signifikant" (misspelled). The fragments must
    // not be checked separately.
    const { node, base } = para(t('signifi', u), t('kant', hl));
    const ranges = misspelledRangesIn(node, base, dict('significant', 'cant', 'kant'));
    expect(ranges.length).toBe(1);
    expect(slice(node, base, ranges[0]!)).toBe('signifikant');
  });

  it('does not flag the valid fragments of a split real word', () => {
    // Both "under" and "stand" are real words; split styling must not make
    // the checker treat them as two words and (correctly) pass — but the
    // point is the JOINED word "understand" is what's checked.
    const { node, base } = para(t('under', hl), t('stand'));
    expect(misspelledRangesIn(node, base, dict('understand'))).toEqual([]);
  });

  it('still flags a genuinely misspelled standalone word', () => {
    const { node, base } = para(t('teh quick'));
    const ranges = misspelledRangesIn(node, base, dict('quick'));
    expect(ranges.length).toBe(1);
    expect(slice(node, base, ranges[0]!)).toBe('teh');
  });

  it('does not join across a non-text inline node', () => {
    // "sig" + <image> + "cant" must stay two words, not "sigcant".
    const img = schema.nodes['image']!.create({
      src: '',
      data: '',
      contentType: 'image/png',
    });
    const { node, base } = para(t('hello', u), img, t('xqzword'));
    const ranges = misspelledRangesIn(node, base, dict('hello'));
    // "hello" is known; "xqzword" is not — only the latter flags.
    expect(ranges.length).toBe(1);
    expect(slice(node, base, ranges[0]!)).toBe('xqzword');
  });

  it('still trims a trailing possessive apostrophe on a split word', () => {
    // "James" + "'" with a style change before the apostrophe.
    const { node, base } = para(t('Jame', u), t("s'"));
    expect(misspelledRangesIn(node, base, dict('james'))).toEqual([]);
  });
});
