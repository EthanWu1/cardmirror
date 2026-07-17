/**
 * Mode-switch marker round-trip — the handoff record that scopes the
 * post-reload reopen to exactly the docs the switch journaled. The
 * live bug this pins: an unscoped marker swept EVERY journal in the
 * store into the new layout, so docs from the last three-pane
 * session reappeared on every single→multi toggle.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeModeSwitchMarker,
  decodeModeSwitchMarker,
  modeSwitchDirtyMap,
  modeSwitchReopenDocsForLayoutSwitch,
  type ModeSwitchDoc,
} from '../../src/editor/mode-switch.js';

describe('mode-switch marker', () => {
  it('round-trips a doc list', () => {
    const docs: ModeSwitchDoc[] = [
      { uid: 'a', dirty: true },
      { uid: 'b', dirty: false },
    ];
    expect(decodeModeSwitchMarker(encodeModeSwitchMarker(docs))).toEqual(docs);
  });

  it('round-trips an empty list (pristine-starter switch)', () => {
    expect(decodeModeSwitchMarker(encodeModeSwitchMarker([]))).toEqual([]);
  });

  it('null input means no switch happened', () => {
    expect(decodeModeSwitchMarker(null)).toBeNull();
  });

  it('malformed marker still reads as a switch, with no docs', () => {
    // A switch DID happen (the key was set) — returning [] keeps the
    // caller from falling back to sweeping in unrelated journals.
    expect(decodeModeSwitchMarker('not json')).toEqual([]);
    expect(decodeModeSwitchMarker('{"docs":"nope"}')).toEqual([]);
    expect(decodeModeSwitchMarker('{}')).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      docs: [{ uid: 'a', dirty: true }, { uid: 42 }, null, { dirty: false }],
    });
    expect(decodeModeSwitchMarker(raw)).toEqual([{ uid: 'a', dirty: true }]);
  });

  it('dirty map keeps dirty=true when channels disagree', () => {
    // The same uid can arrive via both the local marker and a closed
    // window's report; losing an unsaved-changes flag is worse than
    // a redundant close prompt.
    const map = modeSwitchDirtyMap([
      { uid: 'a', dirty: false },
      { uid: 'a', dirty: true },
      { uid: 'b', dirty: true },
      { uid: 'b', dirty: false },
      { uid: 'c', dirty: false },
    ]);
    expect(map.get('a')).toBe(true);
    expect(map.get('b')).toBe(true);
    expect(map.get('c')).toBe(false);
    expect(map.has('d')).toBe(false);
  });

  it('switching into three-pane reopens only the current local doc', () => {
    const localDocs: ModeSwitchDoc[] = [
      { uid: 'current', dirty: true },
      { uid: 'other-local', dirty: false },
    ];
    const remoteDocs: ModeSwitchDoc[] = [{ uid: 'other-window', dirty: true }];

    expect(modeSwitchReopenDocsForLayoutSwitch(localDocs, remoteDocs, true)).toEqual([
      { uid: 'current', dirty: true },
    ]);
  });

  it('switching back to single-doc keeps the existing scoped reopen list', () => {
    const localDocs: ModeSwitchDoc[] = [{ uid: 'focused', dirty: false }];
    const remoteDocs: ModeSwitchDoc[] = [{ uid: 'reported', dirty: true }];

    expect(modeSwitchReopenDocsForLayoutSwitch(localDocs, remoteDocs, false)).toEqual([
      { uid: 'focused', dirty: false },
      { uid: 'reported', dirty: true },
    ]);
  });
});
