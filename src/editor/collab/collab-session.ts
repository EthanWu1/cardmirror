/**
 * CollabSession — one collaboration session: a LoroDoc, the encrypted
 * room transport, and the sync discipline between them.
 *
 * Data flow:
 *   outbound  editor → LoroSyncPlugin → LoroDoc → (flush timer)
 *             export update-since-lastSent → encrypt → POST /updates
 *   inbound   SSE update frame (or catch-up GET) → decrypt →
 *             importBatch → Loro events → LoroSyncPlugin → editor
 *
 * Version bookkeeping invariant: everything covered by `lastSentVersion`
 * has either been queued for send or arrived from remote. `applyRemote`
 * therefore SYNCHRONOUSLY exports any un-flushed local diff before
 * importing (export is cheap and synchronous; only the POST is async) —
 * otherwise the next flush would re-export freshly imported remote ops
 * and echo them back to the room (harmless — updates are idempotent —
 * but wasteful at travel-day scale).
 *
 * Delivery discipline (mirrors card sharing): the stream is push-first;
 * every (re)connect hello triggers a catch-up fetch from our own cursor,
 * and a low-frequency catch-up timer heals stream frames the server shed
 * under backpressure. A shed frame is at worst a temporarily missing
 * causal dependency — Loro queues ops whose deps are absent and applies
 * them when the catch-up supplies the rest.
 *
 * The seed state travels as the room's FIRST regular update (a Loro
 * snapshot blob is just importable data), so joining is uniformly
 * "fetch everything after 0". The snapshot ENDPOINT is only compaction:
 * the host periodically uploads an encrypted snapshot so the server can
 * truncate the log and joins stay fast on long sessions.
 */

import { LoroDoc, VersionVector, decodeImportBlobMeta } from 'loro-crdt';
import type { Node as PMNode } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import { EditorState } from 'prosemirror-state';
import { LoroSyncPlugin, updateLoroToPmState } from 'loro-prosemirror';
import { schema } from '../../schema/index.js';
import {
  bytesToBase64,
  decryptBlob,
  encryptBlob,
  encodeShareCode,
  generateRoomKeyBytes,
  importRoomKey,
} from './collab-crypto.js';
import { RoomsClient, RoomsError, RoomStream, type RoomUpdate } from './room-client.js';
import { collabClientId } from './collab-client-id.js';

export const DEFAULT_COLLAB_FLUSH_MS = 120;

/** How often to poll for remote updates while the push stream is DOWN. The
 *  relay still serves REST in that state, so polling keeps the document
 *  syncing (a few seconds behind) instead of waiting for the slow
 *  belt-and-suspenders catch-up. */
export const DEGRADED_POLL_MS = 4_000;

/** How often to catch up while the push stream reports CONNECTED.
 *
 *  A stream can be "connected" and yet silently deliver nothing — a half-open
 *  socket (sleep, Wi-Fi handoff, NAT rebind, a proxy that dropped the upstream)
 *  looks alive to the client until the read-stall watchdog fires. Catch-up used
 *  to run on `catchUpMs` (5 MINUTES) in that state, so a silently-dead stream
 *  meant the doc simply stopped receiving for tens of seconds — the "it desyncs
 *  for ~30 seconds mid-round" report (field 2026-07-24). A catch-up with
 *  nothing new is one cheap GET that returns an empty page, so polling this
 *  often is affordable insurance and caps worst-case staleness at a few
 *  seconds no matter what the stream is doing. */
export const HEALTHY_POLL_MS = 5_000;

type SyncDoc = Parameters<typeof LoroSyncPlugin>[0]['doc'];

/** Mirrors loro-prosemirror's configLoroTextStyle: PM `inclusive` is the
 *  local statement of Peritext expand behavior; the CRDT-level config
 *  makes CONCURRENT boundary insertions honor the same intent. Must be
 *  set before any ops are created on the doc. */
function configTextStyle(doc: LoroDoc): void {
  doc.configTextStyle(
    Object.fromEntries(
      Object.entries(schema.marks).map(([name, type]) => [
        name,
        { expand: type.spec.inclusive !== false ? ('after' as const) : ('none' as const) },
      ]),
    ),
  );
}

export interface CollabSessionCallbacks {
  /** Connection or queue state changed (drives the sync-status UI). */
  onStatus?: (status: {
    connected: boolean;
    queuedUpdates: number;
    /** The relay answers our REST calls even when the live push stream is
     *  unavailable (e.g. the room's stream slots are exhausted). Sync still
     *  works in that state via polling, so the UI must not call it
     *  "offline" — the doc really is syncing (field bug 2026-07-20). */
     relayReachable?: boolean;
  }) => void;
  /** The relay rejected our credentials (401/403) MID-SESSION — fired once
   *  per session so the UI can say so (otherwise the retry loop is
   *  indistinguishable from being offline). Retrying continues at the
   *  backoff ceiling in case the entitlement returns. */
  onAuthRejected?: () => void;
  /** The session ended (host ended it, or the room was GC'd). Terminal. */
  onEnded?: () => void;
  /** The room is at participant capacity. Terminal for this attempt. */
  onFull?: () => void;
  /** A durable room has been answering "full" for an extended stretch
   *  (stale connections not yet reaped). Informational; retrying continues. */
  onFullPersisting?: () => void;
  /** A durable room has been answering 404/410 for an extended stretch — it
   *  is very likely gone for good. The owner can re-host from the local file
   *  instead of sitting on "reconnecting" forever. */
  onMissingRoomPersisting?: () => void;
  /** Encrypted presence blob from a peer (cursor layer decodes). */
  onPresence?: (blob: Uint8Array) => void;
  /** A catch-up just imported a LARGE offline backlog (`count` update
   *  blobs) — the merge-visibility hook for "you were gone a while". */
  onBacklogMerged?: (count: number) => void;
}

