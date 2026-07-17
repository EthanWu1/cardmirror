import { describe, expect, it } from 'vitest';
import { shouldShowHomeAfterBlankBoot } from '../../src/editor/boot-home.js';

describe('blank single-doc boot', () => {
  it('shows Home even when this is not the first app window', () => {
    expect(shouldShowHomeAfterBlankBoot({ isFirstWindow: false, modeSwitchPending: false })).toBe(true);
  });
});
