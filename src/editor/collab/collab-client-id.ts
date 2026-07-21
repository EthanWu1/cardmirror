/**
 * Stable per-install client id for co-editing streams.
 *
 * The relay caps concurrent SSE streams per room and — behind a TLS proxy that
 * can hold an upstream connection open after the app drops — often never sees a
 * stream close, so a room fills with ghost slots and answers 409 "full" to its
 * own participants (field diagnosis 2026-07-21). The relay reclaims a slot when
 * the SAME client reconnects, keyed by this id: a reconnect / reopen replaces
 * the client's prior stream instead of stacking a second onto it.
 *
 * It must be STABLE across app restarts and crashes (so a crashed client that
 * relaunches reclaims its old slot), which is exactly what a persisted id gives.
 * Persistence is best-effort: if storage is unavailable we fall back to a
 * per-process id (still dedupes within a session; a fresh id after a crash just
 * ages out via the relay's stream-lifetime cap). Not a security or privacy
 * mechanism — the relay only ever sees this opaque id, never who the user is.
 */

const STORAGE_KEY = 'pmd-collab-client-id';

let cached: string | null = null;

function mint(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** This install's stable co-editing client id (persisted; minted on first use). */
export function collabClientId(): string {
  if (cached) return cached;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const fresh = mint();
    localStorage.setItem(STORAGE_KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // No storage (rare) — a per-process id still dedupes within this session.
    cached ??= mint();
    return cached;
  }
}

/** Test hook: forget the cached id so a test can exercise minting. */
export function __resetCollabClientIdForTests(): void {
  cached = null;
}
