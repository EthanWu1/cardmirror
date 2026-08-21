/**
 * Constructor for the co-editing seed worker via Vite's `?worker` import.
 *
 * Isolated for the same reason as `evidence-index-worker-loader.ts`: the
 * `?worker` specifier needs a type shim and a Vite-aware transform, and this
 * import form (plus `worker.format: 'iife'` in vite.config) is what makes the
 * PACKAGED Electron renderer work. Under `file://` Chromium refuses to start
 * MODULE workers, and `new URL(..., import.meta.url)` with `--base=./` emitted
 * a root-absolute asset URL pointing at a nonexistent path — the failure that
 * silently killed the evidence-index worker in the field. Keep both workers on
 * the same pattern so they cannot drift apart.
 */
import CollabSeedWorker from './collab-seed-worker.ts?worker';

export function createCollabSeedWorker(): Worker {
  return new CollabSeedWorker();
}