export interface CollabSessionOptions {
  client: RoomsClient;
  roomId: string;
  key: CryptoKey;
  role: 'host' | 'participant';
  callbacks?: CollabSessionCallbacks;
  /** Outbound debounce; keystrokes within a window coalesce into one
   *  wire update. */
  flushMs?: number;
  /** Belt-and-suspenders catch-up cadence while streaming (heals shed
   *  push frames). */
  catchUpMs?: number;
  /** Stream backoff bounds, injectable for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Stream read-stall watchdog deadline (see RoomStreamOptions);
   *  injectable for tests. */
  stallTimeoutMs?: number;
  /** Host compaction cadence: upload an encrypted snapshot every N
   *  posted updates. */
  snapshotEvery?: number;
  /** Self-echo watchdog deadline (see field docs); injectable for tests. */
  echoTimeoutMs?: number;
  /** Delay before the first room-history audit; injectable for tests. */
  auditDelayMs?: number;
  /** Persistent `.cmir` rooms are durable documents. Missing-room responses
   *  during reconnect should keep retrying instead of tearing down the editor. */
  durableRoom?: boolean;
  /** Blobs above this many bytes ship via the snapshot endpoint (8x the
   *  relay's per-update cap) instead of as updates; injectable for
   *  tests. Default sits under the relay's 5MB update cap. */
  updateByteLimit?: number;
}

export interface SharedDocMetadata {
  docId: string;
  roomId: string;
  shareCode: string;
  createdAt: string;
}

export class CollabSession {
  readonly loroDoc: LoroDoc;
  readonly roomId: string;
  readonly role: 'host' | 'participant';
  readonly durableRoom: boolean;

  private readonly client: RoomsClient;
  private readonly key: CryptoKey;
  private readonly callbacks: CollabSessionCallbacks;
  private readonly flushMs: number;
  private readonly catchUpMs: number;
  private readonly snapshotEvery: number;
  private readonly echoTimeoutMs: number;
  private readonly auditDelayMs: number;
  private readonly updateByteLimitBase: number;
  private updateByteLimitOverride: number | null = null;
  private get updateByteLimit(): number {
    return this.updateByteLimitOverride ?? this.updateByteLimitBase;
  }

  private stream: RoomStream | null = null;
  private lastSeq = 0;
  private lastSentVersion: ReturnType<LoroDoc['version']>;
  /** What the relay has CONFIRMED receiving (post succeeded), unlike
   *  lastSentVersion which advances at export-into-queue time. The
   *  persisted record stores THIS — a crash loses the in-memory queue,
   *  and resuming from export-time state would silently drop every
   *  queued-but-unposted update. */
  private ackedVersion: ReturnType<LoroDoc['version']>;
  private outQueue: {
    blob: Uint8Array;
    /** Doc version when this diff was exported (acked on post). */
    version: ReturnType<LoroDoc['version']>;
    /** Version the diff starts FROM — chunked re-exports need it, and
     *  intermediate chunks ack to it so a crash mid-sequence re-sends
     *  the whole span instead of losing the tail. */
    from: ReturnType<LoroDoc['version']>;
  }[] = [];
  private sending = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private auditKickoff: ReturnType<typeof setTimeout> | null = null;
  private sendRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  /** Last REST call to the relay succeeded. Independent of the push stream:
   *  a room whose stream slots are exhausted still accepts posts and serves
   *  catch-up, so the doc keeps syncing — just without live push. */
  private relayReachable = false;
  private lastCatchUpAt = 0;
  private ended = false;
  private postedCount = 0;
  private catchUpRunning = false;
  /** Self-echo watchdog: the server pushes our own posted update back
   *  to our stream, so "posted seq N, stream never showed ≥ N" proves
   *  the stream is attached to a stale relay instance (a deploy's old
   *  process lingers unbound but keeps serving heartbeats to streams it
   *  still holds — posts go to the new instance, pushes fan out where
   *  nobody listens). Hard-restart reconnects to the live instance. */
  private awaitingEcho: { seq: number; at: number } | null = null;
  private maxStreamSeq = 0;
  /** True while imported ops sit in Loro's causal-dependency queue.
   *  COMPACTION MUST NOT RUN in this state: the snapshot would omit the
   *  pending ops while its coversThroughSeq truncates their stored
   *  blobs — destroying them from the room permanently (field bug: the
   *  joiner's edits stopped reaching the host FOREVER, surviving
   *  restarts, because a host compaction ate their causal ancestors).
   *  Cleared only when a full-resync import integrates cleanly. */
  private pendingImports = false;

  private constructor(opts: CollabSessionOptions & { loroDoc: LoroDoc }) {
    this.loroDoc = opts.loroDoc;
    this.roomId = opts.roomId;
    this.role = opts.role;
    this.durableRoom = opts.durableRoom === true;
    this.client = opts.client;
    this.key = opts.key;
    this.callbacks = opts.callbacks ?? {};
    this.flushMs = opts.flushMs ?? DEFAULT_COLLAB_FLUSH_MS;
    this.catchUpMs = opts.catchUpMs ?? 300_000;
    this.snapshotEvery = opts.snapshotEvery ?? 50;
    this.echoTimeoutMs = opts.echoTimeoutMs ?? 8000;
    this.auditDelayMs = opts.auditDelayMs ?? 15_000;
    this.updateByteLimitBase = opts.updateByteLimit ?? 4_500_000;
    this.lastSentVersion = this.loroDoc.version();
    this.ackedVersion = this.lastSentVersion;
    this.streamOpts = {
      minBackoffMs: opts.minBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      stallTimeoutMs: opts.stallTimeoutMs,
    };
  }

