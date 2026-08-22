/**
 * The persistent-collaboration pointer rides inside the `.cmir` envelope, so
 * opening a shared file anywhere can rejoin its room. A malformed pointer must
 * read as absent rather than be trusted — a bad roomId would send the opener
 * at a room that does not exist.
 */

import { describe, it, expect } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { serializeNative, serializeNativeAsync, parseNative } from '../../src/native/index.js';

const doc = schema.nodes['doc']!.create(null, [
  schema.nodes['paragraph']!.create(null, [schema.text('shared prep')]),
]);

const pointer = {
  docId: 'doc-123',
  roomId: 'room-abc',
  shareCode: 'code-xyz',
  createdAt: '2026-08-21T00:00:00.000Z',
};

describe('shared-doc envelope', () => {
  it('round-trips the pointer', () => {
    const parsed = parseNative(serializeNative(doc, { sharedDoc: pointer }));
    expect(parsed.sharedDoc).toEqual(pointer);
    expect(parsed.doc.eq(doc)).toBe(true);
  });

  it('is absent on an ordinary file', () => {
    expect(parseNative(serializeNative(doc)).sharedDoc).toBeNull();
  });

  it('rejects a partial pointer rather than half-trusting it', () => {
    for (const bad of [
      { ...pointer, roomId: '' },
      { ...pointer, shareCode: undefined },
      { ...pointer, docId: 42 },
      'not-an-object',
      null,
    ]) {
      const bytes = serializeNative(doc, { sharedDoc: bad as never });
      expect(parseNative(bytes).sharedDoc, `accepted ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('survives the async (gzip) save path too', async () => {
    const bytes = await serializeNativeAsync(doc, { sharedDoc: pointer });
    expect(parseNative(bytes).sharedDoc).toEqual(pointer);
  });
});
