/**
 * Command-palette file search — matching + object extraction.
 */

import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { importDoc } from '../../src/import/index.js';
import {
  baseName,
  dirName,
  fileFormat,
  stripFileExt,
  searchFiles,
  searchFileObjects,
  extractFile,
  type FileEntry,
  type EvidenceSearchRow,
  type FileObject,
  type FileObjectKind,
} from '../../src/editor/file-search.js';
import * as fileSearchModule from '../../src/editor/file-search.js';

describe('path helpers', () => {
  it('baseName takes the last segment', () => {
    expect(baseName('a/b/c.cmir')).toBe('c.cmir');
    expect(baseName('c.cmir')).toBe('c.cmir');
    expect(baseName('a\\b\\c.cmir')).toBe('c.cmir');
  });
  it('dirName drops the filename', () => {
    expect(dirName('a/b/c.cmir')).toBe('a/b');
    expect(dirName('c.cmir')).toBe('');
  });
  it('fileFormat reads the extension (default cmir)', () => {
    expect(fileFormat('a/b/c.cmir')).toBe('cmir');
    expect(fileFormat('Heg Good.docx')).toBe('docx');
    expect(fileFormat('round.cmflow')).toBe('cmflow');
    expect(fileFormat('SHOUTY.DOCX')).toBe('docx');
    expect(fileFormat('no-ext')).toBe('cmir');
  });
  it('stripFileExt removes only the openable extension', () => {
    expect(stripFileExt('Warming Impacts.cmir')).toBe('Warming Impacts');
    expect(stripFileExt('Heg Good.docx')).toBe('Heg Good');
    expect(stripFileExt('round.cmflow')).toBe('round');
    expect(stripFileExt('my.report.cmir')).toBe('my.report'); // other dots kept
    expect(stripFileExt('plain')).toBe('plain');
  });
});

function file(name: string, relPath = name, mtimeMs = 0): FileEntry {
  return { path: `/root/${relPath}`, relPath, name, mtimeMs };
}

describe('searchFiles', () => {
  const files = [file('Warming Impacts.cmir'), file('Heg Good.cmir'), file('warming good.cmir')];

  it('empty query returns everything', () => {
    expect(searchFiles(files, '').length).toBe(3);
  });

  it('order-independent multi-token AND match', () => {
    const r = searchFiles(files, 'good warming');
    expect(r.map((f) => f.name)).toEqual(['warming good.cmir']);
  });

  it('both prefix matches tie and fall back to input order (mtime equal)', () => {
    const r = searchFiles(files, 'warming');
    // "Warming Impacts" and "warming good" both start with the query (tier 1);
    // equal mtime → the recency tiebreak is a no-op → input order.
    expect(r.map((f) => f.name)).toEqual(['Warming Impacts.cmir', 'warming good.cmir']);
  });

  it('uses cached lowercase file search text when present', () => {
    const cached: FileEntry = {
      path: '/root/No Match.cmir',
      relPath: 'No/Match.cmir',
      name: 'No Match',
      mtimeMs: 0,
      searchText: 'cached primary cached folder',
    };

    expect(searchFiles([cached], 'cached primary')).toEqual([cached]);
    expect(searchFiles([cached], 'folder primary')).toEqual([cached]);
  });
});

describe('searchFiles — relevance tiers', () => {
  const files = [
    file('Rewarming notes'), // substring, mid-word
    file('AT: Warming'), // word-start (not the label start)
    file('Warming DA'), // prefix
    file('Warming'), // exact
    file('Heg Good'), // no match
  ];

  it('orders exact → prefix → word-start → substring', () => {
    expect(searchFiles(files, 'warming').map((f) => f.name)).toEqual([
      'Warming',
      'Warming DA',
      'AT: Warming',
      'Rewarming notes',
    ]);
  });

  it('prefers a word-start over a mid-word substring', () => {
    const fs = [file('Software'), file('War powers')];
    expect(searchFiles(fs, 'war').map((f) => f.name)).toEqual(['War powers', 'Software']);
  });
});

