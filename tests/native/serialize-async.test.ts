/**
 * Async serialization path (`serializeNativeAsync` / `gzipAsync`) —
 * used by the editor's debounced journal/autosave writes so the gzip
 * DEFLATE runs off the main thread. The contract is byte-compatibility
 * with the sync path: same input, same output bytes (the two share the
 * envelope builder, so codec-level equality covers the whole pipe).
 */

import { describe, expect, it } from 'vitest';
import { gzip, gzipAsync, gunzip, isGzip } from '../../src/native/codec.js';
import { serializeNativeAsync, parseNative } from '../../src/index.js';
import { schema } from '../../src/schema/index.js';

describe('gzipAsync', () => {
  it('produces byte-identical output to the sync gzip', async () => {
    const input = new TextEncoder().encode(
      JSON.stringify({ pad: 'y'.repeat(50_000), arr: Array.from({ length: 200 }, (_, i) => i) }),
    );
    const syncOut = gzip(input);
    const asyncOut = await gzipAsync(input);
    expect(Buffer.compare(Buffer.from(asyncOut), Buffer.from(syncOut))).toBe(0);
  });

  it('round-trips through gunzip', async () => {
    const input = new TextEncoder().encode('journal payload '.repeat(1000));
    const out = await gzipAsync(input);
    expect(isGzip(out)).toBe(true);
    expect(Buffer.compare(Buffer.from(gunzip(out)), Buffer.from(input))).toBe(0);
  });
});

describe('serializeNativeAsync', () => {
  it('round-trips doc and docId through parseNative', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hello async world')),
    ]);
    const bytes = await serializeNativeAsync(doc, { docId: 'test-doc-id' });
    expect(isGzip(bytes)).toBe(true);
    const parsed = parseNative(bytes);
    expect(parsed.doc.eq(doc)).toBe(true);
    expect(parsed.docId).toBe('test-doc-id');
  });
});
