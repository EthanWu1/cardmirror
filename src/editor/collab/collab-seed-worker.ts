/**
 * Worker entry point for co-editing seed generation.
 *
 * Glue only — the seeding logic (and the rationale for offloading it) lives
 * in `collab-seed-core.ts`, which stays importable from non-worker contexts.
 * This module is loaded exclusively as a worker, so touching `self` here is
 * safe in a way it would not be in the shared module.
 */

import {
  seedSnapshotFromDocJSON,
  type CollabSeedRequest,
  type CollabSeedSuccess,
  type CollabSeedFailure,
} from './collab-seed-core.js';

self.addEventListener('message', (event: MessageEvent<CollabSeedRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'collab-seed') return;
  try {
    const snapshot = seedSnapshotFromDocJSON(request.docJSON);
    const response: CollabSeedSuccess = {
      type: 'collab-seed-done',
      jobId: request.jobId,
      snapshot,
    };
    // Transfer rather than copy: a big master file's snapshot runs to
    // several MB and this is the one hop where copying it is avoidable.
    // `self` is typed as a Window here (tsconfig ships the DOM lib, not
    // webworker), so reach the worker-shaped postMessage through a cast.
    const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;
    post(response, [snapshot.buffer as ArrayBuffer]);
  } catch (err) {
    const response: CollabSeedFailure = {
      type: 'collab-seed-error',
      jobId: request.jobId,
      message: err instanceof Error ? err.message : 'Could not seed the co-editing document.',
    };
    self.postMessage(response);
  }
});