describe('searchFiles — folder (relPath) matching', () => {
  it('matches a folder term via the relative path, ranked below a name hit', () => {
    const files = [
      file('Warming DA', 'Neg/Warming DA.cmir'),
      file('Impacts', 'Neg/Impacts.cmir'),
    ];
    // "neg" lives only in the folder → both match (secondary-only tier).
    expect(
      searchFiles(files, 'neg')
        .map((f) => f.name)
        .sort(),
    ).toEqual(['Impacts', 'Warming DA']);
    // "neg warming": only Warming DA has warming in the NAME and neg in the folder.
    expect(searchFiles(files, 'neg warming').map((f) => f.name)).toEqual(['Warming DA']);
  });
});

describe('searchFiles — tiebreak', () => {
  const files = [
    file('Beta', 'Beta.cmir', 100),
    file('Alpha', 'Alpha.cmir', 300),
    file('Gamma', 'Gamma.cmir', 200),
  ];

  it('recency: most-recently-modified first (also the no-query browse order)', () => {
    expect(searchFiles(files, '', 'recency').map((f) => f.name)).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  it('alphabetical: by file name', () => {
    expect(searchFiles(files, '', 'alphabetical').map((f) => f.name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('breaks same-tier ties by the chosen order', () => {
    const fs = [
      file('Warming Alpha', 'Warming Alpha.cmir', 100),
      file('Warming Zeta', 'Warming Zeta.cmir', 300),
    ];
    // both prefix matches (tier 1) → the tiebreak decides
    expect(searchFiles(fs, 'warming', 'recency').map((f) => f.name)).toEqual([
      'Warming Zeta',
      'Warming Alpha',
    ]);
    expect(searchFiles(fs, 'warming', 'alphabetical').map((f) => f.name)).toEqual([
      'Warming Alpha',
      'Warming Zeta',
    ]);
  });
});

describe('searchFileObjects', () => {
  const objs: FileObject[] = [
    { kind: 'block', label: 'Warming Bad', detail: '', from: 0, to: 0 },
    { kind: 'tag', label: 'Smith says warming is bad', detail: '', from: 0, to: 0 },
    { kind: 'cite', label: 'Jones 24', detail: 'Heg key', from: 0, to: 0 },
  ];
  it('matches on label across kinds', () => {
    expect(searchFileObjects(objs, 'warming').map((o) => o.kind)).toEqual(['block', 'tag']);
  });
  it('empty query returns all', () => {
    expect(searchFileObjects(objs, '').length).toBe(3);
  });
  it('matches a tag by its card cite, not just its label', () => {
    const withCite: FileObject[] = [
      { kind: 'tag', label: 'Heg good', detail: '', cite: 'Brooks 24', from: 0, to: 0 },
    ];
    // Query is only in the cite, not the tag label.
    expect(searchFileObjects(withCite, 'brooks').map((o) => o.label)).toEqual(['Heg good']);
  });

  it('a label hit outranks a cite-only hit', () => {
    const mixed: FileObject[] = [
      { kind: 'tag', label: 'Heg good', detail: '', cite: 'Warming 24', from: 0, to: 0 }, // cite-only
      { kind: 'block', label: 'Warming Bad', detail: '', from: 0, to: 0 }, // label prefix
    ];
    expect(searchFileObjects(mixed, 'warming').map((o) => o.label)).toEqual([
      'Warming Bad',
      'Heg good',
    ]);
  });

  it('keeps same-tier matches in document (input) order', () => {
    const objs: FileObject[] = [
      { kind: 'tag', label: 'Warming second', detail: '', from: 10, to: 20 },
      { kind: 'tag', label: 'Warming first', detail: '', from: 0, to: 5 },
    ];
    // both prefix matches (tier 1) → preserve input order, never re-sorted
    expect(searchFileObjects(objs, 'warming').map((o) => o.label)).toEqual([
      'Warming second',
      'Warming first',
    ]);
  });
});

// ── Object extraction ───────────────────────────────────────────────

function citePara(...runs: { text: string; cite?: boolean }[]) {
  const inline = runs.map((r) =>
    schema.text(r.text, r.cite ? [schema.marks['cite_mark']!.create()] : []),
  );
  return schema.nodes['cite_paragraph']!.create(null, inline);
}

function block(text: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}

function card(tagText: string, cite: ReturnType<typeof citePara>) {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
    cite,
  ]);
}

function cardBody(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}

function analyticUnit(heading: string, bodyText: string) {
  return schema.nodes['analytic_unit']!.createChecked(null, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(heading)),
    cardBody(bodyText),
  ]);
}

function sampleDoc() {
  return schema.nodes['doc']!.createChecked(null, [
    block('Warming Bad'),
    card('Smith says X', citePara({ text: 'Smith 23', cite: true })),
  ]);
}

const enabled = (...k: FileObjectKind[]) => new Set<FileObjectKind>(k);

describe('extractFile — objects', () => {
  it('surfaces block, tag, and cite by default', () => {
    const { objects } = extractFile(sampleDoc(), enabled('block', 'tag', 'cite'));
    const byKind = (k: FileObjectKind) => objects.filter((o) => o.kind === k).map((o) => o.label);
    expect(byKind('block')).toEqual(['Warming Bad']);
    expect(byKind('tag')).toEqual(['Smith says X']);
    expect(byKind('cite')).toEqual(['Smith 23']);
  });

  it('the cite object carries its owning tag as detail', () => {
    const cite = extractFile(sampleDoc(), enabled('cite')).objects.find((o) => o.kind === 'cite');
    expect(cite?.detail).toBe('Smith says X');
  });

  it('the tag object carries its card cite — even when the cite KIND is off', () => {
    // `enabled('tag')` only: no standalone CITE rows, but the tag still
    // carries its citation so it stays findable by it.
    const tag = extractFile(sampleDoc(), enabled('tag')).objects.find((o) => o.kind === 'tag');
    expect(tag?.cite).toBe('Smith 23');
  });

  it('a tag is searchable by its cite with the cite kind off', () => {
    const { objects } = extractFile(sampleDoc(), enabled('tag'));
    // "23" appears only in the cite (Smith 23), not the label (Smith says X).
    expect(searchFileObjects(objects, '23').map((o) => o.label)).toEqual(['Smith says X']);
  });

  it('respects the enabled set', () => {
    const { objects } = extractFile(sampleDoc(), enabled('tag'));
    expect(objects.map((o) => o.kind)).toEqual(['tag']);
  });

  it('empty enabled set yields no objects', () => {
    expect(extractFile(sampleDoc(), enabled()).objects).toEqual([]);
  });

  it('every object carries a valid insert range', () => {
    const { objects } = extractFile(sampleDoc(), enabled('block', 'tag', 'cite'));
    for (const o of objects) {
      expect(Number.isFinite(o.from)).toBe(true);
      expect(o.to).toBeGreaterThanOrEqual(o.from);
    }
  });
});

describe('extractFile — outline', () => {
  it('returns the full structural hierarchy with levels, regardless of enabled', () => {
    const { outline } = extractFile(sampleDoc(), enabled()); // nothing enabled for search
    expect(outline.map((o) => [o.kind, o.level, o.label])).toEqual([
      ['block', 3, 'Warming Bad'],
      ['tag', 4, 'Smith says X'],
    ]);
  });

  it('never includes cites (not headings)', () => {
    const { outline } = extractFile(sampleDoc(), enabled('cite'));
    expect(outline.some((o) => o.kind === 'cite')).toBe(false);
  });
});

// In-file object search has full .docx parity because the dive parses .docx
// (via `fromDocx`, which calls `importDoc`) into the SAME schema as .cmir, and
// `extractFile` works off that doc. This guards that a docx-imported doc is
// searchable just like the hand-built ones above.
describe('extractFile — parity with .docx-imported docs', () => {
  function bodyXml(inner: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
  }

  it('surfaces block / tag / cite objects from a doc imported from docx XML', () => {
    const doc = importDoc(
      bodyXml(`
        <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Warming Bad</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Smith says X</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rStyle w:val="Style13ptBold"/></w:rPr><w:t>Smith 23</w:t></w:r></w:p>
      `),
    );
    const { objects } = extractFile(doc, enabled('block', 'tag', 'cite'));
    const byKind = (k: FileObjectKind) => objects.filter((o) => o.kind === k).map((o) => o.label);
    expect(byKind('block')).toEqual(['Warming Bad']);
    expect(byKind('tag')).toEqual(['Smith says X']);
    expect(byKind('cite')).toEqual(['Smith 23']);
    // And the tag is findable by its card's cite, same as .cmir.
    expect(searchFileObjects(objects, '23').map((o) => o.kind)).toContain('tag');
  });
});

describe('searchEvidenceRows', () => {
  function sampleEvidenceDoc() {
    return schema.nodes['doc']!.createChecked(null, [
      block('Single-Payer Costs'),
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Healthcare spending crowds out R&D')),
        citePara({ text: 'Smith 23', cite: true }),
        cardBody('National health expenditures crowd out discretionary federal spending.'),
      ]),
      analyticUnit('Internal link turn', 'Labor market liquidity is the unique internal-link story.'),
    ]);
  }

  it('indexes all evidence text with stable descriptors for opening results in context', () => {
    type EvidenceModule = typeof fileSearchModule & {
      extractEvidenceRows?: unknown;
      searchEvidenceRows?: unknown;
    };
    const mod = fileSearchModule as EvidenceModule;
    expect(typeof mod.extractEvidenceRows).toBe('function');
    expect(typeof mod.searchEvidenceRows).toBe('function');

    const rows = (mod.extractEvidenceRows as Function)(
      sampleEvidenceDoc(),
      file('Single-Payer 1AC', 'Aff/Single-Payer 1AC.docx', 10),
    );
    expect(rows.map((row: { kind: string }) => row.kind)).toEqual([
      'block',
      'tag',
      'cite',
      'body',
      'analytic',
      'body',
    ]);

    const results = (mod.searchEvidenceRows as Function)(rows, 'discretionary spending');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'body',
      filePath: '/root/Aff/Single-Payer 1AC.docx',
      fileName: 'Single-Payer 1AC',
    });
    expect(results[0].snippet).toContain('discretionary federal spending');
    expect(results[0].anchor.quote).toContain('discretionary federal spending');

    expect((mod.searchEvidenceRows as Function)(rows, 'smith 23')[0].kind).toBe('cite');
    expect((mod.searchEvidenceRows as Function)(rows, 'internal link')[0].kind).toBe('analytic');
    expect((mod.searchEvidenceRows as Function)(rows, 'healthcare spending')[0].kind).toBe('tag');
  });

  it('caches textLower on the row after the first search instead of recomputing it every query', () => {
    // REGRESSION: extractEvidenceRows deliberately leaves textLower unset
    // (slimmer rows, 2026-07-20); if the search loop stopped memoizing it
    // back onto the row, every keystroke would re-lowercase every scanned
    // row's full text forever — the "kind of slow" field regression.
    const mod = fileSearchModule as typeof fileSearchModule & {
      extractEvidenceRows?: unknown;
      searchEvidenceRows?: unknown;
    };
    const rows = (mod.extractEvidenceRows as Function)(
      sampleEvidenceDoc(),
      file('Single-Payer 1AC', 'Aff/Single-Payer 1AC.docx', 10),
    ) as EvidenceSearchRow[];
    expect(rows[0]!.textLower).toBeUndefined();
    (mod.searchEvidenceRows as Function)(rows, 'discretionary spending');
    expect(rows.some((r) => r.textLower !== undefined)).toBe(true);
  });

  it('spans a multi-word snippet across all matched tokens, not just the first', () => {
    // REGRESSION: snippetFor used to center on the first QUERY token found in
    // the row's own text and ignore the rest, so a two-word match could read
    // as if only one word had been searched.
    const mod = fileSearchModule as typeof fileSearchModule & {
      extractEvidenceRows?: unknown;
      searchEvidenceRows?: unknown;
    };
    const rows = (mod.extractEvidenceRows as Function)(
      sampleEvidenceDoc(),
      file('Single-Payer 1AC', 'Aff/Single-Payer 1AC.docx', 10),
    ) as EvidenceSearchRow[];
    const results = (mod.searchEvidenceRows as Function)(rows, 'national discretionary') as EvidenceSearchRow[];
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet).toContain('National');
    expect(results[0]!.snippet).toContain('discretionary');
  });

  it('caps body rows per file but keeps every structural row (so big files cannot starve the budget)', () => {
    // A single huge backfile must not fill the global row budget with its
    // hundreds of long card bodies and crowd later files out of the index
    // ("doesn't go through everything", field 2026-07-20). Bodies are capped
    // per file; tags/cites (the primary search targets) are always kept.
    const cards = Array.from({ length: 120 }, (_u, i) =>
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(`Tag number ${i}`)),
        citePara({ text: `Author ${i} 24`, cite: true }),
        cardBody(`Body evidence paragraph number ${i} with distinct words token${i}.`),
      ]),
    );
    const doc = schema.nodes['doc']!.createChecked(null, [block('Huge Backfile'), ...cards]);
    const mod = fileSearchModule as typeof fileSearchModule & { extractEvidenceRows?: unknown };
    const rows = (mod.extractEvidenceRows as Function)(
      doc,
      file('Huge Backfile', 'Neg/Huge Backfile.cmir', 10),
    ) as EvidenceSearchRow[];

    const byKind = (k: string): number => rows.filter((r) => r.kind === k).length;
    // All 120 tags and 120 cites survive (structural rows are never capped).
    expect(byKind('tag')).toBe(120);
    expect(byKind('cite')).toBe(120);
    // Bodies are bounded to the per-file cap (80), not all 120.
    expect(byKind('body')).toBe(80);
  });

  it('uses cached lowercase evidence search text when present', () => {
    type EvidenceModule = typeof fileSearchModule & {
      extractEvidenceRows?: unknown;
      searchEvidenceRows?: unknown;
    };
    const mod = fileSearchModule as EvidenceModule;
    const [row] = (mod.extractEvidenceRows as Function)(
      sampleEvidenceDoc(),
      file('Single-Payer 1AC', 'Aff/Single-Payer 1AC.docx', 10),
    );

    const cached = {
      ...row,
      text: 'No Match',
      label: 'No Match',
      fileName: 'No Match',
      relPath: 'No/Match.cmir',
      searchText: 'cached evidence key',
    };

    expect((mod.searchEvidenceRows as Function)([cached], 'cached key')).toHaveLength(1);
  });

  it('bounds broad evidence searches before building snippets', () => {
    type EvidenceModule = typeof fileSearchModule & {
      searchEvidenceRows?: unknown;
    };
    const mod = fileSearchModule as EvidenceModule;
    const rows = Array.from({ length: 500 }, (_, index) => ({
      kind: 'body',
      filePath: `/root/file-${index}.cmir`,
      fileName: `file-${index}`,
      relPath: `file-${index}.cmir`,
      mtimeMs: index,
      label: `Evidence ${index}`,
      text: `alpha evidence text ${index}`,
      snippet: `alpha evidence text ${index}`,
      anchor: { quote: `alpha evidence text ${index}`, prefix: '', suffix: '', approxPos: index },
      from: index,
      to: index + 1,
      searchText: `alpha evidence text ${index}`,
    }));

    const results = (mod.searchEvidenceRows as Function)(rows, 'alpha', 25);

    expect(results).toHaveLength(25);
    expect(results[0].snippet).toContain('alpha');
  });

  it('can stop evidence searches before touching rows past the scan budget', () => {
    type EvidenceModule = typeof fileSearchModule & {
      searchEvidenceRows?: unknown;
    };
    const mod = fileSearchModule as EvidenceModule;
    const safeRows = Array.from({ length: 25 }, (_, index) => ({
      kind: 'body',
      filePath: `/root/file-${index}.cmir`,
      fileName: `file-${index}`,
      relPath: `file-${index}.cmir`,
      mtimeMs: index,
      label: `Evidence ${index}`,
      text: `alpha evidence text ${index}`,
      snippet: `alpha evidence text ${index}`,
      anchor: { quote: `alpha evidence text ${index}`, prefix: '', suffix: '', approxPos: index },
      from: index,
      to: index + 1,
      searchText: `alpha evidence text ${index}`,
    }));
    const rowPastBudget = {
      kind: 'body',
      filePath: '/root/late.cmir',
      fileName: 'late',
      relPath: 'late.cmir',
      mtimeMs: 999,
      label: 'Late',
      text: 'alpha late',
      snippet: 'alpha late',
      anchor: { quote: 'alpha late' },
      from: 999,
      to: 1000,
      get searchText() {
        throw new Error('row past budget was scanned');
      },
    };

    const results = (mod.searchEvidenceRows as Function)(
      [...safeRows, rowPastBudget],
      'alpha',
      10,
      25,
    );

    expect(results).toHaveLength(10);
    expect(results.every((row: { fileName: string }) => row.fileName !== 'late')).toBe(true);
  });

  it('can search evidence rows asynchronously in chunks', async () => {
    type EvidenceModule = typeof fileSearchModule & {
      searchEvidenceRowsAsync?: unknown;
    };
    const mod = fileSearchModule as EvidenceModule;
    expect(typeof mod.searchEvidenceRowsAsync).toBe('function');
    const rows: EvidenceSearchRow[] = Array.from({ length: 80 }, (_, index) => ({
      kind: 'body',
      filePath: `/root/file-${index}.cmir`,
      fileName: `file-${index}`,
      relPath: `file-${index}.cmir`,
      mtimeMs: index,
      label: `Evidence ${index}`,
      text: `alpha evidence text ${index}`,
      snippet: `alpha evidence text ${index}`,
      anchor: { quote: `alpha evidence text ${index}`, prefix: '', suffix: '', approxPos: index },
      from: index,
      to: index + 1,
      searchText: `alpha evidence text ${index}`,
    }));
    let yields = 0;

    const results = await (mod.searchEvidenceRowsAsync as Function)(rows, 'alpha', {
      limit: 12,
      maxScannedRows: 80,
      chunkSize: 20,
      yieldNow: async () => {
        yields += 1;
      },
    });
    const expected = (fileSearchModule as EvidenceModule & { searchEvidenceRows: Function }).searchEvidenceRows(
      rows,
      'alpha',
      12,
      80,
    );

    expect(results).toEqual(expected);
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it('cancels stale asynchronous evidence searches between chunks', async () => {
    type EvidenceModule = typeof fileSearchModule & {
      searchEvidenceRowsAsync?: unknown;
    };
    const mod = fileSearchModule as EvidenceModule;
    expect(typeof mod.searchEvidenceRowsAsync).toBe('function');
    const rows: EvidenceSearchRow[] = Array.from({ length: 100 }, (_, index) => ({
      kind: 'body',
      filePath: `/root/file-${index}.cmir`,
      fileName: `file-${index}`,
      relPath: `file-${index}.cmir`,
      mtimeMs: index,
      label: `Evidence ${index}`,
      text: `alpha evidence text ${index}`,
      snippet: `alpha evidence text ${index}`,
      anchor: { quote: `alpha evidence text ${index}`, prefix: '', suffix: '', approxPos: index },
      from: index,
      to: index + 1,
      searchText: `alpha evidence text ${index}`,
    }));
    const controller = new AbortController();

    const promise = (mod.searchEvidenceRowsAsync as Function)(rows, 'alpha', {
      limit: 12,
      maxScannedRows: 100,
      chunkSize: 10,
      signal: controller.signal,
      yieldNow: async () => {
        controller.abort();
      },
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
