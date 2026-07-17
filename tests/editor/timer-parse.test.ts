// @vitest-environment jsdom
/**
 * Timer input parsing. Bare digits are keypad / microwave style — the last two
 * digits are seconds, everything before is minutes (so `800` is 8:00, not 800
 * seconds). `MM:SS` is still taken literally.
 */
import { describe, expect, it } from 'vitest';
import { parseTimeInput } from '../../src/editor/timer-ui.js';

const sec = (n: number) => n * 1000;
const mmss = (m: number, s: number) => (m * 60 + s) * 1000;

describe('parseTimeInput — keypad digit entry', () => {
  it('reads the last two digits as seconds, the rest as minutes', () => {
    expect(parseTimeInput('800')).toBe(mmss(8, 0)); // the reported case: 8:00, not 800s
    expect(parseTimeInput('130')).toBe(mmss(1, 30));
    expect(parseTimeInput('600')).toBe(mmss(6, 0));
    expect(parseTimeInput('1230')).toBe(mmss(12, 30));
    expect(parseTimeInput('10000')).toBe(mmss(100, 0));
  });

  it('one- or two-digit input is just seconds (no minutes part)', () => {
    expect(parseTimeInput('5')).toBe(sec(5)); // 0:05
    expect(parseTimeInput('45')).toBe(sec(45)); // 0:45
    expect(parseTimeInput('90')).toBe(sec(90)); // 1:30 — the 90 seconds carry
    expect(parseTimeInput('0')).toBe(0);
  });

  it('a seconds part over 59 carries into minutes', () => {
    expect(parseTimeInput('870')).toBe(mmss(9, 10)); // 8*60 + 70 = 9:10
  });
});

describe('parseTimeInput — MM:SS and rejects', () => {
  it('parses explicit MM:SS literally', () => {
    expect(parseTimeInput('8:00')).toBe(mmss(8, 0));
    expect(parseTimeInput('1:30')).toBe(mmss(1, 30));
    expect(parseTimeInput('0:05')).toBe(sec(5));
    expect(parseTimeInput('12:30')).toBe(mmss(12, 30));
  });

  it('rejects MM:SS with seconds ≥ 60, empty, and non-numeric input', () => {
    expect(parseTimeInput('8:70')).toBeNull();
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('   ')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('8:')).toBeNull();
  });
});
