# CardMirror relay (self-hosting)

The server behind CardMirror's collaboration features: **card sharing**
(store-and-forward mailbox), **co-editing** (real-time session rooms),
and **persistent shared documents** (durable document rooms opened from
saved `.cmir` files). Everything is **end-to-end encrypted by the app**,
so this server only ever sees opaque ciphertext, a hashed routing code,
room/document ids, sizes, and timestamps. Mailbox messages are forgotten
after 3 hours whether or not they were delivered; temporary co-editing
rooms hold their encrypted session log until the host ends the session
or the room has been idle for 7 days. Persistent document rooms are kept
until the document is ended/archived. New cards and document updates are
live-pushed to connected apps over SSE; the app also catches up by
polling on every reconnect, so nothing is lost while a machine is
offline.

Run your own if you'd rather not use the official relay. Everyone
sharing cards with each other must point at the same relay.

## Quick start (docker compose)

```sh
cd relay
RELAY_TOKEN=$(openssl rand -hex 24) docker compose up -d
```

Then in CardMirror on every machine: **Settings → Collaboration** →
**Custom relay URL** = `http://<your-host>:8410/relay`, **Custom relay
token** = the same token. Use HTTPS (a reverse proxy such as Caddy or
your platform's TLS) for anything beyond a LAN.

For a private desktop installer that opens already pointed at this relay,
build with both defaults in the environment:

```sh
PAIRING_RELAY_URL="https://relay.example.com/relay" \
PAIRING_TOKEN="$RELAY_TOKEN" \
npm run desktop:dist
```

See [`../PRIVATE-INSTALL.md`](../PRIVATE-INSTALL.md) for the full two-person
install flow.

## Running it elsewhere

Any host that runs a Python process + Postgres works (Railway, Fly,
a VPS…). Requirements:

- env `DATABASE_URL` (Postgres) and `RELAY_TOKEN` (any long random
  string — it's the shared bearer, not the privacy mechanism).
- **Exactly one worker process** (`uvicorn server:app`, no
  `--workers`): the live-push registry is in-process.
- Recommended: `--limit-concurrency 4096` (the Dockerfile sets this) as
  a connection-storm backstop. It counts long-lived SSE streams too, so
  keep it far above the number of apps you expect connected at once.
- Optional: `MAX_STREAMS_PER_ROOM` controls the per-room SSE cap. The
  default is `30`, which leaves room for stale sockets from laptops that
  slept or crashed before the relay notices they closed.
- Required: `--timeout-graceful-shutdown 5` (the Dockerfile sets this).
  Without it a stopped instance waits forever for its open SSE streams
  and lingers as an unbound zombie that keeps heartbeating old clients
  while the new instance owns the port — their live pushes then go
  nowhere until the clients notice on their own.
- The tables are created automatically on first start.

Health check: `GET /relay/health` → `{"ok": true}` (no auth).

## Persistent shared documents

`POST /relay/docs` creates a document room and returns `{docId, roomId}`.
The app stores that metadata, plus the encrypted share code, inside saved
`.cmir` files. Opening that file later reconnects the local editor to the
same encrypted room. If the relay is unreachable, CardMirror leaves the
file open as a local copy and lets the user retry later.

Management endpoints, authenticated by the same bearer token:

```text
GET    /relay/docs                       list active document rooms
GET    /relay/docs?includeArchived=1     list active and archived rooms
GET    /relay/docs/{docId}               inspect metadata for one room
DELETE /relay/docs/{docId}               archive/end the document room
```

These endpoints expose metadata only. They cannot decrypt document
content. Deleting a persistent document room tombstones the underlying
room, deletes its encrypted updates/snapshot, notifies connected clients,
and leaves an archived metadata row visible to `includeArchived=1`.

## Upgrades and migrations

The relay creates missing tables on startup. Upgrading from a build that
only had mailbox/session rooms creates the new `relay_documents` table
automatically; existing rooms and messages are left alone. Back up the
Postgres database before upgrading a production relay, deploy one worker
process, and restart the process after pulling the new image/code.

## Security model

- The relay token controls who may use or administer this relay. It is a
  coarse shared bearer, not per-document access control.
- The `.cmir` shared-document metadata includes the encrypted share code.
  Anyone who can read that file can reconnect to the document room and
  edit, as long as they can reach the relay with a valid relay token.
- Privacy comes from end-to-end encryption in the app. The relay stores
  ciphertext and metadata only.
- There are no roles, per-user revocation, audit logs, or read-only links
  in this self-hosted relay API yet.

## Notes

- One `RELAY_TOKEN` covers all relay features: card sharing, co-editing,
  persistent documents, and document-management endpoints authenticate with the
  same shared bearer.
- Co-editing/document rooms: at most **30 streams** per room by default
  (configurable with `MAX_STREAMS_PER_ROOM`, enforced at stream connect),
  5 MB per update (the app chunks bigger ones), 200 MB stored per room.
- Payload cap 25 MB decompressed / 30 MB gzipped per send.
- Poll returns at most 100 messages, oldest first; the app deletes
  each message after it lands.
- CardMirror also works against a relay without the `/stream`
  endpoint by falling back to interval polling — but this server
  includes push, so you get instant delivery.
