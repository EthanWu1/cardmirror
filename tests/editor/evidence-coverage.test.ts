// @vitest-environment jsdom
/**
 * Two reported Search Evidence faults, as regressions:
 *
 *   "doesn't work through all the files" — a fixed per-file cap of 80 body
 *   rows meant a large backfile had most of its card bodies silently
 *   unindexed. Tags and cites still indexed, so search half-worked, which
 *   reads as broken rather than truncated.
 *
 *   "duplicates many things" — the palette led each result with `row.label`,
 *   and a card's tag, cite and body rows all carry the TAG as their label. So
 *   one card rendered three identical headlines.
 */

import { describe, it, expect } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { extractEvidenceRows, makeFileEntry, type FileEntry } from '../../src/editor/file-search.js';
import { evidenceResult } from '../../src/editor/quick-card-search-ui.js';
import { perFileBudget } from '../../src/editor/evidence-index.js';

const t = (s: string) => schema.text(s);

function backfile(cards: number) {
  return schema.nodes['doc']!.create(
    null,
    Array.from({ length: cards }, (_u, i) =>
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create(null, [t(`Warming causes extinction ${i}`)]),
        schema.nodes['cite_paragraph']!.create(null, [t(`Author${i} 24, Journal of Things`)]),
        schema.nodes['card_body']!.create(null, [t(`Body text for card ${i} with warrants.`)]),
      ]),
    ),
  );
}

const file: FileEntry = makeFileEntry('C:/lib/backfile.cmir', 'backfile.cmir', 1);

describe('evidence coverage', () => {
  it('indexes every card body when the budget allows, not a fixed 80', () => {
    for (const cards of [120, 500]) {
      const rows = extractEvidenceRows(backfile(cards), file, perFileBudget(10, 200_000));
      const bodies = rows.filter((r) => r.kind === 'body' || r.kind === 'paragraph');
      expect(bodies.length, `${cards}-card file should index every body`).toBe(cards);
    }
  });

  it('bounds EVERY row kind, not just bodies', () => {
    // The "only ~600 of 1700 files get searched" bug: tags and cites were
    // uncapped, so one big file consumed the global budget many times over and
    // the walk halted partway through the corpus.
    const rows = extractEvidenceRows(backfile(400), file, { maxRows: 100 });
    expect(rows.length).toBeLessThanOrEqual(100);
  });

  it('spends a tight allowance on tags before bodies', () => {
    const rows = extractEvidenceRows(backfile(400), file, { maxRows: 100 });
    const tags = rows.filter((r) => r.kind === 'tag').length;
    const bodies = rows.filter((r) => r.kind === 'body' || r.kind === 'paragraph').length;
    expect(tags, 'tags are the highest-signal rows and should win the budget').toBeGreaterThan(bodies);
  });

  it('keeps rows in document order after budgeting', () => {
    const rows = extractEvidenceRows(backfile(400), file, { maxRows: 150 });
    const positions = rows.map((r) => r.from);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('lets a whole 1700-file corpus fit the global budget', () => {
    // This is the property that was violated: sum(per-file) must not exceed
    // the global cap, or the indexer stops before the corpus does.
    const budget = perFileBudget(1_700, 200_000);
    expect(budget.maxRows * 1_700).toBeLessThanOrEqual(200_000);
    // And a real file must actually respect it.
    const rows = extractEvidenceRows(backfile(400), file, budget);
    expect(rows.length).toBeLessThanOrEqual(budget.maxRows);
  });

  it('still honours an explicit small budget', () => {
    const rows = extractEvidenceRows(backfile(200), file, 25); // bare number = maxBodyRows
    expect(rows.filter((r) => r.kind === 'body' || r.kind === 'paragraph').length).toBe(25);
    // Structural rows are not body rows and must survive the cap.
    expect(rows.filter((r) => r.kind === 'tag').length).toBe(200);
  });
});

describe('perFileBudget', () => {
  it('shares the global budget across the corpus', () => {
    expect(perFileBudget(10, 200_000).maxRows).toBeGreaterThan(1_000);
    expect(perFileBudget(2_000, 200_000).maxRows).toBeLessThan(1_000);
  });

  it('clamps to a floor and a ceiling', () => {
    expect(perFileBudget(1_000_000, 200_000).maxRows).toBe(60); // floor
    expect(perFileBudget(1, 200_000).maxRows).toBe(20_000); // ceiling
  });

  it('always leaves room for non-body rows', () => {
    for (const files of [1, 10, 1_700]) {
      const b = perFileBudget(files, 200_000);
      expect(b.maxBodyRows).toBeLessThan(b.maxRows);
    }
  });
});

describe('result rendering', () => {
  it("gives a card's three rows three distinct headlines", () => {
    const rows = extractEvidenceRows(backfile(1), file, 100);
    expect(rows.length).toBe(3); // tag + cite + body

    // The data still shares a label — that is the structural CONTEXT.
    expect(new Set(rows.map((r) => r.label)).size).toBe(1);

    // What the user sees must nonetheless be three different rows.
    const names = rows.map((r) => evidenceResult(r).name);
    expect(new Set(names).size, `duplicate headlines: ${JSON.stringify(names)}`).toBe(3);

    // And the tag context is still reachable, in the meta line.
    const bodyRow = rows.find((r) => r.kind === 'body' || r.kind === 'paragraph')!;
    expect(evidenceResult(bodyRow).meta).toContain('Warming causes extinction 0');
  });
});
