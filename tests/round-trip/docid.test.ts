/**
 * docId round-trip — the Learn annotation layer's stable document identity
 * survives both formats (.cmir field, .docx docProps/custom.xml), and is
 * absent (null) on files that don't carry it.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocxFull } from '../../src/import/index.js';
import { readDocIdFromBytes, stampDocId } from '../../src/docid.js';
import { Docx } from '../../src/ooxml/docx.js';

const DOC_ID = '8f3c2a10-0000-4000-8000-aabbccddeeff';

function sampleDoc() {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text('Hello world.')),
  ]);
}

describe('docId — .cmir native', () => {
  it('round-trips when present', () => {
    const bytes = serializeNative(sampleDoc(), { docId: DOC_ID });
    expect(parseNative(bytes).docId).toBe(DOC_ID);
  });
  it('is null when not written', () => {
    expect(parseNative(serializeNative(sampleDoc())).docId).toBeNull();
  });
});

describe('docId — .docx docProps', () => {
  it('round-trips when present', async () => {
    const bytes = await toDocx(sampleDoc(), { docId: DOC_ID });
    expect((await fromDocxFull(bytes)).docId).toBe(DOC_ID);
  });
  it('is null when not written', async () => {
    const bytes = await toDocx(sampleDoc());
    expect((await fromDocxFull(bytes)).docId).toBeNull();
  });
});

describe('docId — preserves other custom document properties', () => {
  const FOREIGN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Company"><vt:lpwstr>Acme Debate</vt:lpwstr></property></Properties>`;

  it('merges into an existing custom.xml instead of clobbering it', async () => {
    const docx = await Docx.load(await toDocx(sampleDoc()));
    docx.writeText('docProps/custom.xml', FOREIGN);
    await docx.writeDocId(DOC_ID);
    const merged = await docx.readText('docProps/custom.xml');
    expect(merged).toContain('name="Company"');
    expect(merged).toContain('Acme Debate');
    expect(merged).toContain('name="cmirDocId"');
    expect(await docx.readDocId()).toBe(DOC_ID);
  });

  it('re-stamping replaces the id without duplicating or losing others', async () => {
    const docx = await Docx.load(await toDocx(sampleDoc()));
    docx.writeText('docProps/custom.xml', FOREIGN);
    await docx.writeDocId(DOC_ID);
    const second = '11112222-0000-4000-8000-aabbccddeeff';
    await docx.writeDocId(second);
    const merged = await docx.readText('docProps/custom.xml');
    expect((merged!.match(/name="cmirDocId"/g) ?? []).length).toBe(1);
    expect(merged).toContain('name="Company"');
    expect(await docx.readDocId()).toBe(second);
  });
});

describe('stampDocId / readDocIdFromBytes — link a card to an id-less file', () => {
  it('.cmir: stamps an id in, preserving content', async () => {
    const bytes = serializeNative(sampleDoc()); // no docId
    expect(await readDocIdFromBytes(bytes, 'cmir')).toBeNull();
    const stamped = await stampDocId(bytes, 'cmir', DOC_ID);
    expect(await readDocIdFromBytes(stamped, 'cmir')).toBe(DOC_ID);
    // content intact + re-parses with the id
    const parsed = parseNative(stamped);
    expect(parsed.docId).toBe(DOC_ID);
    expect(parsed.doc.textContent).toBe('Hello world.');
  });

  it('.docx: stamps an id in without re-rendering, and reads it back', async () => {
    const bytes = await toDocx(sampleDoc()); // no docId
    expect(await readDocIdFromBytes(bytes, 'docx')).toBeNull();
    const stamped = await stampDocId(bytes, 'docx', DOC_ID);
    expect(await readDocIdFromBytes(stamped, 'docx')).toBe(DOC_ID);
    const reimported = await fromDocxFull(stamped);
    expect(reimported.docId).toBe(DOC_ID);
    expect(reimported.doc.textContent).toBe('Hello world.');
  });
});
