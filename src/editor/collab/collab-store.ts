/**
 * Persisted collaboration-session records (M3).
 *
 * One record per room, holding everything needed to resume after an
 * app nuke: the room credentials, the delivery cursor, the CRDT
 * snapshot + increments (the load-bearing part — the file/journal
 * already preserve CONTENT, but only the CRDT's peer history makes
 * offline edits MERGEABLE on resume), and the version vector of what
 * the relay has already seen (so the first flush after resume sends
 * exactly the unsent diff).
 *
 * Backend: a dedicated IndexedDB database, used directly. IndexedDB
 * stores Uint8Array natively (no base64 inflation) and works
 * identically in the web edition and Electron renderers — one
 * implementation, no IPC, and the records are visible to every window
 * of the app (the home screen's Sessions list). Cross-window refresh
 * rides a BroadcastChannel. localStorage is disqualified by its ~5 MB
 * string-only cap; the main-process file stores would need three new
 * plumbing layers for no benefit at these sizes.
 *
 * Also holds invite seed PREFETCHES (§4.1): on invite receipt the
 * encrypted room backlog is downloaded eagerly, so an invite accepted
 * later — on a bus, offline — still opens the doc and joins locally.
 */

const DB_NAME = 'cardmirror-collab';
const DB_VERSION = 2;
const SESSIONS = 'sessions';
const PREFETCH = 'invite-prefetch';
const SEED_CACHE = 'seed-cache';
const CHANNEL = 'pmd-collab-sessions';

export interface PersistedSessionRecord {
  /** Key. */
  roomId: string;
  shareCode: string;
  role: 'host' | 'participant';
  /** Delivery cursor: catch-up resumes from here. */
  lastSeq: number;
  /** VersionVector.encode() of what the relay has seen from us. */
  sentVersion: Uint8Array;
  /** CRDT base snapshot… */
  snapshot: Uint8Array;
  /** …plus incremental exports since (compacted periodically). */
  increments: Uint8Array[];
  /** VersionVector.encode() covered by snapshot+increments — the
   *  persistence manager diffs from here on the next write. */
  persistedVersion: Uint8Array;
  docTitle: string;
  /** Persistent docId of the doc holding this session in THIS window,
   *  when known (stamped once the doc is saved). Lets the open-from-disk
   *  path detect "this file has a session" and offer rejoin-or-leave
   *  instead of silently diverging. Absent on older records. */
  docId?: string | null;
  /** Room guest pass (web-collab Phase 3) — the account-less joiner's
   *  credential, persisted so resume authenticates the same way the
   *  original join did. Absent on older records and on peers that
   *  joined with their own credentials. */
  guestPass?: string | null;
  updatedAt: number;
}

export interface InvitePrefetchRecord {
  /** Key. */
  roomId: string;
  /** Encrypted blobs exactly as fetched (snapshot-fast-path + tail). */
  blobs: Uint8Array[];
  lastSeq: number;
  fetchedAt: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;
try {
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => {
    for (const fn of listeners) fn();
  };
} catch {
  /* very old runtimes — cross-window refresh degrades to show()-time reads */
}

function notify(): void {
  for (const fn of listeners) fn();
  try {
    channel?.postMessage('changed');
  } catch {
    /* closed */
  }
}

/** Fires on any session-record change, local or from another window. */
/** Re-fire every subscriber without a record change — used when the
 *  collab GATE opens after boot (a guest's records become visible)
 *  so already-rendered surfaces like the home screen re-check. */
export function notifySessionRecordListeners(): void {
  for (const fn of listeners) fn();
}

export function subscribeSessionRecords(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return (dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSIONS)) {
          db.createObjectStore(SESSIONS, { keyPath: 'roomId' });
        }
        if (!db.objectStoreNames.contains(PREFETCH)) {
          db.createObjectStore(PREFETCH, { keyPath: 'roomId' });
        }
        // v2. Each guard is independent so an existing v1 database gains only
        // the missing store and keeps its session records.
        if (!db.objectStoreNames.contains(SEED_CACHE)) {
          db.createObjectStore(SEED_CACHE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // storage denied — persistence degrades to none
    } catch {
      resolve(null);
    }
  }));
}

function requestDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('idb tx failed'));
  });
}

async function put(store: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await requestDone(tx);
}

async function del(store: string, key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await requestDone(tx);
}

async function get<T>(store: string, key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function all<T>(store: string): Promise<T[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => resolve([]);
  });
}

// ── Session records ──────────────────────────────────────────────────

export async function saveSessionRecord(record: PersistedSessionRecord): Promise<void> {
  await put(SESSIONS, record);
  notify();
}

export async function loadSessionRecord(roomId: string): Promise<PersistedSessionRecord | null> {
  return get<PersistedSessionRecord>(SESSIONS, roomId);
}

export async function listSessionRecords(): Promise<PersistedSessionRecord[]> {
  const rows = await all<PersistedSessionRecord>(SESSIONS);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSessionRecord(roomId: string): Promise<void> {
  await del(SESSIONS, roomId);
  notify();
}

// ── Invite prefetches ────────────────────────────────────────────────

export async function savePrefetch(record: InvitePrefetchRecord): Promise<void> {
  await put(PREFETCH, record);
}

export async function loadPrefetch(roomId: string): Promise<InvitePrefetchRecord | null> {
  return get<InvitePrefetchRecord>(PREFETCH, roomId);
}

export async function deletePrefetch(roomId: string): Promise<void> {
  await del(PREFETCH, roomId);
}

// ── Seed cache ───────────────────────────────────────────────────────

/** A CRDT snapshot already seeded from a specific document, so re-hosting an
 *  unchanged file skips the super-linear seeding entirely (see
 *  `collab-seed-core.ts`). Keyed by a content digest, NOT by filename: the
 *  same bytes must hit and any edit must miss. */
export interface SeedCacheRecord {
  /** Key: content digest of the document JSON. */
  key: string;
  snapshot: Uint8Array;
  /** Cheap secondary check against a digest collision seeding a WRONG doc. */
  nodeSize: number;
  createdAt: number;
}

/** Total cached seed bytes to keep. A huge master file's snapshot is ~6 MB, so
 *  this holds roughly a tournament's worth of distinct files before the oldest
 *  are evicted. */
const SEED_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export async function loadSeedCache(key: string): Promise<SeedCacheRecord | null> {
  return get<SeedCacheRecord>(SEED_CACHE, key);
}

export async function saveSeedCache(record: SeedCacheRecord): Promise<void> {
  await put(SEED_CACHE, record);
  await pruneSeedCache();
}

/** Evict oldest-first until the store is under the byte cap. */
export async function pruneSeedCache(maxBytes = SEED_CACHE_MAX_BYTES): Promise<void> {
  const rows = await all<SeedCacheRecord>(SEED_CACHE);
  let total = rows.reduce((n, r) => n + (r.snapshot?.length ?? 0), 0);
  if (total <= maxBytes) return;
  for (const row of rows.sort((a, b) => a.createdAt - b.createdAt)) {
    if (total <= maxBytes) break;
    total -= row.snapshot?.length ?? 0;
    await del(SEED_CACHE, row.key);
  }
}

/** Test/maintenance helper: drop every cached seed. */
export async function clearSeedCache(): Promise<void> {
  await pruneSeedCache(-1);
}
