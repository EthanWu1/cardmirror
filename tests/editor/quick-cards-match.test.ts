/**
 * Quick Cards search matcher — scope, two-tier ranking, snippets.
 */

import { describe, expect, it } from 'vitest';
import { searchQuickCards, isInScope } from '../../src/editor/quick-cards-match.js';
import type { QuickCard } from '../../src/editor/quick-cards-store.js';

let seq = 0;
function card(opts: {
  name: string;
  tags?: string[];
  text?: string;
  updatedAt?: number;
}): QuickCard {
  const name = opts.name;
  const tags = opts.tags ?? [];
  const text = opts.text ?? '';
  return {
    id: `id-${seq++}`,
    name,
    tags,
    contentJson: {},
    nameLower: name.toLowerCase(),
    tagsLower: tags.map((t) => t.toLowerCase()),
    textLower: text.toLowerCase(),
    sourceName: '',
    createdAt: 0,
    updatedAt: opts.updatedAt ?? 0,
  };
}

const NO_TAGS = new Set<string>();

describe('quick-cards matcher — scope', () => {
  it('empty filter includes everything', () => {
    const c = card({ name: 'A', tags: ['x'] });
    expect(isInScope(c, NO_TAGS)).toBe(true);
  });

  it('non-empty filter requires an active tag', () => {
    const tagged = card({ name: 'A', tags: ['politics'] });
    const other = card({ name: 'B', tags: ['economy'] });
    const active = new Set(['politics']);
    expect(isInScope(tagged, active)).toBe(true);
    expect(isInScope(other, active)).toBe(false);
  });

  it('untagged cards are always in scope', () => {
    const untagged = card({ name: 'A', tags: [] });
    expect(isInScope(untagged, new Set(['politics']))).toBe(true);
  });
});

describe('quick-cards matcher — ranking', () => {
  it('name matches rank before content-only matches', () => {
    const byName = card({ name: 'NATO expansion', text: 'unrelated body' });
    const byContent = card({ name: 'Some card', text: 'discusses nato at length' });
    const res = searchQuickCards([byContent, byName], 'nato', NO_TAGS);
    expect(res.map((r) => r.card.name)).toEqual(['NATO expansion', 'Some card']);
    expect(res[0]!.matchedName).toBe(true);
    expect(res[1]!.matchedName).toBe(false);
  });

  it('is order-independent multi-token AND over the name', () => {
    const hit = card({ name: 'Mearsheimer NATO expansion' });
    const miss = card({ name: 'Mearsheimer realism' });
    const res = searchQuickCards([hit, miss], 'nato mears', NO_TAGS);
    expect(res).toHaveLength(1);
    expect(res[0]!.card.name).toBe('Mearsheimer NATO expansion');
  });

  it('prefix name matches float above mid-name matches', () => {
    const mid = card({ name: 'The cap card', updatedAt: 100 });
    const prefix = card({ name: 'Cap good', updatedAt: 1 });
    const res = searchQuickCards([mid, prefix], 'cap', NO_TAGS);
    expect(res.map((r) => r.card.name)).toEqual(['Cap good', 'The cap card']);
  });

  it('empty query browses the in-scope library, newest first', () => {
    const older = card({ name: 'Older', updatedAt: 1 });
    const newer = card({ name: 'Newer', updatedAt: 2 });
    const res = searchQuickCards([older, newer], '   ', NO_TAGS);
    expect(res.map((r) => r.card.name)).toEqual(['Newer', 'Older']);
  });

  it('content matches carry a snippet of the matched region', () => {
    const c = card({
      name: 'Heg',
      text: 'A long preamble before the key phrase deterrence collapses afterwards',
    });
    const res = searchQuickCards([c], 'deterrence', NO_TAGS);
    expect(res).toHaveLength(1);
    expect(res[0]!.matchedName).toBe(false);
    expect(res[0]!.snippet).toContain('deterrence');
    expect(res[0]!.snippet!.length).toBeLessThan(c.textLower.length);
  });

  it('respects the active-tags scope in search', () => {
    const inScope = card({ name: 'Cap', tags: ['k'] });
    const outScope = card({ name: 'Cap', tags: ['da'] });
    const res = searchQuickCards([inScope, outScope], 'cap', new Set(['k']));
    expect(res).toHaveLength(1);
    expect(res[0]!.card.tags).toEqual(['k']);
  });
});
