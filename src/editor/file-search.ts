/**
 * Command-palette file search (the `f` prefix) — pure logic.
 *
 * Two layers, both on-demand (no persistent index yet; see
 * ARCHITECTURE.md §11 "corpus search"):
 *   1. File layer  — match `.cmir` filenames recursively found under
 *      the configured search root (the palette does the I/O).
 *   2. Object layer — once a file is picked, parse it and surface its
 *      structural objects (blocks / tags / cites / …) so the user can
 *      search WITHIN it and insert one. Each object carries the doc
 *      slice that gets inserted, mirroring quick cards / dropzone.
 *
 * Matching is the same order-independent multi-token substring AND
 * ranking the rest of the palette uses (see quick-cards-match.ts) —
 * "block search style", not edit-distance fuzz.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { collectHeadings, computeHeadingRange } from './headings.js';
import { buildDescriptorIn, flattenDoc, type AnchorDescriptor } from './learn-anchor.js';

/** Structural object kinds that can appear in within-file results. */
export type FileObjectKind = 'pocket' | 'hat' | 'block' | 'tag' | 'cite' | 'analytic';

/** All kinds, in outline order — the order the settings checklist
 *  shows them and the order results group in. */
export const FILE_OBJECT_KINDS: FileObjectKind[] = [
  'pocket',
  'hat',
  'block',
  'tag',
  'cite',
  'analytic',
];

export const FILE_OBJECT_KIND_LABELS: Record<FileObjectKind, string> = {
  pocket: 'Pocket',
  hat: 'Hat',
  block: 'Block',
  tag: 'Tag',
  cite: 'Cite',
  analytic: 'Analytic',
};

/** Short badge text shown on a within-file result row. */
export const FILE_OBJECT_KIND_BADGES: Record<FileObjectKind, string> = {
  pocket: 'POC',
  hat: 'HAT',
  block: 'BLK',
  tag: 'TAG',
  cite: 'CITE',
  analytic: 'ANL',
};

export type OpenableFileFormat = 'cmir' | 'docx' | 'cmflow';

/** An openable file discovered under the search root. */
export interface FileEntry {
  /** Absolute path (open target). */
  path: string;
  /** Path relative to the search root (for the dir hint). */
  relPath: string;
  /** Bare filename (the match + display target). */
  name: string;
  /** Last-modified time — the version key for the warm cache. */
  mtimeMs: number;
  /** On-disk size when the lister provided it — the evidence indexer skips
   *  pathological giants instead of reading them into renderer memory. */
  size?: number;
  /** Optional pre-lowercased combined search text for hot search paths. */
  searchText?: string;
}

/** A structural object inside a parsed file — a search hit (flat). */
export interface FileObject {
  kind: FileObjectKind;
  /** Match + display text (heading text, or the cite string). */
  label: string;
  /** Secondary text — the owning tag for a cite, else ''. */
  detail: string;
  /** For a `tag` object, the cite text of its card (author/date), so a
   *  tag is findable by its citation — mirrors Ctrl-F, which can match
   *  a tag's card via the cite_paragraph. Used for matching AND shown
   *  as the row's secondary text. Undefined when the card has no cite. */
  cite?: string;
  /** Doc range to slice on insert. Sliced lazily from the kept parsed
   *  doc (the palette holds it for the dive), so a dive never eagerly
   *  builds or holds a slice for every object. */
  from: number;
  to: number;
}

/** One row of a file's outline (the nav-pane-style browse) — the full
 *  structural hierarchy, indented by `level`. Cites are not headings, so
 *  they never appear here; they only surface when you type a query. */
export interface OutlineEntry {
  /** 1 Pocket · 2 Hat · 3 Block · 4 Tag/Analytic. */
  level: number;
  kind: FileObjectKind;
  label: string;
  from: number;
  to: number;
}

export type EvidenceRowKind =
  | FileObjectKind
  | 'body'
  | 'undertag'
  | 'paragraph';

