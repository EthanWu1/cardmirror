// @vitest-environment jsdom
/**
 * Co-editing is desktop-only and now ON by default there. On a browser
 * host the gate is categorically closed (the web edition has no
 * server-dependent capabilities); on a desktop host it's open with no
 * flag required — the old build-time `VITE_COLLAB` / runtime
 * `localStorage['pmd-collab']` toggles are gone now that it ships.
 *
 * getHost() caches the resolved host at module scope, so each case
 * resets the module registry and re-imports the gate with the desired
 * `window.electronAPI` presence already in place.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

type WinStub = { electronAPI?: unknown };

async function loadGate(): Promise<() => boolean> {
  vi.resetModules();
  const mod = await import('../../src/editor/collab/collab-gate.js');
  return mod.collabEnabled;
}

afterEach(() => {
  delete (window as unknown as WinStub).electronAPI;
});

describe('collabEnabled — desktop-only, on by default', () => {
  it('browser host → disabled (no server-dependent capability on web)', async () => {
    delete (window as unknown as WinStub).electronAPI; // browser host
    expect((await loadGate())()).toBe(false);
  });

  it('desktop host → enabled by default (no flag needed)', async () => {
    (window as unknown as WinStub).electronAPI = {}; // Electron host
    expect((await loadGate())()).toBe(true);
  });
});
