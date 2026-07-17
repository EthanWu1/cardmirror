import { describe, expect, it } from 'vitest';
import {
  SOLO_SESSION_END_MS,
  createSoloSessionWatch,
  observeSoloSessionPresence,
} from '../../src/editor/collab/solo-session.js';

const self = { name: 'Ethan', color: '#2680eb', self: true };
const partner = { name: 'Partner', color: '#28a745', self: false };

describe('solo co-editing session watcher', () => {
  it('does not end a session before a partner has ever joined', () => {
    const watch = createSoloSessionWatch();

    expect(
      observeSoloSessionPresence(watch, [self], { connected: true, queuedUpdates: 0 }, 0),
    ).toBe(false);
    expect(
      observeSoloSessionPresence(
        watch,
        [self],
        { connected: true, queuedUpdates: 0 },
        SOLO_SESSION_END_MS + 1,
      ),
    ).toBe(false);
  });

  it('ends only after a partner was seen, local edits are synced, and self-only lasts', () => {
    const watch = createSoloSessionWatch();

    expect(
      observeSoloSessionPresence(watch, [self, partner], { connected: true, queuedUpdates: 0 }, 0),
    ).toBe(false);
    expect(
      observeSoloSessionPresence(watch, [self], { connected: true, queuedUpdates: 1 }, 1),
    ).toBe(false);
    expect(
      observeSoloSessionPresence(watch, [self], { connected: false, queuedUpdates: 0 }, 2),
    ).toBe(false);
    expect(
      observeSoloSessionPresence(watch, [self], { connected: true, queuedUpdates: 0 }, 10),
    ).toBe(false);
    expect(
      observeSoloSessionPresence(
        watch,
        [self],
        { connected: true, queuedUpdates: 0 },
        10 + SOLO_SESSION_END_MS + 1,
      ),
    ).toBe(true);
  });
});
