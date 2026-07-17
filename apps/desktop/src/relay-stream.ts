/**
 * RelayStream — SSE subscriber for the card-sharing relay's push
 * channel (`GET /relay/stream?recipient=`), with reconnection.
 *
 * Transport only: parses `text/event-stream` frames off a streamed
 * fetch (undici — zero dependencies) and hands the payloads to the
 * caller. The pairing bridge owns what the messages mean.
 *
 * Contract with the server (see the relay's stream_messages):
 *   - `event: hello` arrives once per connection before any data —
 *     the caller uses it as "connected" and runs its catch-up poll,
 *     which also covers anything missed while disconnected.
 *   - each card is one `data:` frame carrying the same JSON shape as
 *     `GET /messages` returns per message.
 *   - `: hb` comment frames keep intermediaries from reaping the
 *     idle connection; they never reach the caller.
 *
 * Reconnects forever with exponential backoff + jitter, resetting on
 * a successful hello. Two statuses stop or slow that loop:
 *   - HTTP 404 → the server predates the stream endpoint. Reports
 *     `unsupported` and STOPS — the caller falls back to interval
 *     polling for the rest of the session.
 *   - HTTP 401 → reports `unauthorized` and keeps retrying at the
 *     max backoff. (Today that's a token mismatch; when subscription
 *     gating lands this is the "connect your blog account" signal.)
 */

export interface RelayStreamCallbacks {
  /** Connection established (hello frame received). */
  onConnected: () => void;
  /** One parsed `data:` frame. */
  onMessage: (data: unknown) => void;
  /** Server has no /stream endpoint; the stream has stopped itself. */
  onUnsupported: () => void;
  /** Bearer rejected; the stream keeps retrying slowly. */
  onUnauthorized: () => void;
}

export interface RelayStreamOptions {
  /** Full stream URL, re-read on every (re)connect. */
  url: () => string;
  /** Auth (and any other) headers, re-read on every (re)connect — the
   *  single supplier the future entitlement flow swaps out. */
  headers: () => Record<string, string>;
  callbacks: RelayStreamCallbacks;
  /** Backoff bounds, injectable for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  label?: string;
}

export class RelayStream {
  private readonly opts: RelayStreamOptions;
  private controller: AbortController | null = null;
  private stopped = true;
  private backoffMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelayStreamOptions) {
    this.opts = opts;
    this.backoffMs = opts.minBackoffMs ?? 1000;
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffMs = this.opts.minBackoffMs ?? 1000;
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

  /** Abort the current connection and reconnect promptly — used on
   *  wake-from-sleep, when the socket may be silently dead. */
  restart(): void {
    if (this.stopped) return;
    this.backoffMs = this.opts.minBackoffMs ?? 1000;
    this.controller?.abort();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const max = this.opts.maxBackoffMs ?? 60_000;
    // ±30% jitter so a fleet doesn't reconnect in lockstep after a
    // server deploy.
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = Math.min(this.backoffMs, max) * jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, max);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectLoop();
    }, delay);
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;
    const label = this.opts.label ?? 'relay-stream';
    this.controller = new AbortController();
    try {
      const res = await fetch(this.opts.url(), {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...this.opts.headers() },
        signal: this.controller.signal,
      });
      if (res.status === 404) {
        // Legacy server — permanent for this session; the caller
        // switches to interval polling.
        this.stopped = true;
        this.opts.callbacks.onUnsupported();
        return;
      }
      if (res.status === 401) {
        this.opts.callbacks.onUnauthorized();
        this.backoffMs = this.opts.maxBackoffMs ?? 60_000;
        this.scheduleRetry();
        return;
      }
      if (!res.ok || !res.body) {
        console.warn(`[${label}] stream returned ${res.status}`);
        this.scheduleRetry();
        return;
      }

      // Frame parser: an SSE event is lines until a blank line; we
      // care about `event:` (hello) and `data:` (payload) and drop
      // `:` comments (heartbeats).
      let buf = '';
      let eventName = '';
      let dataLines: string[] = [];
      const dispatch = () => {
        if (eventName === 'hello') {
          this.backoffMs = this.opts.minBackoffMs ?? 1000;
          this.opts.callbacks.onConnected();
        } else if (dataLines.length > 0) {
          try {
            this.opts.callbacks.onMessage(JSON.parse(dataLines.join('\n')));
          } catch {
            console.warn(`[${label}] undecodable stream frame; ignoring`);
          }
        }
        eventName = '';
        dataLines = [];
      };

      const decoder = new TextDecoder();
      // Node's undici ReadableStream is async-iterable at runtime; the
      // DOM lib typings just don't know it.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') dispatch();
          else if (line.startsWith(':')) continue; // heartbeat/comment
          else if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
      }
      // Server closed the stream (deploy, idle reap) — reconnect.
      this.scheduleRetry();
    } catch (err) {
      if (this.stopped) return;
      if ((err as Error).name !== 'AbortError') {
        console.warn(`[${label}] stream error:`, (err as Error).message ?? err);
      }
      this.scheduleRetry();
    }
  }
}
