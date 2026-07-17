// @vitest-environment jsdom
/**
 * Structural ribbon commands (F4–F7 / Mod-F7) inside a live zone.
 *
 * A `transclusion_ref` is a mini-doc (same BLOCK_CONTENT), one level deeper than
 * the doc root. The commands measure depth relative to `structuralBaseDepth`, so
 * they operate INSIDE the zone — new cards/headings land within it — instead of
 * silently no-opping (their old absolute `depth === 1/2` gates never matched a
 * level deeper). The doc-level behavior is covered by ribbon-commands.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import type { Command as PMCommand } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createTransclusionNode, contentHash, isTransclusionNode } from '../../src/editor/transclusion.js';
import { setTag, setHeading, setAnalytic } from '../../src/editor/ribbon-commands.js';
import { enterAtZoneStart } from '../../src/editor/tag-keymap.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function zone(children: PMNode[]): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(schema, { source_content_hash: contentHash(content) }, content);
}
function docOf(...blocks: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, blocks);
}
/** First text position matching `needle` (cursor sits just inside it). */
function posOf(doc: PMNode, needle: string): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text?.includes(needle)) pos = p + 1;
    return true;
  });
  return pos;
}
/** Run a command with the cursor at `pos`; return the resulting doc. */
function run(doc: PMNode, pos: number, cmd: PMCommand): PMNode {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  let outDoc = doc;
  const ok = cmd(state, (tr) => {
    outDoc = state.apply(tr).doc;
  });
  expect(ok, 'command should handle the key inside a zone').toBe(true);
  return outDoc;
}
/** parentOffset-0 position at the start of the heading whose text is `text`. */
function startOf(doc: PMNode, text: string): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (
      pos < 0 &&
      ['tag', 'pocket', 'hat', 'block', 'analytic'].includes(n.type.name) &&
      n.textContent === text
    ) {
      pos = p + 1;
    }
    return true;
  });
  return pos;
}

/** Position at the END of the body/text run containing `text`. */
function endOfBody(doc: PMNode, text: string): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text?.includes(text)) pos = p + n.text!.length;
    return true;
  });
  return pos;
}

/** The single zone node in a doc + its direct-child type names. */
function zoneChildren(doc: PMNode): string[] {
  let names: string[] = [];
  doc.descendants((n) => {
    if (isTransclusionNode(n)) {
      const out: string[] = [];
      n.forEach((c) => out.push(c.type.name));
      names = out;
      return false;
    }
    return true;
  });
  return names;
}

describe('ribbon structural commands inside a live zone', () => {
  it('F7 (setTag) on a card body splits into a NEW card — inside the zone', () => {
    const doc = docOf(zone([card('First', 'splitme')]));
    const after = run(doc, posOf(doc, 'splitme'), setTag());
    // The zone now holds two cards (original + the body promoted to a new card),
    // and nothing leaked out to the doc level.
    expect(zoneChildren(after)).toEqual(['card', 'card']);
    expect(after.childCount).toBe(1); // still just the zone at doc level
    // The new card carries the split-off text.
    expect(after.textContent).toContain('splitme');
  });

  it('F6 (setHeading block) converts a loose paragraph in the zone in place', () => {
    const doc = docOf(zone([schema.nodes['paragraph']!.create(null, schema.text('lead in'))]));
    const after = run(doc, posOf(doc, 'lead in'), setHeading('block'));
    expect(zoneChildren(after)).toEqual(['block']);
    expect(after.childCount).toBe(1);
  });

  it('Mod-F7 (setAnalytic) wraps a loose paragraph into an analytic_unit in the zone', () => {
    const doc = docOf(zone([schema.nodes['paragraph']!.create(null, schema.text('an analytic'))]));
    const after = run(doc, posOf(doc, 'an analytic'), setAnalytic());
    expect(zoneChildren(after)).toEqual(['analytic_unit']);
    expect(after.childCount).toBe(1);
  });

  it('F7 on a doc-level paragraph still wraps at doc level (base 0 unchanged)', () => {
    const doc = docOf(schema.nodes['paragraph']!.create(null, schema.text('plain')));
    const after = run(doc, posOf(doc, 'plain'), setTag());
    expect(after.child(0).type.name).toBe('card');
  });
});

