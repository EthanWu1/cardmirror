#!/usr/bin/env node
/**
 * Mock pairing relay — dev-only store-and-forward for CardMirror's
 * cross-machine card sharing. Implements the EXACT HTTP contract that the
 * real scouting-assistant `/relay` router will later expose, so the client
 * never changes when the production backend lands (PAIRING_V2_PLAN.md §5/§7).
 *
 * Directed addressing: every message is stored under its `recipientCode`.
 * A device only ever GETs messages addressed to its own code and never
 * addresses a message to itself — so there is no self-echo and no delete
 * race, and no per-device self-id guard is needed.
 *
 * Zero dependencies (Node built-ins only) so it runs with `node server.js`
 * — no `npm install`. NOT part of any build or deploy.
 *
 * Env:
 *   PAIRING_PORT      (default 3200)
 *   PAIRING_TOKEN     (default 'dev-pairing-token' — must match the client's
 *                      baked dev token)
 *   PAIRING_TTL_MS    (default 3h; lower it to test expiry)
 *   PAIRING_NO_STREAM (set to 1 to 404 the /stream endpoint — simulates a
 *                      legacy relay so the client's poll fallback can be
 *                      exercised)
 */

const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PAIRING_PORT || '3200', 10);
const TOKEN = process.env.PAIRING_TOKEN || 'dev-pairing-token';
const TTL_MS = parseInt(process.env.PAIRING_TTL_MS || String(3 * 60 * 60 * 1000), 10);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB decompressed — a Block + inline images
const MAX_PER_RECIPIENT = 100; // FIFO cap returned per poll

/** Map<recipientCode, Array<{ msgId, receivedAt, ...payload }>> */
const store = new Map();

/** Map<recipientCode, Set<http.ServerResponse>> — open SSE streams. */
const streams = new Map();
const NO_STREAM = process.env.PAIRING_NO_STREAM === '1';

function log(...args) {
  console.log(`[mock-relay]`, ...args);
}

function send(res, status, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/** Constant-time bearer check. */
function authOk(req) {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return false;
  const provided = Buffer.from(h.slice(7));
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/** Read the request body with a hard size cap, inflating gzip if present. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      total += c.length;
      // Stop storing once over the cap, but keep draining the stream so we
      // can answer 413 cleanly instead of resetting the socket.
      if (total > MAX_BYTES + 1024) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      let buf = Buffer.concat(chunks);
      const enc = (req.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
      } catch (e) {
        reject(Object.assign(new Error('bad gzip'), { status: 400 }));
        return;
      }
      if (buf.length > MAX_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      try {
        resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

/** Drop messages older than the TTL across all recipients. */
function sweep() {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const [code, list] of store.entries()) {
    const kept = list.filter((m) => m.receivedAt >= cutoff);
    removed += list.length - kept.length;
    if (kept.length) store.set(code, kept);
    else store.delete(code);
  }
  if (removed) log(`swept ${removed} expired message(s)`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  // Health — no auth.
  if (method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, recipients: store.size });
  }

  // Everything under /messages and /stream requires the bearer token.
  if (path === '/messages' || path.startsWith('/messages/') || path === '/stream') {
    if (!authOk(req)) {
      log(`${method} ${path} -> 401`);
      return send(res, 401, { error: 'unauthorized' });
    }
  }

  // GET /stream?recipient=<code> — SSE push channel (mirrors the real
  // relay's stream_messages: hello event, data frames per POSTed message,
  // heartbeat comments).
  if (method === 'GET' && path === '/stream') {
    if (NO_STREAM) return send(res, 404, { error: 'not found' });
    const recipient = url.searchParams.get('recipient');
    if (!recipient) return send(res, 400, { error: 'missing recipient' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.write('event: hello\ndata: {}\n\n');
    if (!streams.has(recipient)) streams.set(recipient, new Set());
    streams.get(recipient).add(res);
    log(`GET /stream -> open recipient=${recipient}`);
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(hb);
      const set = streams.get(recipient);
      if (set) {
        set.delete(res);
        if (set.size === 0) streams.delete(recipient);
      }
      log(`stream closed recipient=${recipient}`);
    });
    return;
  }

  // POST /messages — store one addressed message.
  if (method === 'POST' && path === '/messages') {
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      const status = e.status || 400;
      log(`POST /messages -> ${status} (${e.message})`);
      return send(res, status, { error: e.message });
    }
    const recipient = payload && payload.recipientCode;
    if (!recipient || typeof recipient !== 'string') {
      return send(res, 400, { error: 'missing recipientCode' });
    }
    const msgId = crypto.randomUUID();
    const record = { ...payload, msgId, receivedAt: Date.now() };
    if (!store.has(recipient)) store.set(recipient, []);
    store.get(recipient).push(record);
    // Store-then-push: live-deliver to any open streams (real relay parity).
    const set = streams.get(recipient);
    if (set && set.size > 0) {
      const frame = `data: ${JSON.stringify(record)}\n\n`;
      for (const s of set) s.write(frame);
      log(`pushed msgId=${msgId} to ${set.size} stream(s)`);
    }
    log(`POST /messages -> 202 recipient=${recipient} msgId=${msgId}`);
    return send(res, 202, { msgId });
  }

  // GET /messages?recipient=<code> — poll an inbox (lazy-expire first).
  if (method === 'GET' && path === '/messages') {
    sweep();
    const recipient = url.searchParams.get('recipient');
    if (!recipient) return send(res, 400, { error: 'missing recipient' });
    const list = store.get(recipient) || [];
    const messages = list.slice(0, MAX_PER_RECIPIENT);
    return send(res, 200, { messages });
  }

  // DELETE /messages/:msgId — acknowledge / remove one delivered message.
  if (method === 'DELETE' && path.startsWith('/messages/')) {
    const msgId = decodeURIComponent(path.slice('/messages/'.length));
    let removed = false;
    for (const [code, list] of store.entries()) {
      const idx = list.findIndex((m) => m.msgId === msgId);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) store.delete(code);
        removed = true;
        break;
      }
    }
    log(`DELETE /messages/${msgId} -> 204 (${removed ? 'removed' : 'not found'})`);
    res.writeHead(204);
    return res.end();
  }

  return send(res, 404, { error: 'not found' });
});

setInterval(sweep, 5 * 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`token=${TOKEN === 'dev-pairing-token' ? 'dev default' : 'custom'} ttl=${TTL_MS}ms cap=${MAX_BYTES}B`);
});