  private streamOpts: { minBackoffMs?: number; maxBackoffMs?: number; stallTimeoutMs?: number };

  /** Start a session on the current document. Uploads the seed state as
   *  update #1 and returns the share code alongside the session. */
  static async host(opts: {
    pmDoc: PMNode;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    stallTimeoutMs?: number;
    snapshotEvery?: number;
    updateByteLimit?: number;
  }): Promise<{ session: CollabSession; shareCode: string }> {
    return this.hostWithRoom(opts, () => opts.client.createRoom());
  }

  /** Start a persistent document session. It uses the same room transport as
   *  temporary co-editing, but creates a server-side document room that the
   *  relay keeps out of idle session GC. */
  static async hostPersistent(opts: {
    pmDoc: PMNode;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    stallTimeoutMs?: number;
    snapshotEvery?: number;
    updateByteLimit?: number;
  }): Promise<{ session: CollabSession; shareCode: string; sharedDoc: SharedDocMetadata }> {
    let docId = '';
    const hosted = await this.hostWithRoom({ ...opts, durableRoom: true }, async () => {
      const doc = await opts.client.createPersistentDoc();
      docId = doc.docId;
      return doc.roomId;
    });
    return {
      ...hosted,
      sharedDoc: {
        docId,
        roomId: hosted.session.roomId,
        shareCode: hosted.shareCode,
        createdAt: new Date().toISOString(),
      },
    };
  }

  private static async hostWithRoom(
    opts: {
      pmDoc: PMNode;
      client: RoomsClient;
      callbacks?: CollabSessionCallbacks;
      flushMs?: number;
      catchUpMs?: number;
      minBackoffMs?: number;
      maxBackoffMs?: number;
      stallTimeoutMs?: number;
      snapshotEvery?: number;
      updateByteLimit?: number;
      durableRoom?: boolean;
    },
    createRoom: () => Promise<string>,
  ): Promise<{ session: CollabSession; shareCode: string }> {
    const keyBytes = generateRoomKeyBytes();
    const key = await importRoomKey(keyBytes);
    const roomId = await createRoom();

    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    updateLoroToPmState(loroDoc as SyncDoc, new Map(), EditorState.create({ doc: opts.pmDoc }));
    loroDoc.commit();

    const session = new CollabSession({ ...opts, roomId, key, role: 'host', loroDoc });
    const seed = loroDoc.export({ mode: 'snapshot' });
    let seq: number;
    if (seed.length > session.updateByteLimit) {
      // Large document: the seed exceeds the relay's per-update cap
      // (413 in the field on big master files). Ship it as cap-sized
      // update chunks — ordinary log entries that joins and live peers
      // consume through the normal paths.
      const emptyVersion = new LoroDoc().version();
      const chunks = session.exportChunks(emptyVersion);
      seq = 0;
      for (const chunk of chunks) {
        seq = await opts.client.postUpdate(roomId, await encryptBlob(key, chunk));
      }
    } else {
      seq = await opts.client.postUpdate(roomId, await encryptBlob(key, seed));
    }
    session.lastSeq = seq;
    session.lastSentVersion = loroDoc.version();
    session.ackedVersion = session.lastSentVersion; // seed delivery succeeded
    return { session, shareCode: encodeShareCode(roomId, keyBytes) };
  }

  /** Join an existing session; resolves once the backlog (seed + tail)
   *  is imported, so the caller mounts views against a populated doc. */
  static async join(opts: {
    roomId: string;
    keyBytes: Uint8Array;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    stallTimeoutMs?: number;
    updateByteLimit?: number;
    durableRoom?: boolean;
  }): Promise<CollabSession> {
    const key = await importRoomKey(opts.keyBytes);
    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    const session = new CollabSession({
      ...opts,
      key,
      role: 'participant',
      loroDoc,
    });
    // Strict initial sync: steady-state catchUp() swallows network
    // errors by design (resilience), but a join that can't reach the
    // relay must FAIL — otherwise the caller mounts an empty doc and
    // the invite-prefetch offline fallback never gets a chance.
    await session.catchUp(false, true);
    return session;
  }

  /** Rebuild a session from persisted state (M3): the CRDT snapshot +
   *  increments carry this peer's full history — including edits that
   *  never reached the relay before the app died — so the first flush
   *  after start() sends exactly the unsent diff (sentVersion marks
   *  what the room already has), and catch-up resumes from lastSeq.
   *  No network happens here; start() drives reconnection. */
  static async resume(opts: {
    roomId: string;
    keyBytes: Uint8Array;
    role: 'host' | 'participant';
    snapshot: Uint8Array;
    increments: Uint8Array[];
    lastSeq: number;
    /** What the relay has seen from this peer. Omit when EVERYTHING
     *  imported came from the room (invite-prefetch offline join) —
     *  the post-import version is then exactly the room's view. */
    sentVersion?: Uint8Array;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    stallTimeoutMs?: number;
    snapshotEvery?: number;
    durableRoom?: boolean;
  }): Promise<CollabSession> {
    const key = await importRoomKey(opts.keyBytes);
    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    loroDoc.importBatch([opts.snapshot, ...opts.increments]);
    const session = new CollabSession({ ...opts, key, loroDoc });
    session.lastSeq = opts.lastSeq;
    session.lastSentVersion = opts.sentVersion
      ? VersionVector.decode(opts.sentVersion)
      : loroDoc.version();
    session.ackedVersion = session.lastSentVersion;
    return session;
  }

