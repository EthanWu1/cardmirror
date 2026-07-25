/**
 * Rooms transport: REST client + SSE stream for the relay's
 * collaboration-session endpoints (`/relay/rooms/*`).
 *
 * Transport only — blobs in and out of this module are opaque bytes
 * (the session layer encrypts/decrypts). Runs in the renderer on both
 * web and desktop: plain `fetch` with a streamed reader (no undici, no
 * EventSource — EventSource cannot send an Authorization header).
 *
 * `RoomStream` is the rooms sibling of the desktop mailbox subscriber
 * (`apps/desktop/src/relay-stream.ts`): same frame grammar, same
 * backoff-with-jitter reconnect discipline, same restart() hook for
 * wake-from-sleep. Differences: the hello frame carries `{lastSeq}`
 * (the caller's catch-up cursor), data frames are typed
 * (`u` update / `p` presence / `end` session-over), and HTTP 410 means
 * the session ended (stop, permanently) while 409 means the room is
 * full. Established streams retry 409 because a reconnect can race the
 * relay clearing this client's previous stream; first joins retry
 * briefly so stale sockets from closed/crashed windows can clear.
 */

import { base64ToBytes } from './collab-crypto.js';

export type RoomsFetch = typeof fetch;

/** Browser `window.fetch` throws "Illegal invocation" when called
 *  unbound (assigned to a variable and invoked with `this` ≠ window);
 *  Node's fetch does not care. Wrapping keeps both happy. */
const boundFetch: RoomsFetch = (input, init) => fetch(input, init);

/** Typed transport failure; `status` is 0 for network-level errors. */
export class RoomsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RoomsError';
  }
}

export interface RoomUpdate {
  seq: number;
  blob: Uint8Array;
}

interface AbortControllerLike {
  signal: AbortSignal;
  abort(): void;
}

const NODE_UTIL_MODULE = 'node:util';

function needsNodeFetchAbortController(): boolean {
  return (
    typeof process !== 'undefined' &&
    !!process.versions?.node &&
    typeof navigator !== 'undefined' &&
    /\bjsdom\//i.test(navigator.userAgent ?? '')
  );
}

async function makeFetchAbortController(): Promise<AbortControllerLike> {
  if (needsNodeFetchAbortController()) {
    try {
      const util = (await import(/* @vite-ignore */ NODE_UTIL_MODULE)) as typeof import('node:util');
      if (typeof util.transferableAbortController === 'function') {
        return util.transferableAbortController();
      }
    } catch {
      /* Browser bundles never enter this path; fall back if a test runtime lacks node:util. */
    }
  }
  return new AbortController();
}

export interface FetchUpdatesResult {
  snapshot: { blob: Uint8Array; coversThroughSeq: number } | null;
  updates: RoomUpdate[];
  lastSeq: number;
  more: boolean;
}

export interface PersistentDocRoom {
  docId: string;
  roomId: string;
}

export interface PersistentDocInfo {
  docId: string;
  roomId: string;
  createdAt: string;
  archived: boolean;
  ended: boolean;
  bytesUsed: number;
  lastActivity: string | null;
}

export interface PersistentDocList {
  docs: PersistentDocInfo[];
}

export interface RoomsClientOptions {
  /** Relay base URL including the `/relay` prefix, re-read per request. */
  baseUrl: () => string;
  /** Bearer token, re-read per request (entitlement swap seam). */
  token: () => string;
  fetchImpl?: RoomsFetch;
}

export class RoomsClient {
  /** Public: RoomStream construction reuses the same suppliers. */
  constructor(readonly opts: RoomsClientOptions) {}

