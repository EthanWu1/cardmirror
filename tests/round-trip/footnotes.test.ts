/**
 * Footnote / endnote round-trip (schema `footnote` node ↔
 * word/footnotes.xml + <w:footnoteReference>).
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { importDoc } from '../../src/import/index.js';
import { importNotes } from '../../src/import/footnotes.js';
import { exportDoc } from '../../src/export/exporter.js';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';
import { Docx } from '../../src/ooxml/docx.js';
import type { FootnoteContent } from '../../src/schema/footnotes.js';

const XMLNS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function paragraphWith(...inline: PMNode[]): PMNode {
  return schema.nodes['paragraph']!.create(null, inline);
}
function fn(content: FootnoteContent, kind: 'footnote' | 'endnote' = 'footnote'): PMNode {
  return schema.nodes['footnote']!.create({ kind, content });
}
function docOf(...blocks: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, blocks);
}

describe('importNotes', () => {
  const FOOTNOTES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${XMLNS}>
<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
<w:footnote w:id="2"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> See </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Smith</w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>example.com</w:t></w:r></w:hyperlink></w:p></w:footnote>
</w:footnotes>`;
  const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/x" TargetMode="External"/></Relationships>`;

  it('parses notes, skips separators, resolves hyperlink targets', () => {
    const map = importNotes(FOOTNOTES_XML, RELS_XML, 'w:footnotes', 'w:footnote');
    expect(map.size).toBe(1);
    const content = map.get('2')!;
    // The leading space is marker furniture (footnoteRef + spacer) and
    // is stripped with it.
    expect(content).toEqual([
      [
        { text: 'See ' },
        { text: 'Smith', italic: true },
        { text: 'example.com', link: 'https://example.com/x' },
      ],
    ]);
  });

  it('importDoc turns w:footnoteReference into a footnote node with the body', () => {
    const documentXml = `<?xml version="1.0"?>
<w:document ${XMLNS}><w:body><w:p><w:r><w:t>before</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t> after</w:t></w:r></w:p></w:body></w:document>`;
    const notes = importNotes(FOOTNOTES_XML, RELS_XML, 'w:footnotes', 'w:footnote');
    const doc = importDoc(documentXml, null, null, null, { footnotes: notes });
    let found: PMNode | null = null;
    doc.descendants((n) => {
      if (n.type.name === 'footnote') found = n;
      return !found;
    });
    expect(found).not.toBeNull();
    expect(found!.attrs['kind']).toBe('footnote');
    expect((found!.attrs['content'] as FootnoteContent)[0]![1]).toEqual({
      text: 'Smith',
      italic: true,
    });
  });

  it('a reference with no notes part imports as an empty-bodied marker', () => {
    const documentXml = `<?xml version="1.0"?>
<w:document ${XMLNS}><w:body><w:p><w:r><w:footnoteReference w:id="5"/></w:r></w:p></w:body></w:document>`;
    const doc = importDoc(documentXml);
    let found: PMNode | null = null;
    doc.descendants((n) => {
      if (n.type.name === 'footnote') found = n;
      return !found;
    });
    expect(found).not.toBeNull();
    expect(found!.attrs['content']).toEqual([]);
  });
});

describe('footnote export', () => {
  const CONTENT: FootnoteContent = [
    [
      { text: 'See ' },
      { text: 'Smith 2020', bold: true },
      { text: ' at ' },
      { text: 'example.com', link: 'https://example.com/y?a=1&b=2' },
    ],
    [{ text: 'Second paragraph.' }],
  ];

  it('emits the reference run, the notes part, separators, and rels', () => {
    const doc = docOf(paragraphWith(schema.text('body '), fn(CONTENT)));
    const res = exportDoc(doc);
    expect(res.documentXml).toContain('<w:footnoteReference w:id="1"/>');
    expect(res.footnotesXml).not.toBeNull();
    expect(res.footnotesXml).toContain('w:type="separator" w:id="-1"');
    expect(res.footnotesXml).toContain('w:type="continuationSeparator" w:id="0"');
    expect(res.footnotesXml).toContain('<w:footnote w:id="1">');
    expect(res.footnotesXml).toContain('<w:b/>');
    expect(res.footnotesXml).toContain('<w:hyperlink r:id="rIdN1"');
    // Ampersand in the link must be escaped in the rels part.
    expect(res.footnotesRelsXml).toContain('a=1&amp;b=2');
    expect(res.relsXml).toContain('Target="footnotes.xml"');
    expect(res.endnotesXml).toBeNull();
  });

  it('no footnotes → no parts, no rels entry', () => {
    const doc = docOf(paragraphWith(schema.text('plain')));
    const res = exportDoc(doc);
    expect(res.footnotesXml).toBeNull();
    expect(res.relsXml).not.toContain('footnotes.xml');
  });

  it('endnotes go to their own part with their own ids', () => {
    const doc = docOf(
      paragraphWith(schema.text('x'), fn(CONTENT, 'endnote'), fn([[{ text: 'plain' }]])),
    );
    const res = exportDoc(doc);
    expect(res.documentXml).toContain('<w:endnoteReference w:id="1"/>');
    expect(res.documentXml).toContain('<w:footnoteReference w:id="1"/>');
    expect(res.endnotesXml).toContain('<w:endnote w:id="1">');
    expect(res.footnotesXml).toContain('<w:footnote w:id="1">');
    expect(res.relsXml).toContain('Target="endnotes.xml"');
  });
});

describe('footnote full round-trip (toDocx → fromDocx)', () => {
  it('reference order, kind, and flattened content survive', async () => {
    const original = docOf(
      paragraphWith(
        schema.text('Claim.'),
        fn([[{ text: 'First note ' }, { text: 'italic', italic: true }]]),
        schema.text(' More.'),
        fn([[{ text: 'linked', link: 'https://example.com/z' }]]),
      ),
    );
    const bytes = await toDocx(original);
    // The produced package must carry the notes part.
    const docx = await Docx.load(bytes);
    expect(await docx.readText('word/footnotes.xml')).toBeTruthy();

    const reimported = await fromDocx(bytes);
    const notes: PMNode[] = [];
    reimported.descendants((n) => {
      if (n.type.name === 'footnote') notes.push(n);
      return true;
    });
    expect(notes.length).toBe(2);
    expect(notes[0]!.attrs['content']).toEqual([
      [{ text: 'First note ' }, { text: 'italic', italic: true }],
    ]);
    expect(notes[1]!.attrs['content']).toEqual([
      [{ text: 'linked', link: 'https://example.com/z' }],
    ]);
  });
});
