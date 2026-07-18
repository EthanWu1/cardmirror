// @vitest-environment node
/**
 * Path-safety boundary for transclusion refresh: resolve a doc-relative ref,
 * scope it to library roots / the doc's own folder, and reject `..` escapes.
 *
 * Fixture paths are written POSIX-style and passed through `abs()`
 * (path.resolve) so they take NATIVE form on whichever OS runs the
 * suite — identity on mac/Linux, `D:\Users\…` on the Windows CI leg —
 * which is exactly what the resolver returns. The containment logic
 * itself is platform-generic (it resolves everything before comparing),
 * so this exercises the same boundary everywhere.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  resolveCmirRef,
  resolveCmirCandidates,
  isWithin,
} from '../../apps/desktop/src/transclusion-path.js';

const abs = (p: string): string => path.resolve(p);

const DOC = abs('/Users/x/Dropbox/Debate/Speeches/Doc.cmir');
const ROOT = abs('/Users/x/Dropbox/Debate');

describe('resolveCmirRef — allowed cases', () => {
  it('same-folder sibling ref works with no roots configured', () => {
    expect(resolveCmirRef(DOC, 'Src.cmir', [])).toBe(abs('/Users/x/Dropbox/Debate/Speeches/Src.cmir'));
  });
  it('subfolder ref works with no roots', () => {
    expect(resolveCmirRef(DOC, 'sub/Src.cmir', [])).toBe(abs('/Users/x/Dropbox/Debate/Speeches/sub/Src.cmir'));
  });
  it('cross-directory ref works when inside a configured library root', () => {
    expect(resolveCmirRef(DOC, '../Impacts/Src.cmir', [ROOT])).toBe(abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'));
  });
  it('an absolute ref inside a root is allowed', () => {
    expect(resolveCmirRef(DOC, abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'), [ROOT])).toBe(
      abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'),
    );
  });
  it('. and staying-within .. normalize fine', () => {
    expect(resolveCmirRef(DOC, './a/../Src.cmir', [])).toBe(abs('/Users/x/Dropbox/Debate/Speeches/Src.cmir'));
  });
});

describe('resolveCmirRef — REJECTED cases (traversal / scope)', () => {
  it('cross-dir ref with NO root escapes the doc folder → null', () => {
    expect(resolveCmirRef(DOC, '../Impacts/Src.cmir', [])).toBeNull();
  });
  it('deep traversal to a system file → null', () => {
    expect(resolveCmirRef(DOC, '../../../../../../etc/passwd.cmir', [ROOT])).toBeNull();
  });
  it('escape above the library root even with a root configured → null', () => {
    // /Users/x/Secrets is outside /Users/x/Dropbox/Debate.
    expect(resolveCmirRef(DOC, '../../../Secrets/x.cmir', [ROOT])).toBeNull();
  });
  it('absolute ref OUTSIDE every root → null', () => {
    expect(resolveCmirRef(DOC, abs('/etc/passwd.cmir'), [ROOT])).toBeNull();
  });
  it('unsupported extension → null (only .cmir / .docx are sources)', () => {
    expect(resolveCmirRef(DOC, 'Src.txt', [])).toBeNull();
    expect(resolveCmirRef(DOC, 'Src.pdf', [])).toBeNull();
  });
  it('.docx inside a root is an allowed source (raw Word files get anchored)', () => {
    expect(resolveCmirRef(DOC, '../Impacts/Src.docx', [ROOT])).toBe(
      abs('/Users/x/Dropbox/Debate/Impacts/Src.docx'),
    );
  });
  it('empty / malformed inputs → null', () => {
    expect(resolveCmirRef('', 'Src.cmir', [])).toBeNull();
    expect(resolveCmirRef(DOC, '', [])).toBeNull();
    // Non-string roots are ignored, not fatal.
    expect(resolveCmirRef(DOC, 'Src.cmir', [null as unknown as string])).toBe(
      abs('/Users/x/Dropbox/Debate/Speeches/Src.cmir'),
    );
  });
});

describe('isWithin', () => {
  it('true for self and descendants', () => {
    expect(isWithin(abs('/a/b'), abs('/a/b'))).toBe(true);
    expect(isWithin(abs('/a/b'), abs('/a/b/c/d'))).toBe(true);
  });
  it('false for ancestors, siblings, and escapes', () => {
    expect(isWithin(abs('/a/b'), abs('/a'))).toBe(false);
    expect(isWithin(abs('/a/b'), abs('/a/c'))).toBe(false);
    expect(isWithin(abs('/a/b'), abs('/x'))).toBe(false);
  });
  it('is not fooled by a sibling with the same prefix', () => {
    // /a/bcd is NOT inside /a/b (string-prefix trap).
    expect(isWithin(abs('/a/b'), abs('/a/bcd'))).toBe(false);
  });
});

describe('resolveCmirCandidates — root base tries each root', () => {
  const DOC2 = abs('/Users/x/Dropbox/Debate/Speeches/Doc.cmir');
  const R1 = abs('/Users/x/Dropbox/Debate');
  const R2 = abs('/Users/x/OtherLib');

  it('root base resolves against each configured root, in order', () => {
    const c = resolveCmirCandidates(DOC2, 'Impacts/Src.cmir', 'root', [R1, R2]);
    expect(c).toEqual([
      abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'),
      abs('/Users/x/OtherLib/Impacts/Src.cmir'),
    ]);
  });
  it('root base prefers the root that also contains the doc (Dropbox tie-break)', () => {
    // Both roots hold the same relative path, and R1 contains the doc — but it's
    // listed SECOND. The doc's own root must still win the tie so a mirrored
    // second library can't shadow it.
    const c = resolveCmirCandidates(DOC2, 'Impacts/Src.cmir', 'root', [R2, R1]);
    expect(c[0]).toBe(abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'));
    expect(c).toEqual([
      abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'),
      abs('/Users/x/OtherLib/Impacts/Src.cmir'),
    ]);
  });
  it('among nested roots that both contain the doc, the most specific wins', () => {
    const PARENT = abs('/Users/x/Dropbox');
    // Both PARENT and R1 contain the doc; R1 (deeper) should be tried first.
    const c = resolveCmirCandidates(DOC2, 'Impacts/Src.cmir', 'root', [PARENT, R1]);
    expect(c[0]).toBe(abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'));
  });
  it('an exact absolute-path match is tried first, over the root heuristic', () => {
    // source_abs points at the OtherLib copy; the doc-root heuristic would
    // otherwise prefer R1. The exact absolute match must win (local copy vs.
    // shared original).
    const c = resolveCmirCandidates(
      DOC2,
      'Impacts/Src.cmir',
      'root',
      [R1, R2],
      abs('/Users/x/OtherLib/Impacts/Src.cmir'),
    );
    expect(c[0]).toBe(abs('/Users/x/OtherLib/Impacts/Src.cmir'));
  });
  it("another machine's absolute path (outside these roots) is ignored → falls back to relative", () => {
    const c = resolveCmirCandidates(
      DOC2,
      'Impacts/Src.cmir',
      'root',
      [R1, R2],
      abs('/Users/alice/Debate/Impacts/Src.cmir'),
    );
    expect(c).toEqual([
      abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'),
      abs('/Users/x/OtherLib/Impacts/Src.cmir'),
    ]);
  });
  it('a hostile absolute path outside every root is not a candidate', () => {
    const c = resolveCmirCandidates(DOC2, 'Impacts/Src.cmir', 'root', [R1, R2], abs('/etc/passwd.cmir'));
    expect(c).not.toContain(abs('/etc/passwd.cmir'));
  });
  it('root base keeps each candidate scoped to its own root (no escape)', () => {
    // A malicious root-relative ref with .. is rejected under every root.
    expect(resolveCmirCandidates(DOC2, '../../../etc/passwd.cmir', 'root', [R1, R2])).toEqual([]);
  });
  it('root base with no roots yields nothing', () => {
    expect(resolveCmirCandidates(DOC2, 'Impacts/Src.cmir', 'root', [])).toEqual([]);
  });
  it('doc base yields the doc-relative candidate', () => {
    expect(resolveCmirCandidates(DOC2, '../Impacts/Src.cmir', 'doc', [R1])).toEqual([
      abs('/Users/x/Dropbox/Debate/Impacts/Src.cmir'),
    ]);
  });
  it('.docx is kept under root base (it is a valid live-zone source)', () => {
    expect(resolveCmirCandidates(DOC2, 'Impacts/Src.docx', 'root', [R1])).toEqual([
      abs('/Users/x/Dropbox/Debate/Impacts/Src.docx'),
    ]);
  });
  it('a genuinely unsupported extension is still dropped under root base', () => {
    expect(resolveCmirCandidates(DOC2, 'Impacts/Src.txt', 'root', [R1])).toEqual([]);
  });
});