  /** Cursor + sent-version metadata for the persistence layer — cheap,
   *  called every persist tick. The snapshot export is separate
   *  (exportSnapshot) so steady-state ticks never pay for it. */
  persistMeta(): { lastSeq: number; sentVersion: Uint8Array } {
    return { lastSeq: this.lastSeq, sentVersion: this.ackedVersion.encode() };
  }

  /** Full CRDT export — the persistence layer's compaction base. */
  exportSnapshot(): Uint8Array {
    this.loroDoc.commit();
    return this.loroDoc.export({ mode: 'snapshot' });
  }

  /** Incremental export since `from` (VersionVector.encode() bytes) —
   *  the persistence layer's cheap steady-state write. */
  exportSince(from: Uint8Array): { bytes: Uint8Array; version: Uint8Array } {
    this.loroDoc.commit();
    return {
      bytes: this.loroDoc.export({ mode: 'update', from: VersionVector.decode(from) }),
      version: this.loroDoc.version().encode(),
    };
  }

  /** Current doc version, encoded — persistence uses it to detect
   *  "anything new since the last write?" cheaply. */
  encodedVersion(): Uint8Array {
    this.loroDoc.commit();
    return this.loroDoc.version().encode();
  }

  /** The ProseMirror plugins that bind an EditorView to this session.
   *  Fresh instances per view; the LoroDoc is the shared state. */
  plugins(): Plugin[] {
    return [LoroSyncPlugin({ doc: this.loroDoc as SyncDoc })];
  }

  start(): void {
    if (this.ended || this.stream) return;
    this.stream = new RoomStream({
      baseUrl: this.client.opts.baseUrl,
      token: this.client.opts.token,
      fetchImpl: this.client.opts.fetchImpl,
      clientId: collabClientId,
      roomId: this.roomId,
      minBackoffMs: this.streamOpts.minBackoffMs,
      maxBackoffMs: this.streamOpts.maxBackoffMs,
      retryMissingRoom: this.durableRoom,
      retryFullRoom: this.durableRoom,
      stallTimeoutMs: this.streamOpts.stallTimeoutMs,
      callbacks: {
        onHello: () => {
          this.connected = true;
          this.emitStatus();
          void this.catchUp();
          void this.drainQueue();
        },
        onUpdate: (u) => {
          if (u.seq > this.maxStreamSeq) this.maxStreamSeq = u.seq;
          if (this.awaitingEcho && u.seq >= this.awaitingEcho.seq) this.awaitingEcho = null;
          void this.applyRemote(u);
        },
        onPresence: (blob) => {
          void (async () => {
            try {
              this.callbacks.onPresence?.(await decryptBlob(this.key, blob));
            } catch {
              /* wrong-key or corrupt presence frame — drop */
            }
          })();
        },
        onEnded: () => this.handleEnded(),
        onFull: () => {
          this.callbacks.onFull?.();
        },
        onFullPersisting: () => {
          this.callbacks.onFullPersisting?.();
        },
        onMissingRoomPersisting: () => {
          this.callbacks.onMissingRoomPersisting?.();
        },
        onAuthRejected: () => {
          this.connected = false;
          this.awaitingEcho = null;
          this.notifyAuthRejected();
          this.emitStatus();
        },
        onDown: () => {
          this.connected = false;
          this.awaitingEcho = null;
          this.emitStatus();
        },
      },
    });
    this.stream.start();
    this.flushTimer = setInterval(() => {
      this.flush();
      this.checkEcho();
    }, this.flushMs);
    // Adaptive catch-up. With live push working, the periodic fetch is only a
    // belt-and-suspenders heal (catchUpMs, minutes apart). With the stream
    // DOWN — most importantly when the room's stream slots are exhausted and
    // it answers 409 forever — REST still works, so poll fast and keep the
    // document syncing both ways instead of stalling until the next slow tick
    // (field bug 2026-07-20: a shared file sat unsynced because the only
    // fetch was 5 minutes away).
    const tick = Math.max(250, Math.min(this.catchUpMs, DEGRADED_POLL_MS));
    this.catchUpTimer = setInterval(() => {
      if (this.stream?.connected) {
        // Connected is NOT proof of delivery: a half-open socket reports
        // connected while delivering nothing until the stall watchdog fires.
        // Poll on HEALTHY_POLL_MS anyway (a no-op GET when nothing is new) so
        // a silently-dead stream costs seconds of staleness, not minutes.
        if (Date.now() - this.lastCatchUpAt >= Math.min(this.catchUpMs, HEALTHY_POLL_MS)) {
          void this.catchUp();
        }
        return;
      }
      void this.catchUp();
      void this.drainQueue();
    }, tick);
    this.auditKickoff = setTimeout(() => void this.auditRoomHistory(), this.auditDelayMs);
    this.auditTimer = setInterval(() => void this.auditRoomHistory(), 30 * 60_000);
  }

  /** Leave the session (participant) or just stop syncing: final flush
   *  attempt, then tear down timers and the stream. */
  async stop(): Promise<void> {
    this.flush();
    await this.drainQueue().catch(() => {});
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    if (this.auditKickoff) clearTimeout(this.auditKickoff);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = this.auditTimer = null;
    this.auditKickoff = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
  }

