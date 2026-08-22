// @vitest-environment jsdom
/**
 * The search palette is positioned by JS but has `transform: none` in CSS,
 * so nothing shifts it back from whatever `left` it is given. It therefore
 * has to be clamped against the viewport in script — a version that set
 * `left` to the pane's CENTER (assuming a translateX(-50%) that this CSS
 * does not apply) pushed the panel off the right edge of the screen.
 */

import { describe, it, expect } from 'vitest';
import { clampPaletteToViewport } from '../../src/editor/quick-card-search-ui.js';

describe('clampPaletteToViewport', () => {
  it('keeps the whole search palette visible inside the viewport', () => {
    expect(
      clampPaletteToViewport({
        left: 720,
        top: 740,
        width: 540,
        height: 320,
        viewportWidth: 900,
        viewportHeight: 800,
        margin: 8,
      }),
    ).toEqual({ left: 352, top: 472 });
  });

  it('pins to the margin rather than going negative when the palette exceeds the viewport', () => {
    expect(
      clampPaletteToViewport({
        left: -200,
        top: -50,
        width: 540,
        height: 320,
        viewportWidth: 400,
        viewportHeight: 200,
        margin: 8,
      }),
    ).toEqual({ left: 8, top: 8 });
  });
});
