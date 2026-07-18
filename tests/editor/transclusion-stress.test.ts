// @vitest-environment node
/**
 * Stress / abuse coverage for live zones (editable child-content model): real
 * .cmir gzip round-trip, position variants, schema enforcement, huge sections,
 * unicode, id collisions, and extraction edges.
 */
import { describe, expect, it } from 'vitest';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import {
  extractSection,
  prepareZoneContent,
  createTransclusionNode,
  isZoneEdited,
  detachSlice,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, schema.text(text));
}
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}
/** Build a zone from a source doc's section (id-rewritten children). */
function zoneFrom(src: PMNode, headingId: string, attrs: Record<string, unknown> = {}): PMNode {
  const section = extractSection(src, headingId)!;
  const { content, hash } = prepareZoneContent(section.content, newHeadingId);
  return createTransclusionNode(schema, { source_content_hash: hash, ...attrs }, content);
}
function findZone(d: PMNode): PMNode | null {
  let z: PMNode | null = null;
  d.descendants((n) => {
    if (isTransclusionNode(n)) z = n;
    return true;
  });
  return z;
}

describe('real .cmir gzip round-trip', () => {
  it('a doc with a live zone survives serializeNative → parseNative with children intact', () => {
    const src = doc([heading('block', 'B', 'bid'), card('T1', 'e1'), card('T2', 'e2')]);
    const zone = zoneFrom(src, 'bid', {
      source_ref: 'Impacts/Src.cmir',
      source_ref_base: 'root',
      source_heading_id: 'bid',
      last_refreshed: 1720000000000,
      source_label: 'Src › B',
    });
    const d = doc([heading('block', 'Mine', newHeadingId()), zone, schema.nodes['paragraph']!.create()]);
    const round = parseNative(serializeNative(d)).doc;
    const z = findZone(round)!;
    expect(z.attrs['source_ref']).toBe('Impacts/Src.cmir');
    expect(z.attrs['source_ref_base']).toBe('root');
    expect(z.attrs['last_refreshed']).toBe(1720000000000);
    expect(z.childCount).toBe(2);
    expect(z.textContent).toContain('e1');
    expect(isZoneEdited(z)).toBe(false); // hash survives the round-trip
  });

  it('zones at start, middle, and end of a doc all round-trip', () => {
    const src = doc([heading('block', 'B', 'h'), card('T', 'body')]);
    const d = doc([
      zoneFrom(src, 'h'),
      schema.nodes['paragraph']!.create(null, schema.text('mid')),
      zoneFrom(src, 'h'),
      heading('block', 'B2', newHeadingId()),
      zoneFrom(src, 'h'),
    ]);
    const round = parseNative(serializeNative(d)).doc;
    let zones = 0;
    round.descendants((n) => {
      if (isTransclusionNode(n)) zones++;
      return true;
    });
    expect(zones).toBe(3);
  });
});

describe('schema enforcement', () => {
  it('forbids a live zone inside a card (zones live only at the doc / zone level)', () => {
    const zone = createTransclusionNode(schema, {});
    expect(() =>
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
        zone,
      ]),
    ).toThrow();
  });

  it('allows a nested zone as a direct child of a zone', () => {
    const inner = createTransclusionNode(schema, { source_ref: 'i.cmir', source_heading_id: 'ih' });
    expect(() => createTransclusionNode(schema, {}, undefined)).not.toThrow();
    const outer = schema.nodes['transclusion_ref']!.createChecked(null, [inner, card('T', 'e')]);
    expect(outer.childCount).toBe(2);
    expect(outer.child(0).type.name).toBe('transclusion_ref');
  });
});

describe('huge sections', () => {
  it('extracts, prepares, round-trips a 200-card section', () => {
    const cards: PMNode[] = [];
    for (let i = 0; i < 200; i++) cards.push(card(`Tag ${i}`, `evidence ${i}`));
    const src = doc([heading('block', 'Big', 'big'), ...cards]);
    const zone = zoneFrom(src, 'big');
    expect(zone.childCount).toBe(200);
    const round = parseNative(serializeNative(doc([zone]))).doc;
    expect(findZone(round)!.childCount).toBe(200);
  });
});

describe('unicode', () => {
  it('preserves emoji / accents in children + label through extract + round-trip', () => {
    const src = doc([heading('block', 'Réchauffement 🌍', 'u'), card('Tág', 'évidence 日本語')]);
    const zone = zoneFrom(src, 'u', { source_label: 'Fichier › Réchauffement 🌍' });
    const round = parseNative(serializeNative(doc([zone]))).doc;
    const z = findZone(round)!;
    expect(z.attrs['source_label']).toBe('Fichier › Réchauffement 🌍');
    expect(z.textContent).toContain('évidence 日本語');
  });
});

describe('extraction edge cases', () => {
  it('heading at end of doc with nothing under it → empty content', () => {
    const d = doc([card('T', 'x'), heading('block', 'End', 'end')]);
    expect(extractSection(d, 'end')!.content.size).toBe(0);
  });

  it('duplicate heading ids: extraction is deterministic (first match)', () => {
    const d = doc([
      heading('block', 'First', 'dup'),
      card('A', 'aaa'),
      heading('block', 'Second', 'dup'),
      card('B', 'bbb'),
    ]);
    const a = extractSection(d, 'dup')!;
    const b = extractSection(d, 'dup')!;
    expect(JSON.stringify(a.content.toJSON())).toBe(JSON.stringify(b.content.toJSON()));
    expect(JSON.stringify(a.content.toJSON())).toContain('aaa');
    expect(JSON.stringify(a.content.toJSON())).not.toContain('bbb');
  });

  it('detach of an empty zone yields an empty slice', () => {
    const zone = createTransclusionNode(schema, {});
    expect(detachSlice(zone).content.size).toBe(0);
  });
});