export interface EvidenceSearchRow {
  kind: EvidenceRowKind;
  /** Absolute path to open. */
  filePath: string;
  /** Display filename without openable extension. */
  fileName: string;
  relPath: string;
  mtimeMs: number;
  /** Nearest structural label for display/ranking. */
  label: string;
  /** The indexed textblock text. */
  text: string;
  /** Short preview centered around the query match. */
  snippet: string;
  /** Text descriptor used after opening to select and scroll to the result. */
  anchor: AnchorDescriptor;
  from: number;
  to: number;
  /** Optional pre-lowercased primary text for hot search paths. */
  textLower?: string;
  /** Optional pre-lowercased combined search text for hot search paths. */
  searchText?: string;
}

/** Bare filename from a path/relPath (handles `/` and `\`). */
export function baseName(p: string): string {
  const m = p.split(/[\\/]/);
  return m[m.length - 1] ?? p;
}

/** Openable format of a listed file, by extension. Anything not explicitly
 *  recognized keeps the legacy behavior and is treated as `cmir`. */
export function fileFormat(pathOrName: string): OpenableFileFormat {
  if (/\.docx$/i.test(pathOrName)) return 'docx';
  if (/\.cmflow$/i.test(pathOrName)) return 'cmflow';
  return 'cmir';
}

/** Display name for a listed file: the openable extension
 *  stripped, since the result row badges the format separately. Other dots
 *  in the name are left intact. */
export function stripFileExt(name: string): string {
  return name.replace(/\.(cmir|docx|cmflow)$/i, '');
}

/** Directory portion of a relPath ('' for a top-level file). */
export function dirName(relPath: string): string {
  const i = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  return i < 0 ? '' : relPath.slice(0, i);
}

export function fileSearchText(f: FileEntry): string {
  return f.searchText ?? `${f.name.toLowerCase()} ${dirName(f.relPath).toLowerCase()}`;
}

export function evidenceSearchText(row: EvidenceSearchRow): string {
  return (
    row.searchText ??
    `${row.text.toLowerCase()} ${row.label.toLowerCase()} ${row.fileName.toLowerCase()} ${dirName(row.relPath).toLowerCase()}`
  );
}

/** Does `tok` begin at a word boundary anywhere in `text` (both lowercased)?
 *  "war" is a word-start of "at: warming" but not of "software". */
function startsAtWordBoundary(text: string, tok: string): boolean {
  for (let i = text.indexOf(tok); i >= 0; i = text.indexOf(tok, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(text[i - 1]!)) return true;
  }
  return false;
}

/** Relevance tier for a candidate, or null when it doesn't match every token.
 *  Lower is better. Tiers key off the PRIMARY field (a heading's label, a
 *  file's name); a match that only lands in the SECONDARY field (a card's cite,
 *  a file's folder) is the weakest tier, so a primary hit always outranks it.
 *    0 exact · 1 prefix · 2 word-start · 3 substring · 4 secondary-only */
function matchTier(
  primary: string,
  secondary: string,
  tokens: readonly string[],
  q: string,
  t0: string,
): number | null {
  return matchTierLower(primary.toLowerCase(), secondary.toLowerCase(), tokens, q, t0);
}

function matchTierLower(
  primaryLower: string,
  secondaryLower: string,
  tokens: readonly string[],
  q: string,
  t0: string,
): number | null {
  const p = primaryLower;
  const hay = secondaryLower ? `${p} ${secondaryLower}` : p;
  if (!tokens.every((tok) => hay.includes(tok))) return null;
  if (p === q) return 0;
  if (p.startsWith(q)) return 1;
  if (tokens.every((tok) => p.includes(tok))) return startsAtWordBoundary(p, t0) ? 2 : 3;
  return 4;
}

/** Order-independent multi-token AND-match, ranked by relevance tier
 *  (exact → prefix → word-start → substring → secondary-only), ties broken by
 *  `tiebreak`. A stable no-op tiebreak (`() => 0`) preserves input order. An
 *  empty query returns everything, ordered only by the tiebreak. */
