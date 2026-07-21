/**
 * Rooms transport against the in-process mock: REST round-trips,
 * snapshot-aware paging, typed errors, and the SSE stream's hello /
 * update / presence / end handling with reconnect.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RoomsClient, RoomsError, RoomStream, type RoomUpdate } from '../../src/editor/collab/room-client.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RoomsClient', () => {
  it('creates rooms, appends updates, pages them back', async () => {
    const roomId = await client.createRoom();
    const s1 = await client.postUpdate(roomId, bytes('one'));
    const s2 = await client.postUpdate(roomId, bytes('two'));
    expect(s2).toBeGreaterThan(s1);
    const page = await client.fetchUpdates(roomId, 0);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['one', 'two']);
    expect(page.lastSeq).toBe(s2);
    const tail = await client.fetchUpdates(roomId, s1);
    expect(tail.updates.map((u) => text(u.blob))).toEqual(['two']);
  });

  it('creates persistent document rooms that use the normal room update contract', async () => {
    const doc = await client.createPersistentDoc();
    expect(doc.docId).toMatch(/^[0-9a-f]{32}$/);
    expect(doc.roomId).toBe(doc.docId);

    const seq = await client.postUpdate(doc.roomId, bytes('seed'));
    const page = await client.fetchUpdates(doc.roomId, 0);
    expect(page.lastSeq).toBe(seq);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['seed']);
  });

  it('lists, inspects, and archives persistent document rooms', async () => {
    const doc = await client.createPersistentDoc();
    await client.postUpdate(doc.roomId, bytes('managed seed'));

    const info = await client.getPersistentDoc(doc.docId);
    expect(info).toMatchObject({
      docId: doc.docId,
      roomId: doc.roomId,
      archived: false,
      ended: false,
    });
    expect(info.bytesUsed).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(info.createdAt))).toBe(false);

    const listed = await client.listPersistentDocs();
    expect(listed.docs.some((d) => d.docId === doc.docId && !d.archived)).toBe(true);

    await client.deletePersistentDoc(doc.docId);
    const archived = await client.getPersistentDoc(doc.docId);
    expect(archived.archived).toBe(true);
    expect(archived.ended).toBe(true);
    await expect(client.fetchUpdates(doc.roomId, 0)).rejects.toMatchObject({ status: 410 });

    const hidden = await client.listPersistentDocs();
    expect(hidden.docs.some((d) => d.docId === doc.docId)).toBe(false);
    const visible = await client.listPersistentDocs({ includeArchived: true });
    expect(visible.docs.some((d) => d.docId === doc.docId && d.archived)).toBe(true);
  });

  it('serves the snapshot to joiners and truncates the log', async () => {
    const roomId = await client.createRoom();
    const s1 = await client.postUpdate(roomId, bytes('seed'));
    await client.postUpdate(roomId, bytes('after-snap'));
    await client.postSnapshot(roomId, btoa('SNAP'), s1);
    const page = await client.fetchUpdates(roomId, 0);
    expect(text(page.snapshot!.blob)).toBe('SNAP');
    expect(page.snapshot!.coversThroughSeq).toBe(s1);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['after-snap']);
  });

  it('maps 404/410 to typed errors', async () => {
    await expect(client.fetchUpdates('nope', 0)).rejects.toMatchObject({ status: 404 });
    const roomId = await client.createRoom();
    await client.deleteRoom(roomId);
    const err = await client.fetchUpdates(roomId, 0).catch((e: RoomsError) => e);
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).status).toBe(410);
  });

  it('surfaces a clear RoomsError when an interceptor answers HTML instead of JSON', async () => {
    // A school content filter (Securly — field bug 2026-07-10), captive
    // portal, or misconfigured relay URL answers 200 + an HTML page; the
    // client must say so plainly rather than leak the raw JSON.parse error.
    const html = '<!DOCTYPE html><html><body>Blocked by your administrator</body></html>';
    const intercepted = new RoomsClient({
      baseUrl: () => 'https://relay.example',
      token: () => 't',
      fetchImpl: async () =>
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const err = await intercepted.fetchUpdates('room1', 0).catch((e: RoomsError) => e);
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).message).toMatch(/web page instead of session data/);
    // Names the URL it actually hit — the diagnostic we need from the field.
    expect((err as RoomsError).message).toContain('https://relay.example/rooms/room1/updates?after=0');
    expect((err as RoomsError).message).not.toMatch(/Unexpected token/);
  });
});

describe('RoomStream', () => {
  it('delivers hello, live updates, presence, and end', async () => {
    const roomId = await client.createRoom();
    await client.postUpdate(roomId, bytes('pre'));
    const events: string[] = [];
    const updates: RoomUpdate[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 50,
      callbacks: {
        onHello: (lastSeq) => events.push(`hello:${lastSeq}`),
        onUpdate: (u) => updates.push(u),
        onPresence: (b) => events.push(`presence:${text(b)}`),
        onEnded: () => events.push('ended'),
        onFull: () => events.push('full'),
      },
    });
    stream.start();
    await sleep(50);
    expect(events[0]).toMatch(/^hello:\d+$/);
    await client.postUpdate(roomId, bytes('live'));
    await client.postPresence(roomId, bytes('cursor'));
    await sleep(50);
    expect(updates.map((u) => text(u.blob))).toEqual(['live']);
    expect(events).toContain('presence:cursor');
    await client.deleteRoom(roomId);
    await sleep(50);
    expect(events).toContain('ended');
    expect(stream.running).toBe(false);
  });

  it('appends the stable client id as ?cid= so the relay reclaims its slot on reconnect', async () => {
    const urls: string[] = [];
    const stream = new RoomStream({
      baseUrl: () => 'https://relay.example',
      token: () => 't',
      roomId: 'room1',
      clientId: () => 'install-xyz',
      minBackoffMs: 5,
      maxBackoffMs: 10,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
      callbacks: { onHello() {}, onUpdate() {}, onPresence() {}, onEnded() {}, onFull() {} },
    });
    stream.start();
    await sleep(30);
    stream.stop();
    expect(urls[0]).toBe('https://relay.example/rooms/room1/stream?cid=install-xyz');
  });

  it('omits ?cid= when no client id is configured (back-compat)', async () => {
    const urls: string[] = [];
    const stream = new RoomStream({
      baseUrl: () => 'https://relay.example',
      token: () => 't',
      roomId: 'room1',
      minBackoffMs: 5,
      maxBackoffMs: 10,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
      callbacks: { onHello() {}, onUpdate() {}, onPresence() {}, onEnded() {}, onFull() {} },
    });
    stream.start();
    await sleep(30);
    stream.stop();
    expect(urls[0]).toBe('https://relay.example/rooms/room1/stream');
  });

  it('reconnects after a transport outage and re-hellos', async () => {
    const roomId = await client.createRoom();
    const hellos: number[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 60,
      callbacks: {
        onHello: (n) => hellos.push(n),
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
      },
    });
    stream.start();
    await sleep(50);
    expect(hellos.length).toBe(1);
    mock.pause();
    stream.restart(); // drop the live socket; retries now hit 503s
    await sleep(120);
    mock.resume();
    await sleep(200);
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    stream.stop();
  });

  it('uses quick default reconnects so a live shared document does not require reopening', async () => {
    const roomId = await client.createRoom();
    const hellos: number[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      callbacks: {
        onHello: (n) => hellos.push(n),
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
      },
    });
    stream.start();
    try {
      await sleep(80);
      expect(hellos.length).toBe(1);

      mock.pause();
      stream.restart();
      await sleep(60);
      mock.resume();
      await sleep(500);

      expect(hellos.length).toBeGreaterThanOrEqual(2);
    } finally {
      stream.stop();
      mock.resume();
    }
  });

  it('can keep durable document streams alive across transient missing-room responses', async () => {
    const attemptsBefore = mock.streamAttempts();
    let ended = 0;
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId: 'not-yet-visible-doc-room',
      minBackoffMs: 20,
      maxBackoffMs: 40,
      retryMissingRoom: true,
      callbacks: {
        onHello: () => {},
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => ended++,
        onFull: () => {},
      },
    });

    stream.start();
    await sleep(140);

    expect(ended).toBe(0);
    expect(stream.running).toBe(true);
    expect(mock.streamAttempts()).toBeGreaterThan(attemptsBefore + 1);
    stream.stop();
  });

  it('nudge never aborts an in-flight handshake; restart does', async () => {
    // The send loop calls nudge() on every success — during a slow
    // handshake that must be a no-op, or steady typing aborts every
    // connection before its hello (the field-observed starvation).
    mock.setHelloDelay(150);
    try {
      const roomId = await client.createRoom();
      let hellos = 0;
      const stream = new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        callbacks: {
          onHello: () => hellos++,
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: () => {},
        },
      });
      const before = mock.streamAttempts();
      stream.start();
      await sleep(40); // mid-handshake (hello still 110ms away)
      stream.nudge();
      stream.nudge();
      stream.nudge();
      await sleep(200);
      expect(hellos).toBe(1);
      expect(mock.streamAttempts() - before).toBe(1); // no extra connects
      stream.restart(); // the hard variant DOES abort + reconnect
      await sleep(250);
      expect(hellos).toBe(2);
      expect(mock.streamAttempts() - before).toBe(2);
      stream.stop();
    } finally {
      mock.setHelloDelay(0);
    }
  });

  it('reports room-full as terminal', async () => {
    const roomId = await client.createRoom();
    const holders: RoomStream[] = [];
    const mkStream = (cb: { onFull?: () => void } = {}) =>
      new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        initialFullRetryMs: 0,
        callbacks: {
          onHello: () => {},
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: cb.onFull ?? (() => {}),
        },
      });
    for (let i = 0; i < 10; i++) {
      const s = mkStream();
      s.start();
      holders.push(s);
    }
    await sleep(80);
    expect(mock.streamCount(roomId)).toBe(10);
    let full = false;
    const eleventh = mkStream({ onFull: () => (full = true) });
    eleventh.start();
    await sleep(60);
    expect(full).toBe(true);
    expect(eleventh.running).toBe(false);
    for (const s of holders) s.stop();
  });

  it('read-stall watchdog aborts a silent stream and keeps delivery working', async () => {
    const roomId = await client.createRoom();
    let hellos = 0;
    const updates: RoomUpdate[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 40,
      stallTimeoutMs: 200,
      callbacks: {
        onHello: () => hellos++,
        onUpdate: (u) => updates.push(u),
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
      },
    });
    stream.start();
    // The mock never sends SSE heartbeats, so every connection goes silent
    // immediately — the watchdog must keep cycling it rather than leaving a
    // half-open socket that looks connected forever.
    await sleep(1200);
    expect(hellos).toBeGreaterThanOrEqual(2);
    expect(stream.running).toBe(true);

    // Delivery still works across watchdog reconnects (post lands during a
    // connected window within a few tries).
    let delivered = false;
    for (let i = 0; i < 20 && !delivered; i++) {
      const seq = await client.postUpdate(roomId, bytes(`stall-probe-${i}`));
      await sleep(60);
      delivered = updates.some((u) => u.seq === seq);
    }
    expect(delivered).toBe(true);
    stream.stop();
  });

  it('signals a durable room that stays 404/410 so the owner can re-host', async () => {
    // A retryMissingRoom stream against a room that never comes back must not
    // loop on "reconnecting" silently forever — after the notice window it
    // fires onMissingRoomPersisting once, and keeps retrying (non-terminal).
    let missingNotices = 0;
    let ended = 0;
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId: 'deadbeefdeadbeefdeadbeefdeadbeef', // never created → 404
      minBackoffMs: 20,
      maxBackoffMs: 40,
      retryMissingRoom: true,
      missingRoomNoticeMs: 60,
      callbacks: {
        onHello: () => {},
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => ended++,
        onFull: () => {},
        onMissingRoomPersisting: () => missingNotices++,
      },
    });
    stream.start();
    await sleep(400);
    expect(missingNotices).toBe(1); // fired exactly once
    expect(ended).toBe(0); // retryMissingRoom → never terminal
    expect(stream.running).toBe(true);
    stream.stop();
  });

  it('retries an initially-full room until a stale stream clears', async () => {
    const roomId = await client.createRoom();
    const holders: RoomStream[] = [];
    const mkStream = (cb: { onFull?: () => void; onHello?: () => void } = {}) =>
      new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 30,
        initialFullRetryMs: 500,
        callbacks: {
          onHello: cb.onHello ?? (() => {}),
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: cb.onFull ?? (() => {}),
        },
      });
    for (let i = 0; i < 10; i++) {
      const s = mkStream();
      s.start();
      holders.push(s);
    }
    await sleep(80);
    expect(mock.streamCount(roomId)).toBe(10);

    let full = false;
    let hello = 0;
    const eleventh = mkStream({
      onFull: () => (full = true),
      onHello: () => hello++,
    });
    eleventh.start();
    await sleep(80);
    expect(full).toBe(false);
    expect(hello).toBe(0);

    holders.pop()!.stop();
    await sleep(160);
    expect(full).toBe(false);
    expect(hello).toBe(1);
    expect(eleventh.running).toBe(true);

    eleventh.stop();
    for (const s of holders) s.stop();
  });

  it('keeps retrying an initially-full durable room instead of giving up', async () => {
    const roomId = await client.createRoom();
    const holders: RoomStream[] = [];
    const mkStream = (cb: { onFull?: () => void; onHello?: () => void } = {}) =>
      new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 30,
        initialFullRetryMs: 80,
        retryFullRoom: true,
        callbacks: {
          onHello: cb.onHello ?? (() => {}),
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: cb.onFull ?? (() => {}),
        },
      });
    for (let i = 0; i < 10; i++) {
      const s = mkStream();
      s.start();
      holders.push(s);
    }
    await sleep(80);
    expect(mock.streamCount(roomId)).toBe(10);

    let full = false;
    let hello = 0;
    const eleventh = mkStream({
      onFull: () => (full = true),
      onHello: () => hello++,
    });
    eleventh.start();
    await sleep(180);
    expect(full).toBe(false);
    expect(hello).toBe(0);
    expect(eleventh.running).toBe(true);

    holders.pop()!.stop();
    await sleep(160);
    expect(full).toBe(false);
    expect(hello).toBe(1);

    eleventh.stop();
    for (const s of holders) s.stop();
  });

  it('surfaces stream auth rejection instead of silently reconnecting forever', async () => {
    const roomId = await client.createRoom();
    let authRejected = 0;
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => 'wrong-token',
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 30,
      callbacks: {
        onHello: () => {},
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
        onAuthRejected: () => authRejected++,
      },
    });

    stream.start();
    await sleep(80);

    expect(authRejected).toBe(1);
    expect(stream.running).toBe(true);
    stream.stop();
  });
});
