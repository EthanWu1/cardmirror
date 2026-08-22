// @vitest-environment jsdom
/**
 * Adversarial connection-stability scenarios not covered elsewhere.
 *
 * The existing end-to-end suite tests a SINGLE clean outage between TWO
 * peers. Field reports ("co-editing isn't always stable") come from
 * messier conditions, so this file adds:
 *
 *   - a FLAPPING network (many short outages) rather than one long one,
 *     with edits landing during every phase;
 *   - THREE peers, which is the real shape of a debate round (two
 *     partners plus a coach/scout) and the first case where a peer can
 *     miss ops that a third peer already relayed;
 *   - a restart STORM, simulating the wake/online hooks firing
 *     repeatedly on a flaky link;
 *   - a zombie relay (accepts posts, never pushes) with edits from both
 *     sides, which must heal via catch-up rather than the stream.
 *
 * Every scenario asserts the same invariant: all peers converge on
 * identical documents AND no peer has silently lost its own edit.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  CollabSession,
  HEALTHY_POLL_MS,
  POLL_TICK_MS,
} from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { mkView, settle, sleep, simpleDoc, docText, typeAfter } from './_loro-helpers.js';
import type { EditorView } from 'prosemirror-view';

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

interface Peer {
  session: CollabSession;
  view: EditorView;
  name: string;
}

/** Host + `joiners` participants, all started and seeded. */
async function makeRoom(joiners: number, seedText = 'alpha bravo charlie delta echo') {
  const { session: hostSession, shareCode } = await CollabSession.host({
    pmDoc: simpleDoc(seedText),
    client,
    ...FAST,
  });
  const hostView = mkView(hostSession.plugins());
  await settle();
  hostSession.start();

  const peers: Peer[] = [{ session: hostSession, view: hostView, name: 'host' }];
  const decoded = decodeShareCode(shareCode)!;
  for (let i = 0; i < joiners; i++) {
    const session = await CollabSession.join({ ...decoded, client, ...FAST });
    const view = mkView(session.plugins());
    await settle();
    session.start();
    peers.push({ session, view, name: `peer${i + 1}` });
  }
  await sleep(120);
  return peers;
}

async function teardown(peers: Peer[]): Promise<void> {
  for (const p of peers.slice().reverse()) await p.session.stop();
}

/** All peers must hold byte-identical documents. */
function expectConverged(peers: Peer[]): void {
  const ref = peers[0]!;
  for (const p of peers.slice(1)) {
    expect(
      p.view.state.doc.eq(ref.view.state.doc),
      `${p.name} diverged from ${ref.name}\n  ${ref.name}: ${docText(ref.view.state.doc)}\n  ${p.name}: ${docText(p.view.state.doc)}`,
    ).toBe(true);
  }
}

/** Every listed fragment must survive on every peer. */
function expectAllEditsPresent(peers: Peer[], fragments: string[]): void {
  for (const p of peers) {
    const text = docText(p.view.state.doc);
    for (const f of fragments) {
      expect(text, `${p.name} lost edit "${f}" (got: ${text})`).toContain(f);
    }
  }
}

describe('flapping network (many short outages, not one long one)', () => {
  it('converges after repeated pause/resume cycles with edits in every phase', async () => {
    const peers = await makeRoom(1);
    const [host, joiner] = peers as [Peer, Peer];
    const fragments: string[] = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      // --- offline: both sides edit blind ---
      mock.pause();
      host.session.restart();
      joiner.session.restart();
      await sleep(40);

      const offA = ` hostOff${cycle}`;
      const offB = ` joinOff${cycle}`;
      typeAfter(host.view, 'alpha', offA);
      typeAfter(joiner.view, 'echo', offB);
      fragments.push(offA.trim(), offB.trim());
      await sleep(60);

      // --- back online: queues must drain and both sides converge ---
      mock.resume();
      await sleep(400);

      const onA = ` hostOn${cycle}`;
      typeAfter(host.view, 'bravo', onA);
      fragments.push(onA.trim());
      await sleep(200);
    }

    await sleep(1200); // final heal window
    expectConverged(peers);
    expectAllEditsPresent(peers, fragments);
    await teardown(peers);
  }, 60_000);
});

describe('three peers (partner + coach: the real round shape)', () => {
  it('converges concurrent edits across three peers', async () => {
    const peers = await makeRoom(2);
    typeAfter(peers[0]!.view, 'alpha', ' ONE');
    typeAfter(peers[1]!.view, 'charlie', ' TWO');
    typeAfter(peers[2]!.view, 'echo', ' THREE');
    await sleep(700);

    expectConverged(peers);
    expectAllEditsPresent(peers, ['ONE', 'TWO', 'THREE']);
    await teardown(peers);
  }, 60_000);

  it('a peer that was offline while the other two edited catches up on return', async () => {
    const peers = await makeRoom(2);
    const [host, active, absent] = peers as [Peer, Peer, Peer];

    // Only the absent peer loses its socket; the relay stays up so the
    // other two keep exchanging ops normally.
    await absent.session.stop();
    await sleep(40);

    typeAfter(host.view, 'alpha', ' whileGone1');
    typeAfter(active.view, 'echo', ' whileGone2');
    await sleep(400);
    expect(active.view.state.doc.eq(host.view.state.doc)).toBe(true);

    // Returning peer must pick up everything it missed.
    absent.session.start();
    await sleep(800);

    expectConverged(peers);
    expectAllEditsPresent(peers, ['whileGone1', 'whileGone2']);
    await teardown(peers);
  }, 60_000);
});

