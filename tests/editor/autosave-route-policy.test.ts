import { describe, expect, it } from 'vitest';
import {
  isAutosaveBackedRoute,
  shouldPromptBeforeRoute,
} from '../../src/editor/autosave-route-policy.js';

describe('autosave route policy', () => {
  it('does not prompt before closing or replacing a saved autosave-backed cmir', () => {
    expect(
      shouldPromptBeforeRoute({
        dirty: true,
        format: 'cmir',
        handle: 'C:\\Users\\ethan\\Dropbox\\case.cmir',
        supportsInPlaceSave: true,
        autosaveEnabled: true,
      }),
    ).toBe(false);
  });

  it('does not prompt for shared cmir sessions whose host forces autosave', () => {
    expect(
      isAutosaveBackedRoute({
        dirty: true,
        format: 'cmir',
        handle: 'C:\\Users\\ethan\\Dropbox\\case.cmir',
        supportsInPlaceSave: true,
        autosaveEnabled: false,
        forcedAutosave: true,
      }),
    ).toBe(true);
  });

  it('still prompts for manual-save or unsaved documents', () => {
    expect(
      shouldPromptBeforeRoute({
        dirty: true,
        format: 'docx',
        handle: 'C:\\Users\\ethan\\Dropbox\\case.docx',
        supportsInPlaceSave: true,
        autosaveEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldPromptBeforeRoute({
        dirty: true,
        format: 'cmir',
        handle: null,
        supportsInPlaceSave: true,
        autosaveEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldPromptBeforeRoute({
        dirty: true,
        format: 'cmir',
        handle: 'C:\\Users\\ethan\\Dropbox\\case.cmir',
        supportsInPlaceSave: true,
        autosaveEnabled: false,
      }),
    ).toBe(true);
  });

  it('treats saved cmflow as autosave-backed only when autosave can really write it', () => {
    expect(
      shouldPromptBeforeRoute({
        dirty: true,
        format: 'cmflow',
        handle: 'C:\\Users\\ethan\\Dropbox\\round.cmflow',
        supportsInPlaceSave: true,
        autosaveEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldPromptBeforeRoute({
        dirty: true,
        format: 'cmflow',
        handle: 'C:\\Users\\ethan\\Dropbox\\round.cmflow',
        supportsInPlaceSave: false,
        autosaveEnabled: true,
      }),
    ).toBe(true);
  });
});
