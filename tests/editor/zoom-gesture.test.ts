import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  GESTURE_ZOOM_SETTLE_MS,
  clampLiveZoom,
  zoomPctAfterWheelDelta,
} from '../../src/editor/zoom-gesture.js';

const indexTs = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8');
const styleCss = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'style.css'), 'utf8');

describe('smooth gesture zoom', () => {
  it('changes zoom on small wheel deltas without waiting for a 10% threshold', () => {
    expect(zoomPctAfterWheelDelta(100, -4)).toBeGreaterThan(100);
    expect(zoomPctAfterWheelDelta(100, 4)).toBeLessThan(100);
  });

  it('does not snap live pinch zoom to 10% increments', () => {
    expect(zoomPctAfterWheelDelta(100, -7)).toBe(102.4803);
  });

  it('clamps live zoom to document zoom bounds without visible two-decimal stepping', () => {
    expect(clampLiveZoom(49.4)).toBe(50);
    expect(clampLiveZoom(137.61234)).toBe(137.6123);
    expect(clampLiveZoom(501)).toBe(500);
  });

  it('uses a gentler wheel scale for smoother pinch deltas', () => {
    expect(zoomPctAfterWheelDelta(100, -4)).toBe(101.4098);
  });

  it('uses proportional scaling so high zoom still feels responsive', () => {
    expect(zoomPctAfterWheelDelta(400, -4)).toBeGreaterThan(401);
  });

  it('reflows the active document on every pinch event and keeps the viewport anchored', () => {
    expect(GESTURE_ZOOM_SETTLE_MS).toBeLessThanOrEqual(90);
    expect(indexTs).toContain('applyGestureLiveZoom');
    expect(indexTs).toContain('function applyGestureZoomDelta(deltaY: number): void');
    expect(indexTs).toMatch(/gestureZoomLivePct\s*=\s*zoomPctAfterWheelDelta\(gestureZoomLivePct,\s*deltaY\);[\s\S]*?applyGestureLiveZoom\(\);/);
    expect(indexTs).toMatch(/function applyGestureLiveZoom\(\): void \{[\s\S]*?applyActiveLiveZoomTarget\(gestureZoomLivePct\);[\s\S]*?restoreViewportAnchor\(gestureZoomAnchor\);/);
    expect(indexTs).toContain('finishGestureZoom');
    expect(indexTs).toMatch(/window\.setTimeout\(finishGestureZoom,\s*GESTURE_ZOOM_SETTLE_MS\)/);
    expect(indexTs).not.toContain('pendingGestureWheelDelta');
    expect(indexTs).not.toContain('requestAnimationFrame(flushGestureZoom)');
  });

  it('routes smooth pinch zoom to a single-pane Flow workspace', () => {
    expect(indexTs).toContain('activeFlowWorkspace?.getRound().settings.zoomPercent');
    expect(indexTs).toContain('activeFlowWorkspace.setZoom(target)');
    expect(indexTs).toContain('gestureZoomActiveSession');
  });

  it('does not use transform-only gesture zoom because it delays line spacing reflow', () => {
    expect(indexTs).not.toContain('pmd-gesture-zooming');
    expect(indexTs).not.toContain('--editor-gesture-scale');
    expect(styleCss).not.toContain('pmd-gesture-zooming');
    expect(styleCss).not.toContain('--editor-gesture-scale');
  });
});