  /** End the session for everyone (host action): tombstones the room. */
  async end(): Promise<void> {
    await this.stop();
    try {
      await this.client.deleteRoom(this.roomId);
    } catch {
      /* already gone */
    }
    this.handleEnded();
  }

  /** Synchronously drop the relay stream and timers for window teardown.
   *
   *  `stop()` awaits a flush/drain first, and an unload handler never gets to
   *  run its continuation — so the SSE connection was left for the OS to reap
   *  and the relay kept counting it against the room's participant cap. After
   *  enough quits (or crashes) the room answered 409 "full" to its own owner
   *  forever, which is what left shared files stuck on "reconnecting" (field
   *  diagnosis 2026-07-20). Persistence has its own pagehide flush, so this
   *  only has to free the socket. */
  releaseForUnload(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    if (this.auditKickoff) clearTimeout(this.auditKickoff);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = this.auditTimer = null;
    this.auditKickoff = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
  }

  /** Wake-from-sleep hook. */
  restart(): void {
    this.stream?.restart();
    void this.catchUp();
    void this.drainQueue();
  }

  /** Cheap liveness check for focus/visibility events. Unlike restart(),
   *  a healthy connected stream is left alone (no abort, no traffic);
   *  only a down stream reconnects — plus a catch-up and queue drain so
   *  edits made while backgrounded flow immediately rather than on the
   *  next timer tick. */
  ensureLive(): void {
    if (!this.stream || this.stream.connected) return;
    this.stream.restart();
    void this.catchUp();
    void this.drainQueue();
  }

  get queuedUpdates(): number {
    return this.outQueue.length;
  }

  /** Introspection for diagnostics and the sync-status UI. */
  debugState(): {
    connected: boolean;
    streamRunning: boolean;
    streamConnected: boolean;
    queued: number;
    lastSeq: number;
    awaitingEchoSeq: number | null;
    pendingImports: boolean;
    ended: boolean;
  } {
    return {
      connected: this.connected,
      streamRunning: this.stream?.running ?? false,
      streamConnected: this.stream?.connected ?? false,
      queued: this.outQueue.length,
      lastSeq: this.lastSeq,
      awaitingEchoSeq: this.awaitingEcho?.seq ?? null,
      pendingImports: this.pendingImports,
      ended: this.ended,
    };
  }

  /** Self-echo watchdog (see field docs on `awaitingEcho`). */
  private checkEcho(): void {
    if (!this.awaitingEcho || !this.stream?.connected) return;
    if (Date.now() - this.awaitingEcho.at > this.echoTimeoutMs) {
      console.warn('[collab] posted update never echoed on the stream — reconnecting (stale relay instance?)');
      this.awaitingEcho = null;
      this.stream.restart();
    }
  }

  // --- outbound ---

  /** Advance the sent frontier over ops IMPORTED from the relay (so we
   *  never echo them back) WITHOUT absorbing our own un-flushed local
   *  ops. Our own peer's sent counter advances ONLY through flush().
   *
   *  ROOT CAUSE of the field one-way desync: the import paths used to
   *  set `lastSentVersion = loroDoc.version()`, which silently marked
   *  our own un-posted ops as "sent" — including plugin-generated
   *  repair/heal ops that land on a microtask AFTER the import, so a
   *  later import absorbed them. flush() then saw "nothing new" and
   *  early-returned; those ops never reached the relay, the queue
   *  emptied, `ackedVersion` claimed them sent, and the chip read
   *  "synced" while other peers could never catch up. Preserving our
   *  own counter here keeps the invariant "our own ops are sent only
   *  once flush() exports them." */
  private markImportedSent(): void {
    const full = this.loroDoc.version().toJSON();
    const own = this.loroDoc.peerIdStr as `${number}`;
    const sentOwn = this.lastSentVersion.toJSON().get(own) ?? 0;
    full.set(own, sentOwn);
    this.lastSentVersion = new VersionVector(full);
  }

