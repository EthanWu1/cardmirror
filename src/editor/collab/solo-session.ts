export const SOLO_SESSION_END_MS = 6000;

export interface SoloPresencePerson {
  self: boolean;
}

export interface SoloSessionStatus {
  connected: boolean;
  queuedUpdates: number;
}

export interface SoloSessionWatch {
  hadPartner: boolean;
  soloSince: number | null;
}

export function createSoloSessionWatch(): SoloSessionWatch {
  return { hadPartner: false, soloSince: null };
}

export function observeSoloSessionPresence(
  watch: SoloSessionWatch,
  peers: readonly SoloPresencePerson[],
  status: SoloSessionStatus,
  now = Date.now(),
): boolean {
  const hasPartner = peers.some((p) => !p.self);
  if (hasPartner) {
    watch.hadPartner = true;
    watch.soloSince = null;
    return false;
  }

  if (!watch.hadPartner || !status.connected || status.queuedUpdates > 0) {
    watch.soloSince = null;
    return false;
  }

  if (watch.soloSince === null) {
    watch.soloSince = now;
    return false;
  }

  return now - watch.soloSince >= SOLO_SESSION_END_MS;
}
