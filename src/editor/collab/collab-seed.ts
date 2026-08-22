/**
 * Seed a session's LoroDoc from a ProseMirror document, preferring a worker.
 *
 * See `collab-seed-worker.ts` for why this is worth moving off the main
 * thread. This module owns the policy around it:
 *
 *   - small documents seed inline, because a worker round-trip (spawn +
 *     structured clone of the doc JSON) costs more than the seeding does;
 *   - anything without a usable `Worker` (vitest/jsdom, the Node round-trip
 *     CLI) falls back to the identical synchronous path, so behavior is
 *     never worker-dependent — only the thread it runs on changes;
 *   - a worker that fails for any reason falls back too, rather than
 *     failing the session. Starting co-editing must not become MORE
 *     fragile than it was.
 */

import type { LoroDoc } from 'loro-crdt';
import type { Node as PMNode } from 'prosemirror-model';
import { seedSnapshotFromDocJSON, type CollabSeedResponse } from './collab-seed-core.js';
import { createCollabSeedWorker } from './collab-seed-worker-loader.js';
import { loadSeedCache, saveSeedCache } from './collab-store.js';

/** Documents below this are seeded inline. `nodeSize` tracks the container
 *  count that drives the super-linear cost far better than character count
 *  does; ~40k lands well under 100ms of seeding in the measurements. */
const INLINE_SEED_MAX_NODE_SIZE = 40_000;

/** Hard ceiling on the worker hop. If the worker never answers (blocked
 *  spawn, CSP, a packaging regression) the session still starts — slower,
 *  on the main thread — instead of hanging forever on a promise. */
const SEED_WORKER_TIMEOUT_MS = 120_000;

let jobCounter = 0;

function workerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

/** Content digest of the document, used as the seed-cache key.
 *
 *  PM's `toJSON` is deterministic for a given document, so identical content
 *  yields an identical string. SHA-256 (not a cheap non-crypto hash) because
 *  a collision here would seed the session with the WRONG document — the one
 *  failure mode of caching that silently corrupts a file. Returns null when
 *  WebCrypto is unavailable, which disables caching rather than weakening it. */
async function seedCacheKey(json: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(json));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

/** Produce the seeded snapshot for `doc`, off-thread when that is both
 *  possible and worth it. Never throws for worker- or cache-side reasons. */
export async function seedSnapshot(doc: PMNode): Promise<Uint8Array> {
  const docJSON = doc.toJSON();
  // Size alone decides whether this document is worth caching and hashing;
  // worker availability is a SEPARATE question, decided below. Folding the
  // two together meant a runtime without workers — the main-thread fallback,
  // i.e. the slowest path there is — never got to use the cache at all.
  if (doc.nodeSize <= INLINE_SEED_MAX_NODE_SIZE) {
    return seedSnapshotFromDocJSON(docJSON);
  }

  const json = JSON.stringify(docJSON);
  const key = await seedCacheKey(json);
  if (key) {
    try {
      const hit = await loadSeedCache(key);
      // nodeSize guards against a digest collision handing back a snapshot
      // for a different document.
      if (hit && hit.nodeSize === doc.nodeSize && hit.snapshot?.length) return hit.snapshot;
    } catch {
      /* cache read failed — seed normally */
    }
  }

  let snapshot: Uint8Array;
  if (!workerAvailable()) {
    snapshot = seedSnapshotFromDocJSON(docJSON);
  } else {
    try {
      snapshot = await seedSnapshotInWorker(docJSON);
    } catch (err) {
      console.warn('[collab] seed worker unavailable — seeding on the main thread', err);
      snapshot = seedSnapshotFromDocJSON(docJSON);
    }
  }

  if (key) {
    // Store a COPY: the worker transferred this buffer, and handing the same
    // instance to IndexedDB while the caller imports from it invites aliasing
    // surprises for a few MB of copy on a path that just spent seconds.
    void saveSeedCache({
      key,
      snapshot: snapshot.slice(),
      nodeSize: doc.nodeSize,
      createdAt: Date.now(),
    }).catch(() => {
      /* storage denied or over quota — caching is best-effort */
    });
  }
  return snapshot;
}

function seedSnapshotInWorker(docJSON: unknown): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = createCollabSeedWorker();
    const jobId = ++jobCounter;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('seed worker timed out'))),
      SEED_WORKER_TIMEOUT_MS,
    );

    worker.addEventListener('message', (event: MessageEvent<CollabSeedResponse>) => {
      const msg = event.data;
      if (!msg || msg.jobId !== jobId) return;
      if (msg.type === 'collab-seed-done') finish(() => resolve(msg.snapshot));
      else if (msg.type === 'collab-seed-error') finish(() => reject(new Error(msg.message)));
    });
    worker.addEventListener('error', (event) => {
      finish(() => reject(new Error(event.message || 'seed worker failed')));
    });

    worker.postMessage({ type: 'collab-seed', jobId, docJSON });
  });
}

/** Seed `loroDoc` in place. The doc must already have its text style
 *  configured (the caller does this) and must be empty. */
export async function seedLoroDoc(loroDoc: LoroDoc, doc: PMNode): Promise<void> {
  loroDoc.import(await seedSnapshot(doc));
  loroDoc.commit();
}
