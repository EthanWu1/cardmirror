// @vitest-environment jsdom
/**
 * Seed-cache behaviour.
 *
 * Seeding a session's CRDT from an open document is super-linear (see
 * `collab-seed-core.ts`), so the result is cached by content digest. The two
 * properties that matter are opposites, and both are load-bearing:
 *
 *   HIT  — re-hosting the SAME document must reuse the snapshot, or the
 *          cache is pointless;
 *   MISS — an EDITED document must NOT reuse it, or a session starts from
 *          stale content, which is silent data corruption.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { schema } from '../../src/schema/index.js';
import { seedSnapshot } from '../../src/editor/collab/collab-seed.js';
import { seedSnapshotFromDocJSON } from '../../src/editor/collab/collab-seed-core.js';
import { clearSeedCache, loadSeedCache } from '../../src/editor/collab/collab-store.js';
import { LoroDoc } from 'loro-crdt';
import type { Node as PMNode } from 'prosemirror-model';

/** Big enough to clear INLINE_SEED_MAX_NODE_SIZE (40k) so the cache path runs. */
function bigDoc(cards: number, marker = 'baseline'): PMNode {
  const t = (s: string) => schema.text(s);
  const body =
    'The evidence overwhelmingly demonstrates that failure to act produces ' +
    'cascading consequences across every metric of institutional capacity. ';
  const children = [];
  for (let i = 0; i < cards; i++) {
    children.push(
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create(null, [t(`Tag ${i} ${marker}`)]),
        schema.nodes['card_body']!.create(null, [t(body.repeat(2))]),
      ]),
    );
  }
  return schema.nodes['doc']!.create(null, children);
}

/** Render a snapshot back to a PM doc, the way a session's view binds to it. */
function docFromSnapshot(snapshot: Uint8Array) {
  const loro = new LoroDoc();
  loro.import(snapshot);
  return loro.toJSON();
}

describe('seed cache', () => {
  beforeEach(async () => {
    await clearSeedCache();
  });

  it('stores a snapshot for a large document and reuses it on the second host', async () => {
    const doc = bigDoc(300);
    expect(doc.nodeSize).toBeGreaterThan(40_000);

    const first = await seedSnapshot(doc);
    // saveSeedCache is fire-and-forget; give the write a turn to land.
    await new Promise((r) => setTimeout(r, 50));

    const second = await seedSnapshot(doc);
    expect(Array.from(second)).toEqual(Array.from(first));

    // And it really came from storage, not a re-seed.
    const keys = await loadSeedCacheForDoc(doc);
    expect(keys).not.toBeNull();
  });

  it('does NOT reuse a cached seed after the document changes', async () => {
    const original = bigDoc(300, 'baseline');
    const cached = await seedSnapshot(original);
    await new Promise((r) => setTimeout(r, 50));

    const edited = bigDoc(300, 'EDITED');
    const fresh = await seedSnapshot(edited);

    expect(Array.from(fresh)).not.toEqual(Array.from(cached));
    // The fresh snapshot must reflect the EDITED content.
    expect(JSON.stringify(docFromSnapshot(fresh))).toContain('EDITED');
    expect(JSON.stringify(docFromSnapshot(cached))).not.toContain('EDITED');
  });

  it('a cached seed reproduces the same document as seeding from scratch', async () => {
    const doc = bigDoc(300);
    const viaCache = await seedSnapshot(doc);
    const viaSeed = seedSnapshotFromDocJSON(doc.toJSON());
    expect(JSON.stringify(docFromSnapshot(viaCache))).toBe(
      JSON.stringify(docFromSnapshot(viaSeed)),
    );
  });

  it('small documents bypass the cache entirely', async () => {
    const small = schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create(null, [schema.text('tiny')]),
        schema.nodes['card_body']!.create(null, [schema.text('body')]),
      ]),
    ]);
    expect(small.nodeSize).toBeLessThan(40_000);
    const snap = await seedSnapshot(small);
    expect(snap.length).toBeGreaterThan(0);
    // Nothing was written for it.
    expect(await loadSeedCacheForDoc(small)).toBeNull();
  });
});

/** Recompute the cache key the way collab-seed does, and read it back. */
async function loadSeedCacheForDoc(doc: { toJSON(): unknown }) {
  const json = JSON.stringify(doc.toJSON());
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const key = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return loadSeedCache(key);
}
