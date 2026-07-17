/**
 * Live zones flatten to their child content on .docx export, dropping the
 * transclusion identity (TRANSCLUSION_PLAN.md §10) — the zone is a transparent
 * container. The .cmir path preserves the node (tests/editor/transclusion.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { exportDoc } from '../../src/export/index.js';
import { extractSection, prepareZoneContent, createTransclusionNode } from '../../src/editor/transclusion.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, text ? schema.text(text) : undefined);
}
function body(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function card(tagText: string, bodyText: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    heading('tag', tagText, newHeadingId()),
    body(bodyText),
  ]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}
/** Build a zone whose children are the section under `headingId` in a source. */
function zoneFor(sourceChildren: PMNode[], headingId: string): PMNode {
  const section = extractSection(doc(sourceChildren), headingId)!;
  const { content, hash } = prepareZoneContent(section.content, newHeadingId);
  return createTransclusionNode(
    schema,
    { source_ref: '../Impacts/Src.cmir', source_heading_id: headingId, source_content_hash: hash },
    content,
  );
}

describe('docx flatten', () => {
  it('emits the child cards as ordinary content; drops the zone identity', () => {
    const zone = zoneFor(
      [heading('block', 'Category Header', 'bid'), card('First Tag', 'first evidence'), card('Second Tag', 'second evidence')],
      'bid',
    );
    const d = doc([heading('block', 'My Own Header', newHeadingId()), zone]);
    const { documentXml } = exportDoc(d);
    expect(documentXml).toContain('First Tag');
    expect(documentXml).toContain('first evidence');
    expect(documentXml).toContain('Second Tag');
    expect(documentXml).toContain('My Own Header');
    expect(documentXml).not.toContain('Category Header'); // excluded source header
    expect(documentXml).not.toContain('transclusion');
    expect(documentXml).not.toContain('Src.cmir');
    expect(documentXml).toContain('<w:body>');
    expect(documentXml).toContain('</w:document>');
  });

  it('an empty zone emits nothing (no crash, valid doc)', () => {
    const zone = createTransclusionNode(schema, { source_ref: '../gone.cmir', source_heading_id: 'x' });
    const d = doc([heading('block', 'Only Header', newHeadingId()), zone]);
    const { documentXml } = exportDoc(d);
    expect(documentXml).toContain('Only Header');
    expect(documentXml).toContain('</w:document>');
  });

  it('nested zones flatten too', () => {
    const inner = zoneFor([heading('block', 'Inner Cat', 'iid'), card('Inner Tag', 'inner ev')], 'iid');
    const outer = createTransclusionNode(
      schema,
      { source_ref: '../a.cmir', source_heading_id: 'outer' },
      Fragment.fromArray([inner, card('Outer Tag', 'outer ev')]),
    );
    const { documentXml } = exportDoc(doc([outer]));
    expect(documentXml).toContain('inner ev');
    expect(documentXml).toContain('outer ev');
    expect(documentXml).not.toContain('transclusion');
  });
});
