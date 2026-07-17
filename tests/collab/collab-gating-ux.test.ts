// @vitest-environment jsdom
/**
 * Session-start gating UX (§5.4): a relay 401 on room creation is the
 * "you're not authorized to initiate" signal and must produce an
 * actionable subscription/connect message, not a raw "rooms request
 * failed: 401". Join/resume 401s get the credentials message. Non-401
 * failures keep their reason.
 */
import { describe, it, expect } from 'vitest';
import { relayFailureMessage } from '../../src/editor/collab/collab-ui.js';
import { RoomsError } from '../../src/editor/collab/room-client.js';

describe('relay failure messaging (gating 401 UX)', () => {
  it('a 401 on INITIATING points at the configured relay token', () => {
    const msg = relayFailureMessage(new RoomsError(401, 'rooms request failed: 401'), {
      initiating: true,
      verb: 'start the session',
    });
    expect(msg).toMatch(/relay rejected your token/i);
    expect(msg).not.toMatch(/subscription|membership/i);
    expect(msg).toMatch(/relay URL and token must match on both computers/i);
    expect(msg).not.toMatch(/401/); // not the raw error
  });

  it('a 401 on join/resume gives the credentials message', () => {
    const msg = relayFailureMessage(new RoomsError(401, 'x'), { initiating: false, verb: 'join' });
    expect(msg).toMatch(/rejected your token/i);
    expect(msg).toMatch(/relay URL and token must match on both computers/i);
    expect(msg).not.toMatch(/401/);
  });

  it('a non-401 failure keeps its raw reason', () => {
    const net = relayFailureMessage(new RoomsError(0, 'network error'), { initiating: true, verb: 'start the session' });
    expect(net).toBe('Could not start the session: network error');
    const cap = relayFailureMessage(new RoomsError(409, 'room is full'), { initiating: false, verb: 'join' });
    expect(cap).toBe('Could not join: room is full');
  });

  it('a 405 uses a plain co-editing failure message without relay URL instructions', () => {
    const msg = relayFailureMessage(new RoomsError(405, 'method not allowed'), {
      initiating: true,
      verb: 'start the session',
    });
    expect(msg).toBe('Co-editing failed. Install the latest build on both computers, then try again.');
    expect(msg).not.toMatch(/relay|\/relay|Custom relay URL|server/i);
  });
});