  private get fetchImpl(): RoomsFetch {
    return this.opts.fetchImpl ?? boundFetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token()}`, ...extra };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl()}${path}`, init);
    } catch (err) {
      throw new RoomsError(0, (err as Error).message ?? 'network error');
    }
    if (!res.ok) {
      throw new RoomsError(res.status, `rooms request failed: ${res.status}`);
    }
    return res;
  }

  /** Parse a JSON body, but fail LOUDLY and clearly when the relay hands back
   *  something that isn't JSON. A captive portal, filtering proxy, antivirus
   *  web-shield, or a misconfigured relay URL that resolves to a web app all
   *  answer with a 200 HTML page; without this the caller would surface the
   *  cryptic `Unexpected token '<', "<!DOCTYPE"... is not valid JSON`. We read
   *  the body as text FIRST (a Response body reads once), then parse, so the
   *  error message can quote the URL and the page. */
  private async readJson<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      const url = `${this.opts.baseUrl()}${path}`;
      const trimmed = text.trimStart();
      const looksHtml = /^<(?:!doctype|html|\?xml)/i.test(trimmed);
      const ctype = res.headers.get('content-type') ?? 'unknown type';
      throw new RoomsError(
        res.status,
        looksHtml
          ? `the relay returned a web page instead of session data ` +
              `(HTTP ${res.status}, ${ctype}) from ${url} — a proxy, content ` +
              `filter, or wrong relay URL is likely intercepting the connection.`
          : `the relay returned an unreadable (non-JSON) response ` +
              `(HTTP ${res.status}, ${ctype}) from ${url}.`,
      );
    }
  }

  async createRoom(): Promise<string> {
    const res = await this.request('/rooms', { method: 'POST', headers: this.headers() });
    const body = await this.readJson<{ roomId?: string }>(res, '/rooms');
    if (!body.roomId) throw new RoomsError(0, 'malformed createRoom response');
    return body.roomId;
  }

  async createPersistentDoc(): Promise<PersistentDocRoom> {
    const res = await this.request('/docs', { method: 'POST', headers: this.headers() });
    const body = await this.readJson<{ docId?: string; roomId?: string }>(res, '/docs');
    if (!body.docId || !body.roomId) {
      throw new RoomsError(0, 'malformed createPersistentDoc response');
    }
    return { docId: body.docId, roomId: body.roomId };
  }

  private parsePersistentDocInfo(body: Partial<PersistentDocInfo>): PersistentDocInfo {
    if (
      !body.docId ||
      !body.roomId ||
      !body.createdAt ||
      typeof body.archived !== 'boolean' ||
      typeof body.ended !== 'boolean' ||
      typeof body.bytesUsed !== 'number' ||
      (body.lastActivity !== null && typeof body.lastActivity !== 'string')
    ) {
      throw new RoomsError(0, 'malformed persistent document response');
    }
    return {
      docId: body.docId,
      roomId: body.roomId,
      createdAt: body.createdAt,
      archived: body.archived,
      ended: body.ended,
      bytesUsed: body.bytesUsed,
      lastActivity: body.lastActivity,
    };
  }

  async getPersistentDoc(docId: string): Promise<PersistentDocInfo> {
    const path = `/docs/${encodeURIComponent(docId)}`;
    const res = await this.request(path, { headers: this.headers() });
    return this.parsePersistentDocInfo(await this.readJson<Partial<PersistentDocInfo>>(res, path));
  }

  async listPersistentDocs(opts?: { includeArchived?: boolean }): Promise<PersistentDocList> {
    const path = opts?.includeArchived ? '/docs?includeArchived=1' : '/docs';
    const res = await this.request(path, { headers: this.headers() });
    const body = await this.readJson<{ docs?: Array<Partial<PersistentDocInfo>> }>(res, path);
    if (!Array.isArray(body.docs)) throw new RoomsError(0, 'malformed persistent document list');
    return { docs: body.docs.map((doc) => this.parsePersistentDocInfo(doc)) };
  }

  async deletePersistentDoc(docId: string): Promise<void> {
    await this.request(`/docs/${encodeURIComponent(docId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  async postUpdate(roomId: string, blob: Uint8Array): Promise<number> {
    const path = `/rooms/${roomId}/updates`;
    const res = await this.request(path, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: blob as unknown as BodyInit,
    });
    const body = await this.readJson<{ seq?: number }>(res, path);
    if (typeof body.seq !== 'number') throw new RoomsError(0, 'malformed postUpdate response');
    return body.seq;
  }

  /** One page; loop while `more` (the session layer drives paging so it
   *  can apply between pages on huge backlogs). */
  async fetchUpdates(roomId: string, after: number): Promise<FetchUpdatesResult> {
    const path = `/rooms/${roomId}/updates?after=${after}`;
    const res = await this.request(path, {
      headers: this.headers(),
    });
    const body = await this.readJson<{
      snapshot?: { blob: string; coversThroughSeq: number };
      updates?: Array<{ seq: number; blob: string }>;
      lastSeq?: number;
      more?: boolean;
    }>(res, path);
    return {
      snapshot: body.snapshot
        ? { blob: base64ToBytes(body.snapshot.blob), coversThroughSeq: body.snapshot.coversThroughSeq }
        : null,
      updates: (body.updates ?? []).map((u) => ({ seq: u.seq, blob: base64ToBytes(u.blob) })),
      lastSeq: body.lastSeq ?? after,
      more: body.more === true,
    };
  }

  async postSnapshot(roomId: string, blobB64: string, coversThroughSeq: number): Promise<void> {
    await this.request(`/rooms/${roomId}/snapshot`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ blob: blobB64, coversThroughSeq }),
    });
  }

  async postPresence(roomId: string, blob: Uint8Array): Promise<void> {
    await this.request(`/rooms/${roomId}/presence`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: blob as unknown as BodyInit,
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.request(`/rooms/${roomId}`, { method: 'DELETE', headers: this.headers() });
  }
}

// --- SSE stream ---

export interface RoomStreamCallbacks {
  /** Connected; `lastSeq` is the server's cursor at connect time. The
   *  caller runs its catch-up fetch from its OWN cursor — hello's value
   *  is informational (a quick "am I behind?" check). */
  onHello: (lastSeq: number) => void;
  onUpdate: (update: RoomUpdate) => void;
  onPresence: (blob: Uint8Array) => void;
  /** Session ended (server tombstone or live `end` frame). Terminal. */
  onEnded: () => void;
  /** Room stayed at participant capacity (409) after the retry window. */
  onFull: () => void;
  /** Fired ONCE when a `retryFullRoom` stream has been stuck on 409 for an
   *  extended stretch — the relay is still holding dead connections for the
   *  room. Purely informational; retrying continues. */
  onFullPersisting?: () => void;
  /** Fired ONCE when a `retryMissingRoom` stream has been getting 404/410 for
   *  an extended stretch without ever connecting — the durable room is very
   *  likely gone for good (relay redeploy / wiped storage). Retrying
   *  continues, but the owner can re-probe and re-host from the local file so
   *  the doc doesn't sit on "reconnecting" forever (field bug 2026-07-19). */
  onMissingRoomPersisting?: () => void;
  /** The stream endpoint rejected the bearer (401/403). Retrying continues,
   *  but the UI should not present this as a generic network reconnect. */
  onAuthRejected?: () => void;
  /** A previously-connected stream dropped; reconnection with backoff
   *  is already underway. Lets the session mark itself offline instead
   *  of discovering the outage on the next failed send. */
  onDown?: () => void;
}

export interface RoomStreamOptions {
  baseUrl: () => string;
  token: () => string;
  roomId: string;
  callbacks: RoomStreamCallbacks;
  fetchImpl?: RoomsFetch;
  /** Stable per-install client id, sent as `?cid=` so the relay reclaims THIS
   *  client's slot on reconnect instead of counting a second stream against
   *  the room's participant cap (prevents self-inflicted "room full"). Omitted
   *  in tests / older callers — the relay then falls back to its stream-
   *  lifetime reaper. */
  clientId?: () => string;
  /** Backoff bounds, injectable for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a first join retries HTTP 409 before surfacing "full". */
  initialFullRetryMs?: number;
  /** Durable shared-document rooms should treat 404/410 during reconnect as
   *  retryable transport state, not as proof the local session should die. */
  retryMissingRoom?: boolean;
  /** Durable shared-document rooms can hit the relay's stream cap after sleep
   *  because dead sockets may take time to reap. Keep retrying instead of
   *  downgrading the shared file to a local copy. */
  retryFullRoom?: boolean;
  /** How long a `retryMissingRoom` stream stays on 404/410 before firing
   *  `onMissingRoomPersisting`; injectable for tests. */
  missingRoomNoticeMs?: number;
  /** Abort a "connected" stream that has received no bytes for this long.
   *  A healthy stream always has traffic well inside this window — the relay
   *  emits SSE heartbeat comments and broadcasts this client's own membership
   *  presence (~5s cadence) back to it — so silence this long means a NAT/
   *  proxy/sleep half-open socket that will never close on its own. 0
   *  disables (tests that freeze streams on purpose). */
  stallTimeoutMs?: number;
}

const DEFAULT_STREAM_MIN_BACKOFF_MS = 150;
const DEFAULT_STREAM_MAX_BACKOFF_MS = 8_000;
/** Read-stall timeout. The relay emits an SSE heartbeat every 25 s (plus
 *  presence traffic), so silence beyond ~35 s means a half-open socket rather
 *  than a quiet room — recycle it. Was 90 s, which left a dead-but-"connected"
 *  stream undetected for a minute and a half; combined with the slow catch-up
 *  that produced the mid-round desyncs reported 2026-07-24. Must stay
 *  comfortably ABOVE the relay's heartbeat or healthy streams get churned. */
const DEFAULT_STREAM_STALL_MS = 35_000;
const FULL_RETRY_NOTICE_MS = 45_000;
const MISSING_ROOM_NOTICE_MS = 20_000;

export class RoomStream {
  private controller: AbortControllerLike | null = null;
  private stopped = true;
  private backoffMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private helloed = false;
  private everHelloed = false;
  private initialFullSince = 0;
  private fullRetrySince = 0;
  private fullRetryNotified = false;
  private missingRoomSince = 0;
  private missingRoomNotified = false;
  private authRejectedNotified = false;

  constructor(private readonly opts: RoomStreamOptions) {
    this.backoffMs = opts.minBackoffMs ?? DEFAULT_STREAM_MIN_BACKOFF_MS;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** True while the current connection has received its hello (i.e.
   *  live push delivery is actually flowing). */
  get connected(): boolean {
    return !this.stopped && this.helloed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffMs = this.opts.minBackoffMs ?? DEFAULT_STREAM_MIN_BACKOFF_MS;
    this.initialFullSince = 0;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  /** Abort and reconnect promptly — wake-from-sleep, network change,
   *  where the current socket may be silently dead. NOT for "the relay
   *  is reachable, hurry up": that is `nudge()` — aborting an in-flight
   *  attempt from a send-success loop kills every handshake before its
   *  hello, and the stream never connects while the user types. */
  restart(): void {
    if (this.stopped) return;
    this.backoffMs = this.opts.minBackoffMs ?? DEFAULT_STREAM_MIN_BACKOFF_MS;
    if (this.retryTimer !== null) {
      // Sitting out a backoff wait — wake-from-sleep must not serve the
      // remainder of a pre-sleep delay before reconnecting (audit find,
      // 2026-07-10). Connect now.
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      void this.connectLoop();
      return;
    }
    this.controller?.abort();
  }

  /** Gentle hurry-up: if a backoff wait is pending, connect now; if an
   *  attempt is already in flight (or connected), do nothing. */
  nudge(): void {
    if (this.stopped || this.helloed) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.backoffMs = this.opts.minBackoffMs ?? DEFAULT_STREAM_MIN_BACKOFF_MS;
      void this.connectLoop();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.helloed) {
      this.helloed = false;
      this.opts.callbacks.onDown?.();
    }
    const max = this.opts.maxBackoffMs ?? DEFAULT_STREAM_MAX_BACKOFF_MS;
    // ±30% jitter so a fleet doesn't reconnect in lockstep.
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = Math.min(this.backoffMs, max) * jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, max);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectLoop();
    }, delay);
  }

  private dispatchFrame(eventName: string, dataText: string): void {
    if (eventName === 'hello') {
      this.backoffMs = this.opts.minBackoffMs ?? DEFAULT_STREAM_MIN_BACKOFF_MS;
      this.helloed = true;
      this.everHelloed = true;
      this.initialFullSince = 0;
      this.fullRetrySince = 0;
      this.fullRetryNotified = false;
      this.missingRoomSince = 0;
      this.missingRoomNotified = false;
      this.authRejectedNotified = false;
      let lastSeq = 0;
      try {
        const parsed = JSON.parse(dataText || '{}') as { lastSeq?: number };
        if (typeof parsed.lastSeq === 'number') lastSeq = parsed.lastSeq;
      } catch {
        /* malformed hello data — treat as 0 */
      }
      this.opts.callbacks.onHello(lastSeq);
      return;
    }
    if (!dataText) return;
    try {
      const frame = JSON.parse(dataText) as { t?: string; seq?: number; blob?: string };
      if (frame.t === 'u' && typeof frame.seq === 'number' && typeof frame.blob === 'string') {
        this.opts.callbacks.onUpdate({ seq: frame.seq, blob: base64ToBytes(frame.blob) });
      } else if (frame.t === 'p' && typeof frame.blob === 'string') {
        this.opts.callbacks.onPresence(base64ToBytes(frame.blob));
      } else if (frame.t === 'end') {
        this.stopped = true;
        this.opts.callbacks.onEnded();
      }
    } catch {
      console.warn('[room-stream] undecodable frame; ignoring');
    }
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;
    this.controller = await makeFetchAbortController();
    if (this.stopped) {
      this.controller.abort();
      return;
    }
    const fetchImpl = this.opts.fetchImpl ?? boundFetch;
    try {
      const cid = this.opts.clientId?.();
      const streamUrl =
        `${this.opts.baseUrl()}/rooms/${this.opts.roomId}/stream` +
        (cid ? `?cid=${encodeURIComponent(cid)}` : '');
      const res = await fetchImpl(streamUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.opts.token()}` },
        signal: this.controller.signal,
      });
      if (res.status === 410 || res.status === 404) {
        // Tombstoned (or GC'd all the way to gone): the session is over.
        if (this.opts.retryMissingRoom) {
          // Durable rooms retry a missing room (a transient 404 during
          // reconnect must not tear down the editor). But a PERMANENTLY gone
          // room would then loop on "reconnecting" forever — so after a
          // stretch, tell the owner so it can re-probe and re-host.
          const now = Date.now();
          if (!this.missingRoomSince) this.missingRoomSince = now;
          const noticeMs = this.opts.missingRoomNoticeMs ?? MISSING_ROOM_NOTICE_MS;
          if (!this.missingRoomNotified && now - this.missingRoomSince > noticeMs) {
            this.missingRoomNotified = true;
            this.opts.callbacks.onMissingRoomPersisting?.();
          }
          this.scheduleRetry();
          return;
        }
        this.stopped = true;
        this.opts.callbacks.onEnded();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        if (!this.authRejectedNotified) {
          this.authRejectedNotified = true;
          this.opts.callbacks.onAuthRejected?.();
        }
        this.scheduleRetry();
        return;
      }
      if (res.status === 409) {
        // A first join may be hitting stale streams from crashed/slept
        // clients, so retry for a short window before surfacing "full".
        // On a reconnect, the count may include this client's own
        // not-yet-reaped old stream, so retry without a separate budget.
        if (this.opts.retryFullRoom) {
          const now = Date.now();
          if (!this.fullRetrySince) this.fullRetrySince = now;
          if (!this.fullRetryNotified && now - this.fullRetrySince > FULL_RETRY_NOTICE_MS) {
            this.fullRetryNotified = true;
            this.opts.callbacks.onFullPersisting?.();
          }
          this.scheduleRetry();
          return;
        }
        if (!this.everHelloed) {
          const retryMs = this.opts.initialFullRetryMs ?? 35_000;
          const now = Date.now();
          if (retryMs > 0) {
            if (!this.initialFullSince) this.initialFullSince = now;
            if (now - this.initialFullSince < retryMs) {
              this.scheduleRetry();
              return;
            }
          }
          this.stopped = true;
          this.opts.callbacks.onFull();
          return;
        }
        this.scheduleRetry();
        return;
      }
      if (!res.ok || !res.body) {
        this.scheduleRetry();
        return;
      }

      // SSE grammar: lines to a blank line make one event; `:` comments
      // (heartbeats) are dropped. getReader() rather than for-await —
      // browser ReadableStream is not async-iterable everywhere.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // Read-stall watchdog: a half-open socket (sleep, NAT reap, network
      // switch) neither delivers bytes nor closes, so `reader.read()` would
      // block forever while the stream still reports connected. Abort it
      // when the byte flow stops; the normal retry path reconnects.
      let lastReadAt = Date.now();
      const stallMs = this.opts.stallTimeoutMs ?? DEFAULT_STREAM_STALL_MS;
      let stallTimer: ReturnType<typeof setInterval> | null = null;
      if (stallMs > 0) {
        const streamController = this.controller;
        stallTimer = setInterval(
          () => {
            if (Date.now() - lastReadAt > stallMs) streamController.abort();
          },
          Math.max(250, Math.min(stallMs / 3, 15_000)),
        );
      }
      try {
        let buf = '';
        let eventName = '';
        let dataLines: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          lastReadAt = Date.now();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (line === '') {
              this.dispatchFrame(eventName, dataLines.join('\n'));
              eventName = '';
              dataLines = [];
              if (this.stopped) return;
            } else if (line.startsWith(':')) {
              continue;
            } else if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
      } finally {
        if (stallTimer !== null) clearInterval(stallTimer);
      }
      // Server closed (deploy, idle reap) — reconnect.
      this.scheduleRetry();
    } catch (err) {
      if (this.stopped) return;
      if ((err as Error).name !== 'AbortError') {
        console.warn('[room-stream] stream error:', (err as Error).message ?? err);
      }
      this.scheduleRetry();
    }
  }
}
