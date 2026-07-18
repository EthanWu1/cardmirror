/**
 * Unit tests for `compileShrinkProtections` — the pipeline that
 * combines the static built-in protected patterns with user-supplied
 * custom rules and (when configured) the warning-marker patterns for
 * the user's custom condense-with-warning delimiter.
 */

import { describe, expect, it } from 'vitest';
import { compileShrinkProtections } from '../../src/editor/ribbon-commands.js';

function sources(regexes: readonly RegExp[]): string[] {
  return regexes.map((r) => r.source);
}

describe('compileShrinkProtections', () => {
  it('returns the built-in patterns when there are no customs', () => {
    const list = compileShrinkProtections([], '', '');
    // Built-ins: 6 omission shapes + 6 warning-marker shapes
    // + 6 footnote shapes + 6 alt-text shapes + 6 translation-marker
    // shapes = 30.
    expect(list.length).toBe(30);
    // All have `gi` flags.
    for (const r of list) {
      expect(r.flags).toContain('g');
      expect(r.flags).toContain('i');
    }
  });

  it('protects footnote callouts in every delimiter shape', () => {
    const list = compileShrinkProtections([], '', '');
    const cases: string[] = [
      '[FOOTNOTE 7]',
      '[[FOOTNOTE 7]]',
      '<FOOTNOTE 7>',
      '<<FOOTNOTE 7>>',
      '{FOOTNOTE 7}',
      '{{FOOTNOTE 7}}',
      // Body text on either side of FOOTNOTE inside the delimiters:
      '[See FOOTNOTE 12, supra]',
      // Case-insensitive:
      '[footnote omitted]',
    ];
    for (const s of cases) {
      const matched = list.some((r) => {
        r.lastIndex = 0;
        return r.test(s);
      });
      expect(matched, `expected ${s} to be protected`).toBe(true);
    }
  });

  it('escapes literal-string customs so regex metacharacters are matched verbatim', () => {
    const list = compileShrinkProtections(
      [{ pattern: '[Hello.World]', isRegex: false }],
      '',
      '',
    );
    const added = list[list.length - 1]!;
    // `.` becomes `\.`, brackets escaped — the source should match the
    // literal string only.
    expect(added.source).toBe('\\[Hello\\.World\\]');
    expect('[Hello.World]'.match(added)).toBeTruthy();
    expect('[HelloXWorld]'.match(added)).toBeFalsy();
  });

  it('treats isRegex=true customs as raw regex sources', () => {
    const list = compileShrinkProtections(
      [{ pattern: 'foo\\d+', isRegex: true }],
      '',
      '',
    );
    const added = list[list.length - 1]!;
    expect(added.source).toBe('foo\\d+');
    expect('foo123'.match(added)).toBeTruthy();
    expect('foo'.match(added)).toBeFalsy();
  });

  it('skips invalid regex sources rather than throwing', () => {
    const before = compileShrinkProtections([], '', '').length;
    const list = compileShrinkProtections(
      [
        { pattern: '(unclosed', isRegex: true }, // invalid
        { pattern: 'valid', isRegex: false }, // valid literal
      ],
      '',
      '',
    );
    // Only the valid one is added; built-ins are unchanged.
    expect(list.length).toBe(before + 1);
    expect(list[list.length - 1]!.source).toBe('valid');
  });

  it('skips empty pattern strings', () => {
    const before = compileShrinkProtections([], '', '').length;
    const list = compileShrinkProtections(
      [{ pattern: '', isRegex: false }],
      '',
      '',
    );
    expect(list.length).toBe(before);
  });

  it('adds literal-string regexes for the custom pause / resume markers when configured', () => {
    const before = sources(compileShrinkProtections([], '', ''));
    const list = compileShrinkProtections(
      [],
      '<<-- pause -->>',
      '<<-- resume -->>',
    );
    const added = sources(list).filter((s) => !before.includes(s));
    expect(added.length).toBe(2);
    expect(added[0]).toBe('<<-- pause -->>');
    expect(added[1]).toBe('<<-- resume -->>');
  });

  it('escapes regex metacharacters in custom marker strings', () => {
    const list = compileShrinkProtections([], '|+pause+|', '|+resume+|');
    const before = compileShrinkProtections([], '', '');
    expect(list.length).toBe(before.length + 2);
    const added = list.slice(before.length);
    expect(added[0]!.source).toBe('\\|\\+pause\\+\\|');
    expect(added[1]!.source).toBe('\\|\\+resume\\+\\|');
    // Compiled regex matches literal text, case-insensitive.
    expect('|+pause+|'.match(added[0]!)).toBeTruthy();
    expect('|+PAUSE+|'.match(added[0]!)).toBeTruthy();
  });

  it('protects only the markers that are non-empty when one half is unset', () => {
    const baseline = compileShrinkProtections([], '', '').length;
    expect(compileShrinkProtections([], 'pause-only', '').length).toBe(
      baseline + 1,
    );
    expect(compileShrinkProtections([], '', 'resume-only').length).toBe(
      baseline + 1,
    );
  });
});
