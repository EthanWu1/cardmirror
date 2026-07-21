/**
 * Constructor for the evidence-index worker via Vite's `?worker` import.
 *
 * Isolated in its own module because the `?worker` specifier needs a type
 * shim and a Vite-aware transform; keeping it here leaves the palette module
 * clean for tests (vitest transforms the specifier but jsdom never
 * constructs — the caller guards on `typeof Worker`).
 *
 * Why not `new Worker(new URL('./evidence-index-worker.ts', import.meta.url),
 * { type: 'module' })`: in the PACKAGED Electron renderer (file://) that form
 * failed twice over — Chromium refuses to start module workers from file://
 * (module scripts require CORS), and Vite emitted a root-absolute asset URL
 * that ignored the `--base=./` relative base, pointing at a nonexistent
 * filesystem path. With `worker.format: 'iife'` in vite.config plus this
 * import form, production gets a classic worker at a correctly-based URL.
 */
import EvidenceIndexWorker from './evidence-index-worker.ts?worker';

export function createEvidenceIndexWorker(): Worker {
  return new EvidenceIndexWorker();
}
