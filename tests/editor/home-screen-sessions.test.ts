// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeScreenCallbacks } from '../../src/editor/home-screen.js';
import type { PersistedSessionRecord } from '../../src/editor/collab/collab-store.js';

type WinStub = { electronAPI?: unknown };

function callbacks(): HomeScreenCallbacks {
  return {
    newDoc: vi.fn(),
    newSpeechDoc: vi.fn(),
    newFlow: vi.fn(),
    open: vi.fn(),
    openRecent: vi.fn(),
    manageQuickCards: vi.fn(),
    openFilePath: vi.fn(),
  };
}

function record(
  roomId: string,
  docTitle: string,
  durableRoom: boolean,
  updatedAt: number,
): PersistedSessionRecord {
  return {
    roomId,
    shareCode: `share-${roomId}`,
    role: 'host',
    lastSeq: 0,
    sentVersion: new Uint8Array(),
    snapshot: new Uint8Array([1]),
    increments: [],
    persistedVersion: new Uint8Array(),
    durableRoom,
    docTitle,
    updatedAt,
  };
}

async function loadDesktopModules() {
  vi.resetModules();
  (window as unknown as WinStub).electronAPI = {};
  const home = await import('../../src/editor/home-screen.js');
  const store = await import('../../src/editor/collab/collab-store.js');
  return { homeScreen: home.homeScreen, store };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('home screen collaboration sessions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    delete (window as unknown as WinStub).electronAPI;
    document.body.innerHTML = '';
  });

  it('hides durable shared .cmir recovery rooms and keeps temporary invite sessions visible', async () => {
    const { homeScreen, store } = await loadDesktopModules();
    const durable = record('durable-room-home-test', 'Shared brief.cmir', true, 20);
    const temporary = record('temporary-room-home-test', 'Invite session', false, 10);
    await store.saveSessionRecord(durable);
    await store.saveSessionRecord(temporary);

    try {
      homeScreen.mount(document.body, callbacks());
      homeScreen.show();
      await flush();

      expect(document.body.textContent).not.toContain('Shared brief.cmir');
      expect(document.body.textContent).toContain('Invite session');
      expect(document.querySelector('.pmd-home-sessions-section')?.hasAttribute('hidden')).toBe(false);
    } finally {
      homeScreen.hide();
      await store.deleteSessionRecord(durable.roomId);
      await store.deleteSessionRecord(temporary.roomId);
    }
  });
});
