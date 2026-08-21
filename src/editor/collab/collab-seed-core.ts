/**
 * Pure seeding logic shared by the seed worker and the main-thread fallback.
 *
 * Deliberately free of worker globals: `collab-seed.ts` imports this for the
 * inline path, and that module is reachable from plain Node (the round-trip
 * CLI, node-environment tests). Keeping the `self.addEventListener`
 * registration in `collab-seed-worker.ts` means importing the seeding logic
 * never requires a worker global to exist.
 *
 * Why seeding is worth moving off the main thread at all:
 * `updateLoroToPmState` is how a HOST turns an already-open document into the
 * session's CRDT, and its cost is super-linear in document size — measured on
 * a synthetic debate file (3 paragraphs per card):
 *
 *     2000 cards  0.4s     4000 cards  1.7s     8000 cards  8.7s
 *
 * while parsing the same `.cmir` stays linear (111ms at 8000 cards) and
 * IMPORTING the resulting snapshot costs ~27ms. The cost is Loro's nested
 * container creation, not anything CardMirror controls: upgrading loro-crdt
 * 1.13.6 -> 1.14.1 moved 8000 cards only 7254ms -> 6963ms. Run inline on the
 * renderer, that stall froze the editor while a big master file started a
 * session — indistinguishable from a crash on a slow tournament laptop.
 */

import { LoroDoc } from 'loro-crdt';
import { EditorState } from 'prosemirror-state';
import { updateLoroToPmState } from 'loro-prosemirror';
import { schema } from '../../schema/index.js';

export interface CollabSeedRequest {
  type: 'collab-seed';
  jobId: number;
  /** PM document as JSON — structured-cloneable, unlike a PM Node. */
  docJSON: unknown;
}

export interface CollabSeedSuccess {
  type: 'collab-seed-done';
  jobId: number;
  snapshot: Uint8Array;
}

export interface CollabSeedFailure {
  type: 'collab-seed-error';
  jobId: number;
  message: string;
}

export type CollabSeedResponse = CollabSeedSuccess | CollabSeedFailure;

/**
 * Build the seeded CRDT snapshot for a PM document.
 *
 * The snapshot's ops carry THIS doc's peer id, which for the worker path is
 * not the renderer's. That is the same shape as `CollabSession.join`/`resume`,
 * which import a room snapshot into a fresh doc — the local peer's own counter
 * simply starts at zero, exactly what `markImportedSent` already assumes.
 */
export function seedSnapshotFromDocJSON(docJSON: unknown): Uint8Array {
  const doc = schema.nodeFromJSON(docJSON as Parameters<typeof schema.nodeFromJSON>[0]);
  const loroDoc = new LoroDoc();
  // Must precede any ops: this is the CRDT-level statement of the schema's
  // inclusive/exclusive mark rules (mirrors configTextStyle in collab-session).
  loroDoc.configTextStyle(
    Object.fromEntries(
      Object.entries(schema.marks).map(([name, type]) => [
        name,
        { expand: type.spec.inclusive !== false ? ('after' as const) : ('none' as const) },
      ]),
    ),
  );
  updateLoroToPmState(
    loroDoc as Parameters<typeof updateLoroToPmState>[0],
    new Map(),
    EditorState.create({ doc }),
  );
  loroDoc.commit();
  return loroDoc.export({ mode: 'snapshot' });
}