function rank<T>(
  items: readonly T[],
  query: string,
  primary: (t: T) => string,
  secondary: (t: T) => string,
  tiebreak: (a: T, b: T) => number,
  primaryLower?: (t: T) => string,
  secondaryLower?: (t: T) => string,
): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items].sort(tiebreak);
  const q = tokens.join(' ');
  const t0 = tokens[0]!;
  return items
    .map((item) => ({
      item,
      tier:
        primaryLower || secondaryLower
          ? matchTierLower(
              primaryLower ? primaryLower(item) : primary(item).toLowerCase(),
              secondaryLower ? secondaryLower(item) : secondary(item).toLowerCase(),
              tokens,
              q,
              t0,
            )
          : matchTier(primary(item), secondary(item), tokens, q, t0),
    }))
    .filter((r): r is { item: T; tier: number } => r.tier !== null)
    .sort((a, b) => a.tier - b.tier || tiebreak(a.item, b.item))
    .map((r) => r.item);
}

/** Same-tier ordering for the file search (the setting the user picks). */
export type FileTiebreak = 'recency' | 'alphabetical';

export function searchFiles(
  files: readonly FileEntry[],
  query: string,
  tiebreak: FileTiebreak = 'recency',
): FileEntry[] {
  // Match the bare name first; the folder (from relPath) is the secondary
  // field, so "neg warming" finds Neg/Warming DA — ranked below a name hit.
  const cmp: (a: FileEntry, b: FileEntry) => number =
    tiebreak === 'alphabetical'
      ? (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      : (a, b) => b.mtimeMs - a.mtimeMs; // recency: most-recently-modified first
  return rank(
    files,
    query,
    (f) => f.name,
    (f) => dirName(f.relPath),
    cmp,
    (f) => f.name.toLowerCase(),
    (f) => fileSearchText(f),
  );
}

export function searchFileObjects(objects: readonly FileObject[], query: string): FileObject[] {
  // Match a tag by its label OR its card's cite text (author/date); the cite is
  // the secondary field, so a label hit outranks a cite-only hit. Same-tier
  // ties stay in document order (stable no-op tiebreak).
  return rank(
    objects,
    query,
    (o) => o.label,
    (o) => o.cite ?? '',
    () => 0,
  );
}

function evidenceKindForNode(type: string): EvidenceRowKind | null {
  if (
    type === 'pocket' ||
    type === 'hat' ||
    type === 'block' ||
    type === 'tag' ||
    type === 'analytic'
  ) {
    return type;
  }
  if (type === 'cite_paragraph') return 'cite';
  if (type === 'card_body') return 'body';
  if (type === 'undertag') return 'undertag';
  if (type === 'paragraph') return 'paragraph';
  return null;
}

/** Preview window centered on the match. A row can qualify via a SECONDARY
 *  field (label/filename/folder) that isn't in `text` at all, so not every
 *  token is guaranteed to appear here — but when several ARE, the window
 *  spans from the earliest to the latest hit instead of just the first
 *  query token, so a multi-word match doesn't read as if only one word had
 *  been searched. */
function snippetFor(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = tokens
    .map((tok) => ({ tok, at: lower.indexOf(tok) }))
    .filter((h) => h.at >= 0);
  if (hits.length === 0) return clean.length > 150 ? `${clean.slice(0, 147)}...` : clean;
  const firstAt = Math.min(...hits.map((h) => h.at));
  const lastHit = hits.reduce((a, b) => (b.at > a.at ? b : a));
  const lastEnd = lastHit.at + Math.max(lastHit.tok.length, 1);
  const from = Math.max(0, firstAt - 52);
  const to = Math.min(clean.length, Math.max(firstAt + 90, lastEnd + 20));
  const prefix = from > 0 ? '...' : '';
  const suffix = to < clean.length ? '...' : '';
  return `${prefix}${clean.slice(from, to)}${suffix}`;
}

/** Cap on the stored `anchor.quote` for an evidence row. A card body can run
 *  thousands of chars; without a cap the quote silently duplicates the row's
 *  full text a second time (the anchor's prefix/suffix context is already
 *  enough to relocate it uniquely). See `buildDescriptorIn` in
 *  learn-anchor.ts. */
const EVIDENCE_ANCHOR_MAX_QUOTE = 400;

/** Per-file cap on the memory-heavy full-body rows (`body` / `paragraph`).
 *  EVERY structural row (pocket/hat/block/tag/cite/analytic/undertag) is
 *  always kept — those are short and are what users actually search (tag
 *  text, author/date cites) — but a single huge backfile can hold hundreds
 *  of long card bodies. Without a per-file cap those early giant files fill
 *  the global row budget (EVIDENCE_MAX_TOTAL_ROWS) before the walk ever
 *  reaches later files, so the tail of the library becomes unsearchable —
 *  the "doesn't go through everything" report (field 2026-07-20). Capping
 *  bodies per file keeps every file represented under the same global
 *  budget; only the deep body text of unusually large files is trimmed
 *  (its tags/cites still index in full, and the on-disk cache is unchanged
 *  for the in-file dive). */
const EVIDENCE_MAX_BODY_ROWS_PER_FILE = 80;

/** Body-like kinds whose per-file count is bounded (the long, heavy rows). */
function isBodyEvidenceKind(kind: EvidenceRowKind): boolean {
  return kind === 'body' || kind === 'paragraph';
}

/** Full-text evidence index for the Search Evidence command.
 *  This walks every searchable textblock, not only headings, so body text,
 *  tags, analytics, and cite paragraphs all surface as openable results.
 *  Each row stores an AnchorDescriptor, allowing the opener to re-locate the
 *  text after a `.docx` import or small edits shift raw positions.
 *
 *  Rows deliberately leave `textLower` / `searchText` unset here: every
 *  producer (the index worker, the main-thread fallback, and cache
 *  hydration) already fills `searchText` via `??=` right after extraction,
 *  and `textLower` is filled lazily — memoized onto the row the first time
 *  a search actually scans it (see the `??=` in `searchEvidenceRows[Async]`),
 *  not recomputed every keystroke. A row never searched this session never
 *  pays for either field. Keeping the row itself minimal at rest is what
 *  lets a fixed row budget cover more of the corpus (slimmer-rows follow-up
 *  to field bug 2026-07-20). */
export function extractEvidenceRows(
  doc: PMNode,
  file: FileEntry,
): EvidenceSearchRow[] {
  const rows: EvidenceSearchRow[] = [];
  let currentStructuralLabel = '';
  let bodyRowCount = 0;
  // Flatten ONCE for the whole file. buildDescriptor() flattens internally,
  // so calling it per row was O(rows x docSize) — 102 s and 2.7 GB on a
  // single 0.5 MB debate file, which is what crashed Search Evidence
  // (field bug 2026-07-20).
  const flat = flattenDoc(doc);
  doc.descendants((node, pos) => {
    const kind = evidenceKindForNode(node.type.name);
    if (!kind || !node.isTextblock) return true;
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (text === '') return true;
    if (
      kind === 'pocket' ||
      kind === 'hat' ||
      kind === 'block' ||
      kind === 'tag' ||
      kind === 'analytic'
    ) {
      currentStructuralLabel = text;
    }
    // Bound the long body rows per file so one huge backfile can't crowd
    // later files out of the global row budget (see the constant's note).
    // `descendants` returning true still recurses into the skipped node's
    // children — but a card_body / paragraph textblock has only inline
    // content, so nothing searchable is lost by not emitting a row for it.
    if (isBodyEvidenceKind(kind)) {
      if (bodyRowCount >= EVIDENCE_MAX_BODY_ROWS_PER_FILE) return true;
      bodyRowCount += 1;
    }
    const from = pos + 1;
    const to = pos + 1 + node.content.size;
    const fileName = stripFileExt(baseName(file.name));
    const label = currentStructuralLabel || text;
    rows.push({
      kind,
      filePath: file.path,
      fileName,
      relPath: file.relPath,
      mtimeMs: file.mtimeMs,
      label,
      text,
      // Always overwritten with a trimmed snippetFor() result before a row
      // reaches the UI (both searchEvidenceRows branches do this) — storing
      // the full text here a second time would be pure waste.
      snippet: '',
      anchor: buildDescriptorIn(flat, from, to, EVIDENCE_ANCHOR_MAX_QUOTE),
      from,
      to,
    });
    return true;
  });
  return rows;
}

export function searchEvidenceRows(
  rows: readonly EvidenceSearchRow[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
  maxScannedRows = Number.POSITIVE_INFINITY,
): EvidenceSearchRow[] {
  const cmp = (a: EvidenceSearchRow, b: EvidenceSearchRow): number =>
    b.mtimeMs - a.mtimeMs || a.from - b.from;
  const finiteLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.POSITIVE_INFINITY;
  const scanLimit =
    Number.isFinite(maxScannedRows) && maxScannedRows >= 0
      ? Math.min(rows.length, Math.floor(maxScannedRows))
      : rows.length;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return rows
      .slice(0, scanLimit)
      .sort(cmp)
      .slice(0, finiteLimit)
      .map((row) => ({ ...row, snippet: snippetFor(row.text, query) }));
  }

  const q = tokens.join(' ');
  const t0 = tokens[0]!;
  const buckets: EvidenceSearchRow[][] = [[], [], [], [], []];
  const perTierLimit = Number.isFinite(finiteLimit) ? Math.max(finiteLimit * 4, finiteLimit) : Number.POSITIVE_INFINITY;
  for (let index = 0; index < scanLimit; index += 1) {
    const row = rows[index]!;
    // Cache the lowercase form on the row itself (once, ever): rows are kept
    // in memory across the whole session, so leaving this uncached made every
    // query re-lowercase every scanned row's full text — a real regression
    // once `extractEvidenceRows` stopped precomputing it up front (slimmer
    // rows, field bug 2026-07-20).
    const textLower = (row.textLower ??= row.text.toLowerCase());
    const tier = matchTierLower(textLower, evidenceSearchText(row), tokens, q, t0);
    if (tier === null) continue;
    const bucket = buckets[tier]!;
    if (bucket.length < perTierLimit) bucket.push(row);
  }

  const out: EvidenceSearchRow[] = [];
  for (const bucket of buckets) {
    bucket.sort(cmp);
    for (const row of bucket) {
      out.push({ ...row, snippet: snippetFor(row.text, query) });
      if (out.length >= finiteLimit) return out;
    }
  }
  return out;
}

export interface EvidenceSearchAsyncOptions {
  limit?: number;
  maxScannedRows?: number;
  chunkSize?: number;
  signal?: AbortSignal;
  yieldNow?: () => Promise<void>;
}

function evidenceAbortError(): Error {
  const err = new Error('Evidence search aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfEvidenceSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw evidenceAbortError();
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function searchEvidenceRowsAsync(
  rows: readonly EvidenceSearchRow[],
  query: string,
  opts: EvidenceSearchAsyncOptions = {},
): Promise<EvidenceSearchRow[]> {
  const cmp = (a: EvidenceSearchRow, b: EvidenceSearchRow): number =>
    b.mtimeMs - a.mtimeMs || a.from - b.from;
  const finiteLimit =
    Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0
      ? Math.floor(opts.limit!)
      : Number.POSITIVE_INFINITY;
  const scanLimit =
    Number.isFinite(opts.maxScannedRows) && (opts.maxScannedRows ?? 0) >= 0
      ? Math.min(rows.length, Math.floor(opts.maxScannedRows!))
      : rows.length;
  const chunkSize =
    Number.isFinite(opts.chunkSize) && (opts.chunkSize ?? 0) > 0
      ? Math.max(1, Math.floor(opts.chunkSize!))
      : 500;
  const yieldNow = opts.yieldNow ?? nextTurn;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  throwIfEvidenceSearchAborted(opts.signal);
  if (tokens.length === 0) {
    const scanned: EvidenceSearchRow[] = [];
    for (let index = 0; index < scanLimit; index += 1) {
      throwIfEvidenceSearchAborted(opts.signal);
      scanned.push(rows[index]!);
      if ((index + 1) % chunkSize === 0) {
        await yieldNow();
        throwIfEvidenceSearchAborted(opts.signal);
      }
    }
    return scanned
      .sort(cmp)
      .slice(0, finiteLimit)
      .map((row) => ({ ...row, snippet: snippetFor(row.text, query) }));
  }

  const q = tokens.join(' ');
  const t0 = tokens[0]!;
  const buckets: EvidenceSearchRow[][] = [[], [], [], [], []];
  const perTierLimit = Number.isFinite(finiteLimit)
    ? Math.max(finiteLimit * 4, finiteLimit)
    : Number.POSITIVE_INFINITY;
  for (let index = 0; index < scanLimit; index += 1) {
    throwIfEvidenceSearchAborted(opts.signal);
    const row = rows[index]!;
    const textLower = (row.textLower ??= row.text.toLowerCase());
    const tier = matchTierLower(textLower, evidenceSearchText(row), tokens, q, t0);
    if (tier !== null) {
      const bucket = buckets[tier]!;
      if (bucket.length < perTierLimit) bucket.push(row);
    }
    if ((index + 1) % chunkSize === 0) {
      await yieldNow();
      throwIfEvidenceSearchAborted(opts.signal);
    }
  }

  const out: EvidenceSearchRow[] = [];
  for (const bucket of buckets) {
    throwIfEvidenceSearchAborted(opts.signal);
    bucket.sort(cmp);
    for (const row of bucket) {
      out.push({ ...row, snippet: snippetFor(row.text, query) });
      if (out.length >= finiteLimit) return out;
    }
    await yieldNow();
    throwIfEvidenceSearchAborted(opts.signal);
  }
  return out;
}

/**
 * Walk a parsed `.cmir` doc once and produce both:
 *   - `objects`: the flat, searchable hits of the enabled kinds (+ cites)
 *   - `outline`: the full structural hierarchy for the nav-pane-style
 *     browse, every heading with its level (cites excluded — not headings)
 *
 * Each carries a doc range, not a materialized slice: the caller keeps
 * the parsed doc and slices on insert, so a dive doesn't build a slice
 * for every heading up front. Insertion granularity is whatever
 * `computeHeadingRange` returns:
 *   - tag / cite           → the enclosing card (tag + body)
 *   - block / hat / pocket  → the heading + everything under it
 *   - analytic              → the analytic unit / card
 *
 * Cites aren't a heading type: each tag entry carries the cite text of
 * its card, so a `cite` object piggybacks on the tag entry (same range).
 */
export function extractFile(
  doc: PMNode,
  enabled: ReadonlySet<FileObjectKind>,
): { objects: FileObject[]; outline: OutlineEntry[] } {
  const needCite = enabled.has('cite');
  // Always collect cite text: a tag is searchable by its cite even when
  // the standalone `cite` object kind is off (that only gates the
  // separate CITE rows below).
  const entries = collectHeadings(doc);
  const objects: FileObject[] = [];
  const outline: OutlineEntry[] = [];
  for (const entry of entries) {
    const kind = entry.type as FileObjectKind; // pocket/hat/block/tag/analytic
    const range = computeHeadingRange(doc, entry);
    if (!range) continue;
    const { from, to } = range;
    const label = entry.text.trim();
    // Outline: the full structure, independent of the enabled set.
    outline.push({ level: entry.level, kind, label, from, to });
    // Search hits: enabled kinds (with a label), plus cites.
    if (enabled.has(kind) && label !== '') {
      const obj: FileObject = { kind, label, detail: '', from, to };
      // Carry the card's cite on the tag so it's findable by citation.
      if (kind === 'tag' && entry.cite) obj.cite = entry.cite;
      objects.push(obj);
    }
    if (needCite && entry.type === 'tag' && entry.cite) {
      objects.push({ kind: 'cite', label: entry.cite.trim(), detail: label, from, to });
    }
  }
  return { objects, outline };
}