  /** Export any local ops since the last flush into the send queue.
   *  Synchronous by design so `applyRemote` can call it pre-import. */
  flush(): void {
    if (this.ended) return;
    this.loroDoc.commit();
    const version = this.loroDoc.version();
    // An empty diff still exports a ~22-byte header blob, so gate on the
    // version vector actually advancing (compare() === 0 means equal).
    if (version.compare(this.lastSentVersion) === 0) return;
    const diff = this.loroDoc.export({ mode: 'update', from: this.lastSentVersion });
    const from = this.lastSentVersion;
    this.lastSentVersion = version;
    this.outQueue.push({ blob: diff, version, from });
    this.emitStatus();
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || this.ended) return;
    this.sending = true;
    try {
      while (this.outQueue.length > 0) {
        const entry = this.outQueue[0]!;
        try {
          if (entry.blob.length > this.updateByteLimit) {
            // Oversized diff (huge paste, or the audit's full-history
            // repost on a big doc): split it into cap-sized update
            // chunks and keep draining.
            this.chunkQueueHead();
            continue;
          }
          const seq = await this.client.postUpdate(
            this.roomId,
            await encryptBlob(this.key, entry.blob),
          );
          this.outQueue.shift();
          this.ackedVersion =
            this.outQueue.length === 0 ? this.lastSentVersion : entry.version;
          this.postedCount++;
          this.sendRetryMs = 1000;
          this.relayReachable = true; // a successful post proves REST works
          if (this.stream?.connected) this.awaitingEcho = { seq, at: Date.now() };
          // Deliberately NOT advancing lastSeq to our own posted seq:
          // the cursor means "I have imported everything ≤ this", and a
          // peer's concurrent post can hold a LOWER seq we haven't seen
          // — claiming it would skip their updates forever, and new
          // edits depending on them would park in the causal-deps
          // queue. Catch-up re-fetching our own blobs is a no-op.
          this.emitStatus();
          // A successful send proves the relay is reachable; skip any
          // pending backoff wait. (A nudge, never a restart: aborting
          // an in-flight handshake from the send loop starves the
          // stream while the user types — see RoomStream.nudge.)
          // A successful send proves the relay is reachable; skip any
          // pending backoff wait. (A nudge, never a restart: aborting
          // an in-flight handshake from the send loop starves the
          // stream while the user types — see RoomStream.nudge.)
          this.stream?.nudge();
          if (this.role === 'host' && this.postedCount % this.snapshotEvery === 0) {
            void this.uploadSnapshot();
          }
        } catch (err) {
          if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
            // 410 = tombstoned (host ended); 404 = the room itself is gone
            // (relay idle-GC). Both terminal — the stream already treats
            // them identically.
            if (this.durableRoom) {
              this.connected = false;
              this.awaitingEcho = null;
              this.emitStatus();
              this.stream?.restart();
              this.scheduleSendRetry();
              return;
            }
            this.handleEnded();
            return;
          }
          if (err instanceof RoomsError && (err.status === 401 || err.status === 403)) {
            // Credentials/entitlement died MID-SESSION. Retrying can't fix
            // it silently and a hot retry loop looked exactly like being
            // offline (audit find, 2026-07-10): tell the user once and back
            // off to the ceiling in case the entitlement comes back.
            this.sendRetryMs = 30_000;
            this.notifyAuthRejected();
          }
          if (err instanceof RoomsError && err.status === 413 && entry.blob.length > 1024) {
            // Server-side cap disagreement (backstop for the proactive
            // size check above): force a re-chunk by treating the
            // server's cap as authoritative for this entry.
            this.updateByteLimitOverride = Math.floor(entry.blob.length / 2);
            this.chunkQueueHead();
            this.updateByteLimitOverride = null;
            continue;
          }
          this.connected = false;
          // A transport-level failure (status 0) means the relay itself is
          // unreachable; an HTTP error means it answered, so REST still works.
          if (err instanceof RoomsError && err.status === 0) this.relayReachable = false;
          this.emitStatus();
          this.scheduleSendRetry();
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private sendRetryMs = 1000;

  private scheduleSendRetry(): void {
    if (this.sendRetryTimer || this.ended) return;
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = this.sendRetryMs * jitter;
    this.sendRetryMs = Math.min(this.sendRetryMs * 2, 30_000);
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null;
      void this.drainQueue();
    }, delay);
  }

  // --- inbound ---

  private async applyRemote(u: RoomUpdate): Promise<void> {
    if (this.ended || u.seq <= this.lastSeq) return;
    let plain: Uint8Array;
    try {
      plain = await decryptBlob(this.key, u.blob);
    } catch {
      // Wrong key or corrupt ciphertext — drop the frame. The cursor
      // is deliberately untouched (see below).
      return;
    }
    this.flush(); // capture local diff before import (see module doc)
    const status = this.loroDoc.importBatch([plain]);
    if (status.pending && status.pending.size > 0) this.pendingImports = true;
    this.markImportedSent();
    // The cursor does NOT advance from stream frames — ONLY from
    // catch-up pages. A pushed frame proves nothing about the rows
    // below it: pushes are shed under backpressure and dropped by
    // dying connections (field: ERR_NETWORK_CHANGED flaps), and a
    // cursor that jumps past an unfetched row makes every later
    // catch-up ("give me rows after N") skip it FOREVER — a permanent
    // silent gap when the lost content has no later causal reference,
    // and a compaction hazard (coversThroughSeq trusts this cursor).
    // The stream is the fast path; the paginated catch-up is the
    // correctness path.
    this.sendRetryMs = 1000;
    // Ops whose causal dependencies we lack (a shed push frame, or a
    // window the cursor skipped) sit pending until the deps arrive —
    // fetch them now instead of waiting for the periodic catch-up. The
    // missing deps sit BELOW our cursor (this frame advanced it), so
    // the catch-up must be allowed to escalate to a full resync.
    if (status.pending && status.pending.size > 0) {
      void this.catchUp(true);
    }
  }

