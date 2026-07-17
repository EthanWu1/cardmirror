// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecents,
  listRecents,
  recordRecent,
} from '../../src/editor/recents-store.js';

describe('flow recents', () => {
  beforeEach(() => {
    clearRecents();
  });

  it('stores cmflow recent files', () => {
    recordRecent({
      handle: 'C:/flows/round.cmflow',
      filename: 'round.cmflow',
      format: 'cmflow',
    });

    expect(listRecents()[0]).toMatchObject({
      filename: 'round.cmflow',
      format: 'cmflow',
    });
  });

  it('reads recents newest first even if older builds stored them out of order', () => {
    localStorage.setItem(
      'pmd-recent-files',
      JSON.stringify([
        { handle: 'C:/old.docx', filename: 'old.docx', format: 'docx', lastOpenedAt: 10 },
        { handle: 'C:/new.cmir', filename: 'new.cmir', format: 'cmir', lastOpenedAt: 30 },
        { handle: 'C:/middle.cmflow', filename: 'middle.cmflow', format: 'cmflow', lastOpenedAt: 20 },
      ]),
    );

    expect(listRecents().map((item) => item.filename)).toEqual(['new.cmir', 'middle.cmflow', 'old.docx']);
  });
});
