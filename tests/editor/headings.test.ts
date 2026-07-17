/**
 * Outline / cite-extraction helpers.
 */

import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { collectHeadings } from '../../src/editor/headings.js';

function citePara(...runs: { text: string; cite?: boolean }[]) {
  const inline = runs.map((r) =>
    schema.text(r.text, r.cite ? [schema.marks['cite_mark']!.create()] : []),
  );
  return schema.nodes['cite_paragraph']!.create(null, inline);
}

function cardWithCite(tagText: string, cite: ReturnType<typeof citePara>) {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
    cite,
  ]);
}

function makeDoc(children: ReturnType<typeof cardWithCite>[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function citeOfFirstTag(doc: ReturnType<typeof makeDoc>): string | null {
  const entries = collectHeadings(doc);
  const tag = entries.find((e) => e.type === 'tag');
  return tag?.cite ?? null;
}

describe('cite preview text extraction', () => {
  it('joins adjacent cite runs', () => {
    const doc = makeDoc([
      cardWithCite('T', citePara({ text: 'Stein 23', cite: true })),
    ]);
    expect(citeOfFirstTag(doc)).toBe('Stein 23');
  });

  it('bridges a whitespace-only unmarked gap between cite runs', () => {
    // "Stein", " " (unmarked), "23" — the original bug case.
    const doc = makeDoc([
      cardWithCite(
        'T',
        citePara(
          { text: 'Stein', cite: true },
          { text: ' ' },
          { text: '23', cite: true },
        ),
      ),
    ]);
    expect(citeOfFirstTag(doc)).toBe('Stein 23');
  });

  it('bridges multiple whitespace-only gaps between cite runs', () => {
    const doc = makeDoc([
      cardWithCite(
        'T',
        citePara(
          { text: 'Smith', cite: true },
          { text: ' ' },
          { text: 'and', cite: true },
          { text: ' ' },
          { text: 'Jones', cite: true },
          { text: ' ' },
          { text: '23', cite: true },
        ),
      ),
    ]);
    expect(citeOfFirstTag(doc)).toBe('Smith and Jones 23');
  });

  it('does not bridge unmarked non-whitespace text', () => {
    const doc = makeDoc([
      cardWithCite(
        'T',
        citePara(
          { text: 'Stein', cite: true },
          { text: ' note ' },
          { text: '23', cite: true },
        ),
      ),
    ]);
    expect(citeOfFirstTag(doc)).toBe('Stein23');
  });

  it('does not include trailing unmarked whitespace', () => {
    const doc = makeDoc([
      cardWithCite(
        'T',
        citePara(
          { text: 'Stein', cite: true },
          { text: ' ' },
          { text: '23', cite: true },
          { text: '   ' },
        ),
      ),
    ]);
    expect(citeOfFirstTag(doc)).toBe('Stein 23');
  });

  it('does not include leading unmarked whitespace', () => {
    const doc = makeDoc([
      cardWithCite(
        'T',
        citePara(
          { text: '   ' },
          { text: 'Stein 23', cite: true },
        ),
      ),
    ]);
    expect(citeOfFirstTag(doc)).toBe('Stein 23');
  });

  it('returns null when no cite text is present', () => {
    const doc = makeDoc([
      cardWithCite('T', citePara({ text: 'no cite mark here' })),
    ]);
    expect(citeOfFirstTag(doc)).toBe(null);
  });
});
