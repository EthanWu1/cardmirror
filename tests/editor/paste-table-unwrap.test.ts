// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { unwrapSingleCellTables } from '../../src/editor/paste-plugin.js';

function p(text = '') {
  return schema.nodes['paragraph']!.create(
    null,
    text ? schema.text(text) : null,
  );
}

function cellOf(...paragraphs: PMNode[]) {
  return schema.nodes['table_cell']!.create(
    null,
    paragraphs.length > 0 ? Fragment.fromArray(paragraphs) : Fragment.from(p()),
  );
}

function rowOf(...cells: PMNode[]) {
  return schema.nodes['table_row']!.create(null, Fragment.fromArray(cells));
}

function tableOf(...rows: PMNode[]) {
  return schema.nodes['table']!.create(null, Fragment.fromArray(rows));
}

function sliceOf(...children: PMNode[]) {
  return new Slice(Fragment.fromArray(children), 0, 0);
}

function childTypes(slice: Slice): string[] {
  const out: string[] = [];
  slice.content.forEach((c) => out.push(c.type.name));
  return out;
}

describe('unwrapSingleCellTables', () => {
  it('drops an empty 1×1 table entirely', () => {
    const slice = sliceOf(tableOf(rowOf(cellOf(p()))));
    const out = unwrapSingleCellTables(slice);
    expect(childTypes(out)).toEqual([]);
  });

  it('lifts paragraphs out of a 1×1 table with content', () => {
    const slice = sliceOf(tableOf(rowOf(cellOf(p('hello'), p('world')))));
    const out = unwrapSingleCellTables(slice);
    expect(childTypes(out)).toEqual(['paragraph', 'paragraph']);
    expect(out.content.child(0).textContent).toBe('hello');
    expect(out.content.child(1).textContent).toBe('world');
  });

  it('lifts every row of a single-column table (vertical-stack layout)', () => {
    const slice = sliceOf(
      tableOf(
        rowOf(cellOf(p('a'))),
        rowOf(cellOf(p('b'))),
        rowOf(cellOf(p('c'))),
      ),
    );
    const out = unwrapSingleCellTables(slice);
    expect(childTypes(out)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(out.content.child(0).textContent).toBe('a');
    expect(out.content.child(2).textContent).toBe('c');
  });

  it('leaves a multi-cell-per-row data table untouched', () => {
    const dataTable = tableOf(
      rowOf(cellOf(p('h1')), cellOf(p('h2'))),
      rowOf(cellOf(p('v1')), cellOf(p('v2'))),
    );
    const slice = sliceOf(dataTable);
    const out = unwrapSingleCellTables(slice);
    expect(childTypes(out)).toEqual(['table']);
    expect(out.content.child(0).eq(dataTable)).toBe(true);
  });

  it('leaves a mixed table with some multi-cell rows untouched', () => {
    const mixed = tableOf(
      rowOf(cellOf(p('only'))),
      rowOf(cellOf(p('a')), cellOf(p('b'))),
    );
    const slice = sliceOf(mixed);
    const out = unwrapSingleCellTables(slice);
    expect(childTypes(out)).toEqual(['table']);
  });

  it('returns the same Slice instance when nothing changes', () => {
    const slice = sliceOf(p('untouched'));
    const out = unwrapSingleCellTables(slice);
    expect(out).toBe(slice);
  });

  it('passes a tag-led slice through (no table to unwrap)', () => {
    const tag = schema.nodes['tag']!.create(
      { id: 'x' },
      schema.text('heading'),
    );
    const slice = sliceOf(tag);
    const out = unwrapSingleCellTables(slice);
    expect(out).toBe(slice);
  });

  it('emits card_body when unwrapping a table nested inside a card', () => {
    const tag = schema.nodes['tag']!.create({ id: 'x' }, schema.text('T'));
    const cite = schema.nodes['cite_paragraph']!.create(null);
    const inner = tableOf(rowOf(cellOf(p('lifted'))));
    const card = schema.nodes['card']!.create(null, Fragment.fromArray([tag, cite, inner]));
    const slice = sliceOf(card);
    const out = unwrapSingleCellTables(slice);
    const newCard = out.content.child(0);
    const childTypesInCard: string[] = [];
    newCard.forEach((c) => childTypesInCard.push(c.type.name));
    expect(childTypesInCard).toEqual(['tag', 'cite_paragraph', 'card_body']);
    expect(newCard.lastChild!.textContent).toBe('lifted');
  });
});
