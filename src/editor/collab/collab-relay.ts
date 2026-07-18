/**
 * Rooms-relay endpoint resolution, factored out of collab-ui so LIGHT
 * consumers (the invite seed prefetcher, fired from the always-loaded
 * Receive pill) can build a RoomsClient without pulling the Loro wasm
 * chunk. Resolution order: settings → dev env → baked desktop default
 * (same base + shared token card sharing uses).
 */

import { settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { collabDevRelay } from './collab-gate.js';
import { RoomsClient, RoomsError } from './room-client.js';

/** Baked relay endpoint from the desktop main process — resolved once,
 *  used as the LAST fallback so packaged builds work with zero setup.
 *  '' fields mean web edition / old preload / nothing baked. */
let bakedRelay: { url: string; token: string } | null = null;

export async function ensureBakedRelay(): Promise<void> {
  if (bakedRelay) return;
  try {
    bakedRelay = (await getElectronHost()?.collabRelayDefaults()) ?? { url: '', token: '' };
  } catch {
    bakedRelay = { url: '', token: '' };
  }
}

/** Users often paste the relay host without the required `/relay` API prefix.
 *  The server returns 405 for `/rooms` on the site root, which reads like a
 *  mysterious collaboration failure. Treat a bare origin/path as the relay
 *  root unless it already ends in `/relay`. */
export function normalizeRelayBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/relay';
      return url.toString().replace(/\/+$/, '');
    }
    if (!url.pathname.toLowerCase().endsWith('/relay')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/relay`;
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    /* Fall through for relative/test URLs. */
  }
  return /(?:^|\/)relay$/i.test(trimmed) ? trimmed : `${trimmed}/relay`;
}

export function resolveRelayClientConfig(input: {
  settingsUrl: string;
  settingsToken: string;
  dev?: { url: string; token: string } | null;
  baked?: { url: string; token: string } | null;
}): { url: string; token: string } | null {
  const customUrl = normalizeRelayBaseUrl(input.settingsUrl);
  const customToken = input.settingsToken.trim();
  const bakedUrl = normalizeRelayBaseUrl(input.baked?.url ?? '');
  const bakedToken = (input.baked?.token ?? '').trim();
  const devUrl = normalizeRelayBaseUrl(input.dev?.url ?? '');
  const devToken = (input.dev?.token ?? '').trim();

  if (devUrl && devToken) return { url: devUrl, token: devToken };
  if (bakedUrl && bakedToken) return { url: bakedUrl, token: bakedToken };
  if (customUrl && customToken) return { url: customUrl, token: customToken };
  return null;
}

export function relayClient(): RoomsClient | null {
  const dev = collabDevRelay();
  const config = resolveRelayClientConfig({
    settingsUrl: settings.get('pairingRelayUrl'),
    settingsToken: settings.get('pairingRelayToken'),
    dev,
    baked: bakedRelay,
  });
  if (!config) return null;
  return new RoomsClient({ baseUrl: () => config.url, token: () => config.token });
}

/** Tombstone a room on the relay — the home-screen Sessions list's host-side
 *  "End Session" (no live session object exists there, so this speaks to the
 *  relay directly). A room that is already ended (410) or expired/GC'd (404)
 *  counts as success: the goal — nobody can rejoin — already holds. Throws on
 *  anything else (offline, auth) so the caller can KEEP the record and let
 *  the host retry; deleting it without the tombstone would strand a live room
 *  that invited participants can silently rejoin. */
export async function endRoomOnRelay(roomId: string): Promise<void> {
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) throw new Error('no relay configured');
  try {
    await client.deleteRoom(roomId);
  } catch (err) {
    if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) return;
    throw err;
  }
}
