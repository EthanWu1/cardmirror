// @vitest-environment jsdom
/**
 * Persistent shared `.cmir` documents.
 *
 * A durable room differs from a session room in LIFETIME, not transport: it
 * outlives its participants, so the pointer written into the file can rejoin
 * it later. The behaviours that matter:
 *
 *   - hosting one mints a pointer the file can carry;
 *   - a peer can join from that pointer alone and see the content;
 *   - "no such room" during reconnect is treated as transient, not as the
 *     document being over — the opposite of a temporary session.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { mkView, settle, sleep, simpleDoc, docText, typeAfter } from './_loro-helpers.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

const FAST = { flushMs: 25, minBackoffMs: 20, maxBackoffMs: 60, catchUpMs: 60_000 };

describe('persistent shared documents', () => {
  it('mints a pointer that round-trips through the .cmir and rejoins the room', async () => {
    const seed = simpleDoc('durable prep doc');
    const { session: host, shareCode, sharedDoc } = await CollabSession.hostPersistent({
      pmDoc: seed,
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();

    expect(sharedDoc.roomId).toBe(host.roomId);
    expect(sharedDoc.shareCode).toBe(shareCode);
    expect(host.durableRoom).toBe(true);

    // The pointer survives a real save/open cycle.
    const reopened = parseNative(serializeNative(seed, { sharedDoc }));
    expect(reopened.sharedDoc).toEqual(sharedDoc);

    // A peer joining from the file's pointer alone sees the content.
    const decoded = decodeShareCode(reopened.sharedDoc!.shareCode)!;
    const joiner = await CollabSession.join({ ...decoded, client, durableRoom: true, ...FAST });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(150);
    expect(docText(joinView.state.doc)).toContain('durable prep doc');

    typeAfter(hostView, 'durable prep doc', ' edited');
    await sleep(300);
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);

    await joiner.stop();
    await host.stop();
  }, 60_000);

  it('treats a missing room as transient rather than as the document ending', async () => {
    const ended: string[] = [];
    const { session } = await CollabSession.hostPersistent({
      pmDoc: simpleDoc('still here'),
      client,
      ...FAST,
      callbacks: { onEnded: () => ended.push('ended') },
    });
    mkView(session.plugins());
    await settle();
    session.start();
    await sleep(150);

    // The relay forgets the room (restart / replica lag). A TEMPORARY session
    // would tear down here; a durable document must keep trying.
    mock.forgetRoom(session.roomId);
    session.restart();
    await sleep(600);

    expect(ended, 'a durable document must not end on a missing room').toEqual([]);
    expect(session.debugState().ended).toBe(false);
    await session.stop();

    // Contrast: a TEMPORARY session given the same treatment DOES end. Without
    // this the assertion above would pass even if durableRoom did nothing.
    const tempEnded: string[] = [];
    const { session: temp } = await CollabSession.host({
      pmDoc: simpleDoc('temporary'),
      client,
      ...FAST,
      callbacks: { onEnded: () => tempEnded.push('ended') },
    });
    mkView(temp.plugins());
    await settle();
    temp.start();
    await sleep(150);
    mock.forgetRoom(temp.roomId);
    temp.restart();
    await sleep(600);
    expect(tempEnded, 'a temporary session SHOULD end on a missing room').toEqual(['ended']);
    await temp.stop();
  }, 60_000);
});
