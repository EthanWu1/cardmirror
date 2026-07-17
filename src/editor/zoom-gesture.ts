import { ZOOM_MAX_PCT, ZOOM_MIN_PCT } from './settings.js';

const WHEEL_DELTA_TO_ZOOM_EXP = 0.0035;
export const GESTURE_ZOOM_SETTLE_MS = 80;

export function clampLiveZoom(pct: number): number {
  const safe = Number.isFinite(pct) ? pct : 100;
  const clamped = Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, safe));
  return Math.round(clamped * 10000) / 10000;
}

export function zoomPctAfterWheelDelta(currentPct: number, deltaY: number): number {
  const current = clampLiveZoom(currentPct);
  const scale = Number.isFinite(deltaY) ? Math.exp(-deltaY * WHEEL_DELTA_TO_ZOOM_EXP) : 1;
  return clampLiveZoom(current * scale);
}
