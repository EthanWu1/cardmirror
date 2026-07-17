// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  slotPickerAriaLabelForTests,
  slotPickerVisibleLabelForTests,
} from '../../src/editor/slot-picker-label.js';

describe('workspace slot picker labels', () => {
  it('leaves empty panels visually blank while preserving an accessible label', () => {
    expect(slotPickerVisibleLabelForTests(null, 0)).toBe('');
    expect(slotPickerAriaLabelForTests('1', '')).toBe('Panel 1');
  });

  it('keeps open document labels normal and compact', () => {
    expect(slotPickerVisibleLabelForTests('Blocks.docx', 0)).toBe('Blocks.docx');
    expect(slotPickerVisibleLabelForTests('Blocks.docx', 2)).toBe('Blocks.docx (+2)');
    expect(slotPickerAriaLabelForTests('2', 'Blocks.docx')).toBe('Panel 2: Blocks.docx');
  });
});