  /** Fetch and import everything after our cursor (join, reconnect,
   *  and the periodic shed-frame healer). `expectMissingDeps` marks a
   *  call made because an import parked ops on missing causal deps —
   *  those deps live BELOW the cursor, so if the tail fetch yields
   *  nothing the full resync must still run. */
  async catchUp(expectMissingDeps = false, rethrow = false): Promise<void> {
    if (this.ended || this.catchUpRunning) return;
    this.catchUpRunning = true;
    try {
      let pendingLeft = false;
      let importedAny = false;
      let importedCount = 0;
      for (;;) {
        const page = await this.client.fetchUpdates(this.roomId, this.lastSeq);
        const blobs: Uint8Array[] = [];
        if (page.snapshot && page.snapshot.coversThroughSeq > this.lastSeq) {
          try {
            blobs.push(await decryptBlob(this.key, page.snapshot.blob));
          } catch {
            // Undecryptable server snapshot (wrong key / corrupt ciphertext):
            // skip it like a bad update frame instead of throwing — the throw
            // wedged EVERY subsequent catch-up permanently (audit find,
            // 2026-07-10). The session degrades to whatever updates decrypt.
            console.warn('[collab] undecryptable room snapshot — skipped');
          }
        }
        for (const u of page.updates) {
          if (u.seq <= this.lastSeq) continue;
          try {
            blobs.push(await decryptBlob(this.key, u.blob));
          } catch {
            /* skip undecryptable frame (see applyRemote) */
          }
        }
        if (blobs.length > 0) {
          importedAny = true;
          importedCount += blobs.length;
          this.flush();
          const status = this.loroDoc.importBatch(blobs);
          this.markImportedSent();
          // ACCUMULATE across pages — a clean later page must not cancel
          // the full resync a dirty earlier page requested (audit find,
          // 2026-07-10).
          pendingLeft = pendingLeft || (!!status.pending && status.pending.size > 0);
          if (pendingLeft) this.pendingImports = true;
        }
        if (page.lastSeq > this.lastSeq) this.lastSeq = page.lastSeq;
        if (!page.more) break;
      }
      if (expectMissingDeps && !importedAny) pendingLeft = true;
      if (pendingLeft) {
        // Deps live below our cursor (skipped or compacted) — one full
        // resync from zero, PAGINATED: a long session holds more rows
        // than one page, and a resync that stops at page 1 never
        // reaches the deps it exists to fetch (field: the one-way
        // desync recurred because the healer read 200 rows of a bigger
        // log and parked forever).
        let after = 0;
        const blobs: Uint8Array[] = [];
        for (;;) {
          const page = await this.client.fetchUpdates(this.roomId, after);
          if (page.snapshot && after < page.snapshot.coversThroughSeq) {
            try {
              blobs.push(await decryptBlob(this.key, page.snapshot.blob));
            } catch {
              console.warn('[collab] undecryptable room snapshot in resync — skipped');
            }
          }
          for (const u of page.updates) {
            try {
              blobs.push(await decryptBlob(this.key, u.blob));
            } catch {
              /* skip undecryptable frame */
            }
          }
          after = page.lastSeq;
          if (!page.more) break;
        }
        if (blobs.length > 0) {
          this.flush();
          const status = this.loroDoc.importBatch(blobs);
          this.markImportedSent();
          // A clean full-resync proves every known op integrated.
          this.pendingImports = !!status.pending && status.pending.size > 0;
        }
        if (after > this.lastSeq) this.lastSeq = after;
      }
      if (importedCount >= 25) this.callbacks.onBacklogMerged?.(importedCount);
      // "Connected" is the STREAM's state (live push flowing) — a
      // successful catch-up over plain HTTP must not paint the chip
      // synced while push delivery is still down. It DOES prove the relay
      // is reachable, which the UI reports separately so a stream-less but
      // syncing session isn't mislabelled "offline".
      this.connected = this.stream ? this.stream.connected : true;
      this.relayReachable = true;
      this.lastCatchUpAt = Date.now();
      this.emitStatus();
    } catch (err) {
      if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
        if (this.durableRoom && !rethrow) {
          this.connected = false;
          this.awaitingEcho = null;
          this.emitStatus();
          this.stream?.restart();
          return;
        }
        this.handleEnded();
        // A STRICT initial sync (join/first resume tick) must NOT silently
        // succeed on an ended/expired room — otherwise the caller mounts a
        // blank doc masquerading as a joined session, shows "Joined the
        // session", and leaves a phantom resumable record. Rethrow so join()
        // fails and the UI can say the session has ended. Steady-state
        // catch-ups (rethrow=false) keep swallowing it — handleEnded already
        // drove the onEnded teardown.
        if (rethrow) throw err;
        return;
      }
      if (err instanceof RoomsError && (err.status === 401 || err.status === 403)) {
        this.notifyAuthRejected();
      }
      this.connected = false;
      this.emitStatus();
      if (rethrow) throw err;
    } finally {
      this.catchUpRunning = false;
    }
  }

  // --- history assurance ---

  /** Verify the ROOM still holds every op the relay has acknowledged
   *  from this replica; repost the full history if not. Insurance for
   *  compaction-destroyed ops (see `pendingImports`): a room that lost
   *  a peer's causal ancestors can never integrate that peer's future
   *  edits — a permanent one-way split that LOOKS synced on both ends.
   *  The audit reads only blob METADATA (no full import) and reposting
   *  is idempotent, so a false positive costs one oversized update. */
  async auditRoomHistory(): Promise<void> {
    if (this.ended || this.outQueue.length > 0) return;
    try {
      const roomMax = new Map<string, number>();
      let after = 0;
      for (;;) {
        const page = await this.client.fetchUpdates(this.roomId, after);
        const blobs: Uint8Array[] = [];
        if (page.snapshot && after < page.snapshot.coversThroughSeq) {
          try {
            blobs.push(await decryptBlob(this.key, page.snapshot.blob));
          } catch {
            /* undecryptable snapshot — audit what we can */
          }
        }
        for (const u of page.updates) {
          try {
            blobs.push(await decryptBlob(this.key, u.blob));
          } catch {
            /* skip */
          }
        }
        for (const b of blobs) {
          try {
            const meta = decodeImportBlobMeta(b, false);
            for (const [peer, counter] of meta.partialEndVersionVector.toJSON()) {
              if ((roomMax.get(peer) ?? 0) < counter) roomMax.set(peer, counter);
            }
          } catch {
            /* undecodable blob */
          }
        }
        after = page.lastSeq;
        if (!page.more) break;
      }
      // Compare against the LIVE doc version, not `ackedVersion`.
      // ackedVersion is bookkeeping this very audit exists to backstop —
      // if a send-completeness bug ever advances it past un-posted ops
      // (the field one-way desync, root-caused 2026-07-05), comparing
      // against it would hide exactly the loss we must catch. The live
      // version is ground truth for "ops this replica holds"; the
      // guards below rule out the benign false-positive (fresh unflushed
      // ops): the queue must be empty AND flush must have exported
      // everything (doc version == lastSentVersion), so any residual gap
      // is genuinely lost from the room, not merely in-flight.
      this.flush();
      if (this.outQueue.length > 0) return; // unsent local ops in flight — not a room loss
      if (this.loroDoc.version().compare(this.lastSentVersion) !== 0) return; // flush left work
      let missing = false;
      for (const [peer, counter] of this.loroDoc.version().toJSON()) {
        if ((roomMax.get(peer) ?? 0) < counter) {
          missing = true;
          break;
        }
      }
      if (!missing) return;
      console.warn(
        '[collab] the room lost ops this replica holds (compacted away?) — reposting full history',
      );
      this.loroDoc.commit();
      const emptyVersion = new LoroDoc().version();
      for (const chunk of this.exportChunks(emptyVersion)) {
        const seq = await this.client.postUpdate(this.roomId, await encryptBlob(this.key, chunk));
        if (this.stream?.connected) this.awaitingEcho = { seq, at: Date.now() };
      }
    } catch {
      /* advisory — the next scheduled audit retries */
    }
  }

  // --- presence ---

  async sendPresence(blob: Uint8Array): Promise<void> {
    if (this.ended) return;
    try {
      await this.client.postPresence(this.roomId, await encryptBlob(this.key, blob));
    } catch {
      /* presence is fire-and-forget */
    }
  }

  // --- compaction ---

  private async uploadSnapshot(): Promise<void> {
    // NEVER compact over ops that haven't integrated: coversThroughSeq
    // truncates the stored log, and a snapshot exported while imports
    // pend does NOT contain them — the room loses them permanently.
    if (this.pendingImports) return;
    try {
      this.loroDoc.commit();
      const covers = this.lastSeq;
      const snapshot = this.loroDoc.export({ mode: 'snapshot' });
      const sealed = await encryptBlob(this.key, snapshot);
      await this.client.postSnapshot(this.roomId, bytesToBase64(sealed), covers);
    } catch {
      /* compaction is best-effort; the log just stays longer */
    }
  }

  /** Split the ops between two versions into update blobs that each
   *  fit under the relay's per-update cap (the "chunked client-side"
   *  the wire design promised). Chunks are ORDINARY updates: streams
   *  push them live and importers park early arrivals in the causal-
   *  dependency queue until the set completes — no snapshot detour, no
   *  log truncation, no data-loss surface. */
  private exportChunks(
    from: ReturnType<LoroDoc['version']>,
  ): Uint8Array[] {
    this.loroDoc.commit();
    const to = this.loroDoc.version();
    const spans: { id: { peer: `${number}`; counter: number }; len: number }[] = [];
    for (const [peer, end] of to.toJSON()) {
      const start = from.get(peer) ?? 0;
      if (end > start) spans.push({ id: { peer, counter: start }, len: end - start });
    }
    const out: Uint8Array[] = [];
    const emit = (sp: typeof spans): void => {
      if (sp.length === 0) return;
      const blob = this.loroDoc.export({ mode: 'updates-in-range', spans: sp });
      const totalLen = sp.reduce((n, x) => n + x.len, 0);
      if (blob.length <= this.updateByteLimit || totalLen <= 1) {
        out.push(blob); // single-op blobs ship as-is; the server cap is 8x our limit
        return;
      }
      if (sp.length > 1) {
        const mid = Math.ceil(sp.length / 2);
        emit(sp.slice(0, mid));
        emit(sp.slice(mid));
      } else {
        const span = sp[0]!;
        const half = Math.floor(span.len / 2);
        emit([{ id: span.id, len: half }]);
        emit([{ id: { peer: span.id.peer, counter: span.id.counter + half }, len: span.len - half }]);
      }
    };
    emit(spans);
    return out;
  }

  /** Replace the oversized queue head with its chunked equivalents.
   *  Intermediate chunks ack back to the span's FROM version, so a
   *  crash mid-sequence re-exports the whole span on resume (imports
   *  are idempotent); only the final chunk advances to the head's end
   *  version. */
  private chunkQueueHead(): void {
    const entry = this.outQueue[0]!;
    const chunks = this.exportChunks(entry.from);
    const replacements = chunks.map((blob, i) => ({
      blob,
      version: i === chunks.length - 1 ? entry.version : entry.from,
      from: entry.from,
    }));
    this.outQueue.splice(0, 1, ...replacements);
    this.emitStatus();
  }

  private authNotified = false;

  private notifyAuthRejected(): void {
    if (this.authNotified) return;
    this.authNotified = true;
    this.callbacks.onAuthRejected?.();
  }

  private emitStatus(): void {
    this.callbacks.onStatus?.({
      connected: this.connected,
      queuedUpdates: this.outQueue.length,
      relayReachable: this.relayReachable,
    });
  }

  private handleEnded(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    if (this.auditKickoff) clearTimeout(this.auditKickoff);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = this.auditTimer = null;
    this.auditKickoff = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
    this.callbacks.onEnded?.();
  }
}
