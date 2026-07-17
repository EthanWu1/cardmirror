// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isAutosaveOnForPath, setAutosaveForPath } from '../../src/editor/autosave-prefs-store.js';

afterEach(() => {
  localStorage.clear();
});

describe('autosave preference store', () => {
  it('lets saved cmir files default autosave on', () => {
    expect(isAutosaveOnForPath('C:\\Users\\ethan\\Dropbox\\case.cmir', true)).toBe(true);
  });

  it('persists an explicit autosave-off override over the cmir default', () => {
    const path = 'C:\\Users\\ethan\\Dropbox\\case.cmir';

    setAutosaveForPath(path, false);

    expect(isAutosaveOnForPath(path, true)).toBe(false);
  });

  it('persists an explicit autosave-on choice for non-default files', () => {
    const path = 'C:\\Users\\ethan\\Dropbox\\case.docx';

    setAutosaveForPath(path, true);

    expect(isAutosaveOnForPath(path, false)).toBe(true);
  });

  it('never defaults autosave on for unsaved or web handles', () => {
    expect(isAutosaveOnForPath(null, true)).toBe(false);
    expect(isAutosaveOnForPath({ name: 'case.cmir' }, true)).toBe(false);
  });
});