describe('restart storm (wake/online hooks firing on a flaky link)', () => {
  it('survives rapid repeated restart() without losing edits or wedging', async () => {
    const peers = await makeRoom(1);
    const [host, joiner] = peers as [Peer, Peer];

    typeAfter(host.view, 'alpha', ' beforeStorm');
    // Hammer the wake hook far faster than any handshake can complete.
    for (let i = 0; i < 12; i++) {
      host.session.restart();
      joiner.session.restart();
      await sleep(15);
    }
    typeAfter(joiner.view, 'echo', ' afterStorm');
    await sleep(1500);

    expectConverged(peers);
    expectAllEditsPresent(peers, ['beforeStorm', 'afterStorm']);
    // A wedged session shows up as a permanently non-empty queue.
    expect(host.session.queuedUpdates).toBe(0);
    expect(joiner.session.queuedUpdates).toBe(0);
    await teardown(peers);
  }, 60_000);
});

describe('zombie relay (stores posts, never pushes) with edits both ways', () => {
  it('heals through catch-up when the stream silently delivers nothing', async () => {
    const peers = await makeRoom(1);
    const [host, joiner] = peers as [Peer, Peer];

    // Let the catch-up scheduler settle into its steady-state cadence first,
    // so this measures the real mid-round staleness window rather than
    // catching an eager first tick.
    await sleep(1500);

    mock.mutePush(true);
    typeAfter(host.view, 'alpha', ' mutedHost');
    typeAfter(joiner.view, 'echo', ' mutedJoin');

    // No pushes arrive; only the periodic catch-up can close the gap. The
    // stream still reports CONNECTED, so the heal runs on HEALTHY_POLL_MS
    // gated by the catch-up tick — measure how long convergence actually
    // takes rather than assuming, since that delay IS the user-visible
    // "it desyncs mid-round" window.
    const t0 = Date.now();
    let healedMs = -1;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      if (
        joiner.view.state.doc.eq(host.view.state.doc) &&
        docText(host.view.state.doc).includes('mutedJoin') &&
        docText(joiner.view.state.doc).includes('mutedHost')
      ) {
        healedMs = Date.now() - t0;
        break;
      }
    }
    console.log(`[zombie-relay] time to converge: ${healedMs} ms`);
    expect(healedMs, 'never converged within 30s').toBeGreaterThan(-1);
    // Regression guard on the beat-frequency bug: a 4s tick gating on a 5s
    // threshold stretched this heal to a measured 8.06s. It must stay bounded
    // by HEALTHY_POLL_MS plus one scheduler tick, not a multiple of it.
    expect(
      healedMs,
      `zombie-relay heal regressed to ${healedMs}ms (catch-up tick beating against HEALTHY_POLL_MS again?)`,
    ).toBeLessThan(HEALTHY_POLL_MS + POLL_TICK_MS + 1_000);

    expectConverged(peers);
    expectAllEditsPresent(peers, ['mutedHost', 'mutedJoin']);
    mock.mutePush(false);
    await teardown(peers);
  }, 60_000);
});

describe('receive-only peer on a zombie stream (no echo to watch)', () => {
  it('a peer that is only READING still gets edits when push goes silent', async () => {
    const peers = await makeRoom(1);
    const [writer, reader] = peers as [Peer, Peer];
    await sleep(1500); // let the catch-up cadence settle

    // The reader posts NOTHING, so the self-echo watchdog — which recovers a
    // muted stream by noticing your own updates stop coming back — has no
    // signal to fire on. Only a periodic catch-up can rescue this peer, which
    // is why the catch-up interval, not the watchdog, sets the worst case.
    mock.mutePush(true);
    typeAfter(writer.view, 'alpha', ' silentPush');

    const t0 = Date.now();
    let healedMs = -1;
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      if (docText(reader.view.state.doc).includes('silentPush')) {
        healedMs = Date.now() - t0;
        break;
      }
    }
    console.log(`[receive-only] time to receive: ${healedMs} ms`);
    expect(healedMs, 'reader never received the edit within 40s').toBeGreaterThan(-1);
    expect(healedMs).toBeLessThan(HEALTHY_POLL_MS + POLL_TICK_MS + 1_000);

    mock.mutePush(false);
    await teardown(peers);
  }, 60_000);
});

describe('unload frees the relay stream slot (the ghost-slot 409)', () => {
  it('releaseForUnload drops the stream synchronously, unlike stop()', async () => {
    // stop() awaits a flush and drain first, and an unload handler never gets
    // to run its continuation — so every quit or crash leaked a stream the
    // relay kept counting against the room's participant cap, until the room
    // answered 409 "full" to its own OWNER and the file stuck on
    // "reconnecting" forever.
    const peers = await makeRoom(1);
    const [host, joiner] = peers as [Peer, Peer];
    const roomId = host.session.roomId;

    await sleep(200);
    const before = mock.streamCount(roomId);
    expect(before, 'both peers should hold a stream').toBeGreaterThanOrEqual(2);

    // Synchronous: no await between the call and the assertion.
    joiner.session.releaseForUnload();
    await sleep(150); // socket close crosses the process boundary
    expect(
      mock.streamCount(roomId),
      'the leaving peer must give its slot straight back',
    ).toBeLessThan(before);

    await host.session.stop();
  }, 60_000);
});