describe('zone heading-level ceiling (no heading higher than the zone contains)', () => {
  function blockTopped(): PMNode {
    return docOf(
      zone([
        schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Blk')),
        card('T', 'body'),
      ]),
    );
  }

  it('blocks a higher-rank heading (F5 hat inside a block-topped zone) — no change', () => {
    const doc = blockTopped();
    const before = zoneChildren(doc);
    const after = run(doc, posOf(doc, 'body'), setHeading('hat'));
    expect(zoneChildren(after)).toEqual(before);
  });

  it('blocks a sibling block (F6) in a block-topped zone — no change', () => {
    const doc = blockTopped();
    const before = zoneChildren(doc);
    const after = run(doc, posOf(doc, 'body'), setHeading('block'));
    expect(zoneChildren(after)).toEqual(before);
  });

  it('allows a card (F7) in a block-topped zone', () => {
    const doc = blockTopped();
    const after = run(doc, posOf(doc, 'body'), setTag());
    expect(zoneChildren(after).filter((t) => t === 'card').length).toBe(2);
  });

  it('allows a block inside a pocket-topped zone (legitimate sub-structure)', () => {
    const doc = docOf(
      zone([
        schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pkt')),
        schema.nodes['paragraph']!.create(null, schema.text('para')),
      ]),
    );
    const after = run(doc, posOf(doc, 'para'), setHeading('block'));
    expect(zoneChildren(after)).toContain('block');
  });
});

describe('Enter at the top edge of a zone spawns a header above, outside it', () => {
  it('Enter at the start of the zone’s first card tag → new card before the zone', () => {
    const doc = docOf(zone([card('First', 'body')]));
    const after = run(doc, startOf(doc, 'First'), enterAtZoneStart);
    expect(after.childCount).toBe(2);
    expect(after.child(0).type.name).toBe('card');
    expect(after.child(0).textContent).toBe(''); // new empty tag
    expect(isTransclusionNode(after.child(1))).toBe(true);
    expect(zoneChildren(after)).toEqual(['card']); // original still inside the zone
  });

  it('Enter at the start of a standalone block at the zone top → block before the zone', () => {
    const doc = docOf(
      zone([
        schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Blk')),
        card('T', 'b'),
      ]),
    );
    const after = run(doc, startOf(doc, 'Blk'), enterAtZoneStart);
    expect(after.childCount).toBe(2);
    expect(after.child(0).type.name).toBe('block');
    expect(after.child(0).textContent).toBe('');
    expect(isTransclusionNode(after.child(1))).toBe(true);
  });

  it('does nothing at the start of a NON-first header inside the zone (stays in)', () => {
    const doc = docOf(zone([card('First', 'b1'), card('Second', 'b2')]));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, startOf(doc, 'Second')),
    });
    expect(enterAtZoneStart(state, undefined)).toBe(false);
  });
});

describe('a heading key at the bottom edge of a zone breaks out, after it', () => {
  it('F7 at the end of the zone’s last body → new card AFTER the zone', () => {
    const doc = docOf(zone([card('T', 'lastbody')]));
    const after = run(doc, endOfBody(doc, 'lastbody'), setTag());
    expect(after.childCount).toBe(2);
    expect(isTransclusionNode(after.child(0))).toBe(true); // zone kept its tag
    expect(after.child(1).type.name).toBe('card'); // new card outside
    expect(after.child(1).textContent).toBe('lastbody');
  });

  it('F6 at the zone bottom breaks out even when the ceiling would block it inside', () => {
    const doc = docOf(
      zone([
        schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Blk')),
        card('T', 'lastbody'),
      ]),
    );
    const after = run(doc, endOfBody(doc, 'lastbody'), setHeading('block'));
    expect(after.childCount).toBe(2);
    expect(isTransclusionNode(after.child(0))).toBe(true);
    expect(after.child(1).type.name).toBe('block'); // OUTSIDE — ceiling exempt
    expect(after.child(1).textContent).toBe('lastbody');
  });

  it('F7 at a NON-last body stays INSIDE the zone (no break-out)', () => {
    const doc = docOf(zone([card('First', 'body1'), card('Second', 'body2')]));
    const after = run(doc, endOfBody(doc, 'body1'), setTag());
    expect(after.childCount).toBe(1); // still just the zone
    expect(isTransclusionNode(after.child(0))).toBe(true);
    expect(zoneChildren(after).filter((t) => t === 'card').length).toBe(3);
  });
});
