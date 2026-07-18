// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DOMParser as PMDOMParser,
  type Node as PMNode,
  type Slice,
} from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  clipboardHasTextPayload,
  normalizeWordClipboardHtml,
  reparseClipboardStructuralSlice,
} from '../../src/editor/paste-plugin.js';
import { serializeCardMirrorClipboardHtml } from '../../src/editor/clipboard-export.js';

function parseHtml(html: string): PMNode {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(wrap);
}

function parseSliceHtml(html: string): Slice {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parseSlice(wrap);
}

function sliceTopNodeNames(slice: Slice): string[] {
  const names: string[] = [];
  slice.content.forEach((node) => names.push(node.type.name));
  return names;
}

function textRunInSlice(slice: Slice, text: string): PMNode {
  let found: PMNode | null = null;
  slice.content.descendants((node) => {
    if (!found && node.isText && node.text === text) found = node;
    return !found;
  });
  if (!found) throw new Error(`text not found: ${text}`);
  return found;
}

function dataTransferWith(data: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

function dataTransferWithTypes(data: Record<string, string>, types: string[]): DataTransfer {
  return {
    types,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

function textRun(doc: PMNode, text: string): PMNode {
  let found: PMNode | null = null;
  doc.descendants((node) => {
    if (!found && node.isText && node.text === text) found = node;
    return !found;
  });
  if (!found) throw new Error(`text not found: ${text}`);
  return found;
}

function markNames(node: PMNode): string[] {
  return node.marks.map((mark) => mark.type.name);
}

function markAttr(node: PMNode, name: string, attr: string): unknown {
  const mark = node.marks.find((candidate) => candidate.type.name === name);
  return mark?.attrs[attr];
}

function clipboardEventWithHtml(html: string): ClipboardEvent {
  return {
    clipboardData: {
      getData: (type: string) => (type === 'text/html' ? html : ''),
    },
  } as ClipboardEvent;
}

describe('Word HTML paste formatting', () => {
  it('treats Word text/html as text even when the clipboard also carries an image preview', () => {
    expect(clipboardHasTextPayload(dataTransferWith({ 'text/html': '<p>Card text</p>' }))).toBe(true);
    expect(clipboardHasTextPayload(dataTransferWith({ 'text/plain': 'Card text' }))).toBe(true);
    expect(clipboardHasTextPayload(dataTransferWith({ 'text/html': '', 'text/plain': '' }))).toBe(false);
  });

  it('treats Word RTF clipboard flavors as text so Mac Word does not paste the preview image', () => {
    expect(
      clipboardHasTextPayload(
        dataTransferWithTypes({ 'text/html': '', 'text/plain': '' }, [
          'Files',
          'image/png',
          'text/rtf',
        ]),
      ),
    ).toBe(true);
    expect(
      clipboardHasTextPayload(
        dataTransferWithTypes({ 'text/html': '', 'text/plain': '' }, [
          'Files',
          'image/png',
          'public.rtf',
        ]),
      ),
    ).toBe(true);
  });

  it('maps Word clipboard CSS to existing CardMirror marks', () => {
    const doc = parseHtml(`
      <p class="MsoNormal">
        <span style='font-family:"Aptos",sans-serif;
                     font-size:13.0pt;
                     color:#C00000;
                     background-color:yellow;
                     text-decoration:underline;
                     vertical-align:super'>
          <b><i><a href="https://example.com">formatted</a></i></b>
        </span>
        <span style="text-decoration:line-through">struck</span>
      </p>
    `);

    const run = textRun(doc, 'formatted');
    expect(markNames(run)).toEqual(expect.arrayContaining([
      'bold',
      'italic',
      'link',
      'font_family',
      'font_size',
      'font_color',
      'highlight',
      'underline_direct',
      'superscript',
    ]));
    expect(markAttr(run, 'link', 'href')).toBe('https://example.com');
    expect(markAttr(run, 'font_family', 'name')).toBe('Aptos');
    expect(markAttr(run, 'font_size', 'halfPoints')).toBe(26);
    expect(markAttr(run, 'font_color', 'color')).toBe('C00000');
    expect(markAttr(run, 'highlight', 'color')).toBe('yellow');

    expect(markNames(textRun(doc, 'struck'))).toContain('strikethrough');
  });

  it('normalizes Word mso-highlight before schema parsing', () => {
    const doc = parseHtml(normalizeWordClipboardHtml(`
      <p class="MsoNormal">
        <span style="mso-highlight:yellow">marked</span>
      </p>
    `));

    expect(markAttr(textRun(doc, 'marked'), 'highlight', 'color')).toBe('yellow');
  });

  it('normalizes Word debate style names into CardMirror nodes and marks', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoHeading4"><span>Funding takeout</span></p>
      <p class="MsoNormal">
        <span style='mso-style-name:"Style13ptBold"'>McCuskey 24.</span>
      </p>
      <p class="MsoNormal">
        <span style='mso-style-name:"StyleUnderline"'>states solve</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'cite_paragraph',
      'paragraph',
    ]);
    expect(markNames(textRunInSlice(slice, 'McCuskey 24.'))).toContain('cite_mark');
    expect(markNames(textRunInSlice(slice, 'states solve'))).toContain('underline_mark');
  });

  it('lets the Word style name Tag override heading level 3', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.MsoHeading3 { mso-style-name:Tag; mso-outline-level:3; font-weight:bold; font-size:13.0pt; }
      </style>
      <p class="MsoHeading3"><span>Healthcare costs</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag']);
  });

  it('lets a Tag class beat the generic MsoHeading3 class when Word emits both', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoHeading3 Tag"><span>Healthcare costs</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag']);
  });

  it('promotes a Word paragraph to Tag when the Tag style is carried by the only span', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoNormal"><span style="mso-style-name:Tag; font-weight:bold; font-size:13.0pt">Healthcare costs</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag']);
  });

  it('promotes a whole paragraph to Tag when Word puts the linked Tag character style on the text run', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoNormal">
        <span style='mso-style-name:"Tag Char"'>Healthcare costs</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag']);
  });

  it('recognizes bare Word Tag and Emphasis classes when the clipboard omits Mso class names', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="Tag"><span>Healthcare costs</span></p>
      <p><span class="Emphasis"><i>turns case</i></span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'paragraph',
    ]);
    expect(markNames(textRunInSlice(slice, 'turns case'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'turns case'))).not.toContain('italic');
  });

  it('normalizes Word stylesheet classes before schema parsing', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.CardMirrorTag { mso-outline-level:4; font-weight:bold; }
        span.WordBold { font-weight:bold; }
        span.WordEmphasis { mso-style-name:Emphasis; font-style:italic; }
      </style>
      <p class="CardMirrorTag"><span>Funding takeout</span></p>
      <p class="MsoNormal"><span class="WordBold">actual bold</span></p>
      <p class="MsoNormal"><span class="WordEmphasis"><i>real emphasis</i></span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'paragraph',
      'paragraph',
    ]);
    expect(markNames(textRunInSlice(slice, 'actual bold'))).toContain('bold');
    expect(markNames(textRunInSlice(slice, 'real emphasis'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'real emphasis'))).not.toContain('italic');
  });

  it('normalizes legacy Verbatim Word style aliases from the clipboard', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.LegacyTag { mso-style-name:Tags; font-weight:bold; }
        span.LegacyCite { mso-style-name:"Style Bold"; }
        span.LegacyEmphasis { mso-style-name:"Style Emphasis"; font-style:italic; }
      </style>
      <p class="LegacyTag"><span>Healthcare costs</span></p>
      <p class="MsoNormal">
        <span class="LegacyCite">McCuskey 24</span>
        <span class="LegacyEmphasis"><i>turns case</i></span>
      </p>
      <p class="MsoNormal">
        <span style='mso-style-name:"Emphasis Char"; font-style:italic'><i>not direct italic</i></span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'cite_paragraph',
      'paragraph',
    ]);
    expect(markNames(textRunInSlice(slice, 'McCuskey 24'))).toContain('cite_mark');
    expect(markNames(textRunInSlice(slice, 'turns case'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'turns case'))).not.toContain('italic');
    expect(markNames(textRunInSlice(slice, 'not direct italic'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'not direct italic'))).not.toContain('italic');
  });

  it('normalizes legacy Block Headings Word styles into block nodes', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.LegacyBlock { mso-style-name:"Block Headings"; font-weight:bold; }
        p.LegacyBlockTitle { mso-style-name:"Block Title"; font-weight:bold; }
      </style>
      <p class="LegacyBlock"><span>Framework</span></p>
      <p class="LegacyBlockTitle"><span>Case turns</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'block',
      'block',
    ]);
  });

  it('applies paragraph-level Word Emphasis classes to direct paragraph text', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.WordEmphasis { mso-style-name:Emphasis; font-style:italic; }
      </style>
      <p class="MsoNormal WordEmphasis">paragraph emphasis</p>
    `));

    expect(markNames(textRunInSlice(slice, 'paragraph emphasis'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'paragraph emphasis'))).not.toContain('italic');
  });

  it('recognizes Word intense emphasis as CardMirror emphasis instead of italic', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoNormal"><span class="MsoIntenseEmphasis">intense emphasis</span></p>
    `));

    expect(markNames(textRunInSlice(slice, 'intense emphasis'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'intense emphasis'))).not.toContain('italic');
  });

  it('turns any pasted italic HTML into CardMirror emphasis', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p><em>plain em tag</em></p>
      <p><span style="font-style:italic">plain italic style</span></p>
    `));

    expect(markNames(textRunInSlice(slice, 'plain em tag'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'plain em tag'))).not.toContain('italic');
    expect(markNames(textRunInSlice(slice, 'plain italic style'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'plain italic style'))).not.toContain('italic');
  });

  it('treats a short Heading 3 line immediately above a cite as a tag', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.MsoHeading3 { mso-style-name:"Heading 3"; mso-outline-level:3; font-weight:bold; }
        span.WordCite { mso-style-name:"Style13ptBold"; font-weight:bold; }
      </style>
      <p class="MsoHeading3"><span>Healthcare costs</span></p>
      <p class="MsoNormal"><span class="WordCite">McCuskey 24.</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'cite_paragraph',
    ]);
  });

  it('does not turn a native CardMirror block above a cite into a tag', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <h4 class="pmd-tag" data-id="tag-noise">Existing tag in copied content</h4>
      <h3 class="pmd-block" data-id="block-native">Framework</h3>
      <p class="pmd-cite-para"><span class="pmd-cite">McCuskey 24.</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'block',
      'cite_paragraph',
    ]);
  });

  it('keeps CardMirror heading classes authoritative when Word rewrites element names', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <h1 class="pmd-pocket">Pocket title</h1>
      <h1 class="pmd-hat">Hat title</h1>
      <p class="pmd-block">Block title</p>
      <h1 class="pmd-tag">Tag title</h1>
      <p class="pmd-cite-para"><span class="pmd-cite">Author 24.</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'pocket',
      'hat',
      'block',
      'tag',
      'cite_paragraph',
    ]);
  });

  it('keeps CardMirror mark classes authoritative when Word rewrites inline tags', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="pmd-cite-para">
        <b class="pmd-cite">Author 24</b>
        <i class="pmd-emphasis">not italic</i>
      </p>
      <p class="pmd-card-body">
        <b>real bold</b>
        <span> plain body</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'cite_paragraph',
      'card_body',
    ]);
    expect(markNames(textRunInSlice(slice, 'Author 24'))).toContain('cite_mark');
    expect(markNames(textRunInSlice(slice, 'not italic'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'not italic'))).not.toContain('italic');
    expect(markNames(textRunInSlice(slice, 'real bold'))).toContain('bold');
    expect(markNames(textRunInSlice(slice, ' plain body'))).not.toContain('bold');
  });

  it('does not import Word-only clipboard CSS as direct marks on CardMirror-to-CardMirror paste', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['hat']!.create({ id: 'h1' }, schema.text('Hat title')),
      schema.nodes['block']!.create({ id: 'b1' }, schema.text('Block title')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag title')),
        schema.nodes['cite_paragraph']!.create(null, [
          schema.text('Author 24', [schema.marks['cite_mark']!.create()]),
          schema.text(' explanatory tail'),
        ]),
        schema.nodes['card_body']!.create(null, [
          schema.text('emphasis', [schema.marks['emphasis_mark']!.create()]),
          schema.text(' normal body'),
        ]),
      ]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema);
    const slice = parseSliceHtml(normalizeWordClipboardHtml(html));

    expect(sliceTopNodeNames(slice)).toEqual([
      'hat',
      'block',
      'card',
    ]);
    expect(markNames(textRunInSlice(slice, 'Hat title'))).not.toEqual(
      expect.arrayContaining(['bold', 'font_size', 'underline_direct']),
    );
    expect(markNames(textRunInSlice(slice, 'Block title'))).not.toEqual(
      expect.arrayContaining(['bold', 'font_size', 'underline_direct']),
    );
    expect(markNames(textRunInSlice(slice, 'Author 24'))).toEqual(['cite_mark']);
    expect(markNames(textRunInSlice(slice, ' explanatory tail'))).toEqual([]);
    expect(markNames(textRunInSlice(slice, 'emphasis'))).toEqual(['emphasis_mark']);
    expect(markNames(textRunInSlice(slice, ' normal body'))).toEqual([]);
  });

  it('exports cite paragraph tails without applying cite styling to the whole paragraph', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Healthcare costs')),
        schema.nodes['cite_paragraph']!.create(null, [
          schema.text('Author 24.', [schema.marks['cite_mark']!.create()]),
          schema.text(' explanatory tail'),
        ]),
      ]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema);
    const wrap = document.createElement('div');
    wrap.innerHTML = html;

    const paraStyle = wrap.querySelector<HTMLElement>('.pmd-cite-para')?.getAttribute('style') ?? '';
    const citeStyle = wrap.querySelector<HTMLElement>('.pmd-cite')?.getAttribute('style') ?? '';

    expect(paraStyle).not.toMatch(/Style13ptBold|font-weight\s*:\s*bold|font-size\s*:\s*13/i);
    expect(citeStyle).toContain('mso-style-name:"Style13ptBold"');

    const slice = parseSliceHtml(normalizeWordClipboardHtml(html));
    expect(markNames(textRunInSlice(slice, 'Author 24.'))).toEqual(['cite_mark']);
    expect(markNames(textRunInSlice(slice, ' explanatory tail'))).toEqual([]);
  });

  it('exports the document body font for Word without reimporting it as a direct mark', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['paragraph']!.create(null, [schema.text('normal body')]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema, { bodyFont: 'Calibri' });

    expect(html).toMatch(/font-family:\s*Calibri\b/);

    const nativeHtml = serializeCardMirrorClipboardHtml(
      schema.nodes['doc']!.create(null, [
        schema.nodes['card']!.create(null, [
          schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag')),
          schema.nodes['card_body']!.create(null, [schema.text('normal body')]),
        ]),
      ]).content,
      schema,
      { bodyFont: 'Calibri' },
    );
    const slice = parseSliceHtml(normalizeWordClipboardHtml(nativeHtml));
    expect(markNames(textRunInSlice(slice, 'normal body'))).not.toContain('font_family');
  });

  it('uses Mac Word heading metadata even when every heading element is h1', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <h1 style='mso-style-name:"Heading 1"; mso-outline-level:1'>Pocket title</h1>
      <h1 style='mso-style-name:"Heading 2"; mso-outline-level:2'>Hat title</h1>
      <h1 style='mso-style-name:"Heading 3"; mso-outline-level:3'>Block title</h1>
      <h1 style='mso-style-name:"Heading 4"; mso-outline-level:4'>Tag title</h1>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'pocket',
      'hat',
      'block',
      'tag',
    ]);
  });

  it('uses a Mac Word Tag character style over generic Heading 3 metadata', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        h1.MsoHeading3 { mso-style-name:"Heading 3"; mso-outline-level:3; font-weight:bold; }
        span.MsoTagChar { mso-style-name:"Tag Char"; font-weight:bold; font-size:13.0pt; }
        span.WordCite { mso-style-name:"Style13ptBold"; font-weight:bold; font-size:13.0pt; }
      </style>
      <h1 class="MsoHeading3"><span class="MsoTagChar">Healthcare costs</span></h1>
      <p class="MsoNormal">
        <span class="WordCite">Author 24.</span>
        <span> plain cite tail</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag', 'cite_paragraph']);
    expect(markNames(textRunInSlice(slice, 'Author 24.'))).toEqual(['cite_mark']);
    expect(markNames(textRunInSlice(slice, ' plain cite tail'))).toEqual([]);
  });

  it('exports CardMirror clipboard HTML with Word-readable heading and mark styles', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['block']!.create(
        { id: 'b1' },
        schema.text('Framework'),
      ),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Healthcare costs')),
        schema.nodes['cite_paragraph']!.create(null, [
          schema.text('McCuskey 24', [schema.marks['cite_mark']!.create()]),
        ]),
        schema.nodes['card_body']!.create(null, [
          schema.text('turns case', [schema.marks['emphasis_mark']!.create()]),
        ]),
      ]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema);

    expect(html).toContain('mso-style-name:&quot;Block Headings&quot;');
    expect(html).toContain('mso-style-name:Tag');
    expect(html).toContain('mso-style-name:&quot;Style13ptBold&quot;');
    expect(html).toContain('mso-style-name:Emphasis');
    expect(html).toContain('text-decoration:underline');
  });

  it('does not export guessed direct heading or cite typography that overrides Word styles', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['pocket']!.create({ id: 'p1' }, schema.text('Pocket')),
      schema.nodes['hat']!.create({ id: 'h1' }, schema.text('Hat')),
      schema.nodes['block']!.create({ id: 'b1' }, schema.text('Block')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag')),
        schema.nodes['cite_paragraph']!.create(null, [
          schema.text('Author 24', [schema.marks['cite_mark']!.create()]),
          schema.text(' plain tail'),
        ]),
      ]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema, { bodyFont: 'Calibri' });
    const wrap = document.createElement('div');
    wrap.innerHTML = html;

    for (const selector of ['.pmd-pocket', '.pmd-hat', '.pmd-block', '.pmd-tag']) {
      const style = wrap.querySelector<HTMLElement>(selector)?.getAttribute('style') ?? '';
      expect(style).toContain('mso-style-name');
      expect(style).not.toMatch(/font-size\s*:/i);
      expect(style).not.toMatch(/font-weight\s*:/i);
    }

    const citeParaStyle = wrap.querySelector<HTMLElement>('.pmd-cite-para')?.getAttribute('style') ?? '';
    const citeStyle = wrap.querySelector<HTMLElement>('.pmd-cite')?.getAttribute('style') ?? '';
    expect(citeParaStyle).toContain('mso-style-name:Normal');
    expect(citeParaStyle).toMatch(/font-family:\s*Calibri\b/);
    expect(citeParaStyle).not.toMatch(/font-size\s*:/i);
    expect(citeStyle).toContain('mso-style-name:"Style13ptBold"');
    expect(citeStyle).not.toMatch(/font-size\s*:/i);
    expect(citeStyle).not.toMatch(/font-weight\s*:/i);
  });

  it('recognizes Mac Word Tag linked to Heading 3 and keeps the citation tail normal', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.MsoHeading3 { mso-style-name:"Heading 3"; mso-style-link:"Tag"; mso-outline-level:3; font-weight:bold; }
        span.WordCite { mso-style-name:"Style13ptBold"; font-weight:bold; font-size:13.0pt; }
      </style>
      <p class="MsoHeading3"><span>Healthcare costs</span></p>
      <p class="MsoNormal">
        <span class="WordCite">McCuskey 24.</span>
        <span> Journal of Health Economics.</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag', 'cite_paragraph']);
    expect(markNames(textRunInSlice(slice, 'McCuskey 24.'))).toEqual(['cite_mark']);
    expect(markNames(textRunInSlice(slice, ' Journal of Health Economics.'))).toEqual([]);
  });

  it('exports font-family as standard clipboard CSS for other apps', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('fonted text', [
          schema.marks['font_family']!.create({ name: 'Aptos' }),
        ]),
      ]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema);

    expect(html).toContain('data-font-family="Aptos"');
    expect(html).toMatch(/font-family:\s*Aptos\b/);
  });

  it('keeps pasted CardMirror analytics as analytic units', () => {
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['analytic_unit']!.create(null, [
        schema.nodes['analytic']!.create({ id: 'a1' }, schema.text('Turn overview')),
        schema.nodes['cite_paragraph']!.create(null, [
          schema.text('Author 24', [schema.marks['cite_mark']!.create()]),
        ]),
        schema.nodes['card_body']!.create(null, [
          schema.text('evidence text'),
        ]),
      ]),
    ]);
    const html = serializeCardMirrorClipboardHtml(doc.content, schema);
    const slice = parseSliceHtml(normalizeWordClipboardHtml(html));

    expect(sliceTopNodeNames(slice)).toEqual(['analytic_unit']);
    expect(slice.content.firstChild?.firstChild?.type.name).toBe('analytic');
  });

  it('promotes Word Analytic character style paragraphs to analytic units', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoNormal">
        <span style='mso-style-name:"Analytic Char"; font-weight:bold; font-size:13.0pt'>
          Analytic overview
        </span>
      </p>
      <p class="MsoNormal">
        <span style='mso-style-name:"Style13ptBold"'>Author 24.</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['analytic_unit']);
    expect(slice.content.firstChild?.firstChild?.type.name).toBe('analytic');
    expect(markNames(textRunInSlice(slice, 'Author 24.'))).toContain('cite_mark');
  });

  it('keeps native CardMirror cite/body clipboard HTML from being re-inferred as tags', () => {
    const fragment = schema.nodes['doc']!.create(null, [
      schema.nodes['cite_paragraph']!.create(null, [
        schema.text('analytic cite', [schema.marks['cite_mark']!.create()]),
      ]),
      schema.nodes['card_body']!.create(null, [
        schema.text('analytic body'),
      ]),
    ]).content;
    const html = serializeCardMirrorClipboardHtml(fragment, schema);
    const slice = reparseClipboardStructuralSlice(clipboardEventWithHtml(html));

    expect(slice).not.toBeNull();
    expect(sliceTopNodeNames(slice!)).toEqual([
      'cite_paragraph',
      'card_body',
    ]);
    expect(slice!.content.firstChild?.textContent).toBe('analytic cite');
  });

  it('treats a short Heading 3 line above a cite as a tag even with Word spacing noise', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.MsoHeading3 { mso-style-name:"Heading 3"; mso-outline-level:3; font-weight:bold; }
        span.WordCite { mso-style-name:"Style13ptBold"; font-weight:bold; }
      </style>
      <p class="MsoHeading3"><span>Healthcare costs</span></p>
      <p class="MsoNormal"><span>&nbsp;</span></p>
      <p class="MsoNormal"><span class="WordCite">McCuskey 24.</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'cite_paragraph',
    ]);
  });

  it('uses a citation-looking line to recover a Heading 3 tag even when Word drops debate style names', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.MsoHeading3 { mso-style-name:"Heading 3"; mso-outline-level:3; font-weight:bold; }
      </style>
      <p class="MsoHeading3"><span>Healthcare costs</span></p>
      <p class="MsoNormal">
        <span>McCuskey 24. Journal of Health Economics, https://example.com/article</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'cite_paragraph',
    ]);
    expect(markNames(textRunInSlice(slice, 'McCuskey 24. Journal of Health Economics, https://example.com/article'))).toContain('cite_mark');
  });

  it('recognizes Word linked style metadata when style-name is generic', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <style>
        p.WordLinkedTag { mso-style-name:"Heading 3"; mso-style-link:"Tag Char"; mso-outline-level:3; font-weight:bold; }
      </style>
      <p class="WordLinkedTag"><span>Healthcare costs</span></p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual(['tag']);
  });

  it('normalizes Word tags and emphasis when recovering a structural paste from raw clipboard HTML', () => {
    const slice = reparseClipboardStructuralSlice(clipboardEventWithHtml(`
      <style>
        p.MsoHeading3 { mso-style-name:Tag; mso-outline-level:3; font-weight:bold; font-size:13.0pt; }
        span.WordCite { mso-style-name:"Style13ptBold"; font-weight:bold; }
      </style>
      <p class="MsoHeading3"><span>Healthcare costs</span></p>
      <p class="MsoNormal">
        <span class="WordCite">McCuskey 24.</span>
        <span style="font-style:italic">turns case</span>
      </p>
    `));

    expect(slice).not.toBeNull();
    expect(sliceTopNodeNames(slice!)).toEqual([
      'tag',
      'cite_paragraph',
    ]);
    expect(markNames(textRunInSlice(slice!, 'turns case'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice!, 'turns case'))).not.toContain('italic');
  });

  it('infers tags and emphasis from Word visual formatting without style names', () => {
    const slice = parseSliceHtml(normalizeWordClipboardHtml(`
      <p class="MsoNormal" style="margin:0in">
        <span style="font-size:13.0pt; font-weight:bold">Healthcare costs</span>
      </p>
      <p class="MsoNormal">
        <span>Rising costs </span>
        <span style="font-style:italic">crowd out investment</span>
      </p>
    `));

    expect(sliceTopNodeNames(slice)).toEqual([
      'tag',
      'paragraph',
    ]);
    expect(markNames(textRunInSlice(slice, 'crowd out investment'))).toContain('emphasis_mark');
    expect(markNames(textRunInSlice(slice, 'crowd out investment'))).not.toContain('italic');
  });
});
