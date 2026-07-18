/**
 * RelayStream — the SSE subscriber behind card sharing's push delivery.
 * Exercised against a real local HTTP server: hello → onConnected, data
 * frames → onMessage, heartbeats ignored, 404 → onUnsupported (and the
 * stream stops), 401 → onUnauthorized (and it keeps retrying), server
 * drop → reconnect.
 */

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RelayStream } from '../../apps/desktop/src/relay-stream.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];
const activeStreams: RelayStream[] = [];

function serve(handler: Handler): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/stream`);
    });
  });
}

function sse(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('event: hello\ndata: {}\n\n');
}

function until(check: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (check()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('condition not reached'));
      }
    }, 10);
  });
}

function makeStream(
  url: string,
  overrides?: Partial<Parameters<typeof collect>[0]>,
): { stream: RelayStream; events: ReturnType<typeof collect> } {
  const events = collect(overrides ?? {});
  const stream = new RelayStream({
    url: () => url,
    headers: () => ({ Authorization: 'Bearer test' }),
    minBackoffMs: 30,
    maxBackoffMs: 120,
    callbacks: events.callbacks,
  });
  activeStreams.push(stream);
  return { stream, events };
}

function collect(_: object) {
  const events = {
    connected: 0,
    messages: [] as unknown[],
    unsupported: 0,
    unauthorized: 0,
    callbacks: {
      onConnected: () => void events.connected++,
      onMessage: (d: unknown) => void events.messages.push(d),
      onUnsupported: () => void events.unsupported++,
      onUnauthorized: () => void events.unauthorized++,
    },
  };
  return events;
}

afterEach(async () => {
  for (const s of activeStreams.splice(0)) s.stop();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

describe('RelayStream', () => {
  it('connects (hello) and delivers data frames; heartbeats are ignored', async () => {
    let live: http.ServerResponse | null = null;
    const url = await serve((_req, res) => {
      live = res;
      sse(res);
    });
    const { stream, events } = makeStream(url);
    stream.start();
    await until(() => events.connected === 1);

    live!.write(': hb\n\n');
    live!.write('data: {"msgId":"m1","epk":"x"}\n\n');
    // A frame split across chunks must still parse.
    live!.write('data: {"msgId":');
    live!.write('"m2"}\n\n');
    await until(() => events.messages.length === 2);
    expect(events.messages[0]).toEqual({ msgId: 'm1', epk: 'x' });
    expect(events.messages[1]).toEqual({ msgId: 'm2' });
    expect(events.unauthorized).toBe(0);
  });

  it('reconnects after the server drops the stream', async () => {
    const url = await serve((_req, res) => {
      sse(res);
      // Server closes the response shortly after hello (deploy/idle reap).
      setTimeout(() => res.end(), 30);
    });
    const { stream, events } = makeStream(url);
    stream.start();
    await until(() => events.connected >= 2, 5000);
    expect(events.unsupported).toBe(0);
  });

  it('404 reports unsupported and stops for good', async () => {
    let hits = 0;
    const url = await serve((_req, res) => {
      hits++;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const { stream, events } = makeStream(url);
    stream.start();
    await until(() => events.unsupported === 1);
    expect(stream.running).toBe(false);
    // No further attempts after the 404.
    await new Promise((r) => setTimeout(r, 200));
    expect(hits).toBe(1);
  });

  it('401 reports unauthorized and keeps retrying at max backoff', async () => {
    let hits = 0;
    const url = await serve((_req, res) => {
      hits++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const { stream, events } = makeStream(url);
    stream.start();
    await until(() => events.unauthorized >= 2, 5000);
    expect(stream.running).toBe(true);
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('stop() aborts a live connection and prevents reconnects', async () => {
    let hits = 0;
    const url = await serve((_req, res) => {
      hits++;
      sse(res);
    });
    const { stream, events } = makeStream(url);
    stream.start();
    await until(() => events.connected === 1);
    stream.stop();
    await new Promise((r) => setTimeout(r, 250));
    expect(hits).toBe(1);
    expect(stream.running).toBe(false);
  });
});
