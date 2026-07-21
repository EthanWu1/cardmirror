/**
 * Learn — anchor descriptors (pure; no DOM, no I/O).
 *
 * Local annotations (flashcards, AI threads) aren't stored in the file, so
 * they can't leave a `comment_range` mark to anchor on. Instead each carries
 * an `AnchorDescriptor` — the quoted text plus a little surrounding context
 * and a position hint — and we re-resolve it against the live document when
 * the comments column opens (SPEC-learn-system §4.2). Hypothesis-style:
 * survives position shifts, and even a Word round-trip, as long as the text
 * itself is intact.
 *
 * We work over a flattened text view of the doc (text nodes concatenated in
 * document order) with a parallel map from char offset → ProseMirror
 * position, so a found quote maps back to a real `{from, to}` range.
 */

import type { Node as PMNode } from 'prosemirror-model';

/** Chars of context captured on each side of a quote. Wide enough to
 *  disambiguate repeats AND to tell a real match (surroundings intact)
 *  from a coincidental hit on the quote substring after the original
 *  text was deleted/edited (see the context gate in `resolveDescriptor`). */
const CONTEXT = 60;

/** A candidate match must overlap the stored context by at least this
 *  fraction of what's available, or it's rejected (→ unanchored) rather
 *  than grounding the annotation onto unrelated text. A third tolerates
 *  heavy edits to one side (the other side alone clears the bar) while
 *  still rejecting a hit whose surroundings don't match at all. */
const MIN_CONTEXT_FRACTION = 1 / 3;

export interface AnchorDescriptor {
  quote: string;
  prefix: string;
  suffix: string;
  approxPos: number; // char offset of the quote start at descriptor time
}

export interface ResolveResult {
  from: number;
  to: number;
  /** True when the quote occurred more than once and we had to pick
   *  (by context, then nearest position) — surfaced so the UI can flag it. */
  ambiguous: boolean;
}

export interface Flat {
  text: string;
  /** `pos[i]` = the ProseMirror position immediately before flat char i. */
  pos: number[];
}

/** Flatten a doc to a text view + char→PM-position map. Walking the whole
 *  doc is O(doc), so callers that resolve many descriptors at once should
 *  flatten ONCE and reuse via `resolveDescriptorIn`, rather than calling
 *  `resolveDescriptor` (which flattens) per descriptor. */
export function flattenDoc(doc: PMNode): Flat {
  return flatten(doc);
}

/** Object Replacement Character — the standard stand-in for an embedded
 *  object in a text stream. We emit one (plus a short content fingerprint)
 *  for each image so annotations anchor to images exactly like text:
 *  the image becomes one token in the flattened stream, found by content
 *  and disambiguated by surrounding context (identical images fall back to
 *  context, just like a repeated phrase). */
const OBJ = '￼';

/** Stable, cheap fingerprint of an image's content so two *different*
 *  images get different sentinels. Samples bounded slices of the (possibly
 *  huge) base64 payload so flatten stays O(doc), not O(image bytes).
 *  Collisions just fall back to context disambiguation. FNV-1a → base36. */
function imageFingerprint(node: PMNode): string {
  const data = typeof node.attrs['data'] === 'string' ? (node.attrs['data'] as string) : '';
  const sample = `${data.length}|${data.slice(0, 200)}|${data.slice(-200)}|${String(node.attrs['contentType'] ?? '')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function flatten(doc: PMNode): Flat {
  // Collect whole runs and join once: appending char-by-char built a rope of
  // one node per character, which dominated flatten's cost on big documents.
  const parts: string[] = [];
  const pos: number[] = [];
  doc.descendants((node, p) => {
    if (node.isText) {
      const t = node.text ?? '';
      parts.push(t);
      for (let i = 0; i < t.length; i++) pos.push(p + i);
    } else if (node.type.name === 'image') {
      // Emit a sentinel token for the image; every char maps to the
      // image's own position, so a quote of just the sentinel resolves to
      // the image's [p, p+1) range.
      const s = OBJ + imageFingerprint(node);
      parts.push(s);
      for (let i = 0; i < s.length; i++) pos.push(p);
    }
    return true;
  });
  return { text: parts.join(''), pos };
}

/** PM position just after flat char `idx-1` (i.e. the right edge of the
 *  quote ending at idx). */
function endPos(flat: Flat, idx: number): number {
  if (idx < flat.pos.length) return flat.pos[idx]!; // left edge of next char
  // Quote runs to the last char: its right edge is one past the last left.
  return (flat.pos[flat.pos.length - 1] ?? 0) + 1;
}

/** Build a descriptor for the selection `[from, to)` in `doc`. */
/** First flat index whose PM position is >= `target`, or `pos.length` when
 *  none is. `pos` is ascending, so this is a binary search — the old linear
 *  `findIndex` made bulk descriptor building O(rows x docSize). */
function firstIndexAtOrAfter(pos: readonly number[], target: number): number {
  let lo = 0;
  let hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid]! >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Build a descriptor against an ALREADY-FLATTENED doc.
 *
 *  Use this whenever building many descriptors for one document: `flatten`
 *  walks the whole doc and allocates a full text string plus a
 *  position-per-character array, so calling `buildDescriptor` per row is
 *  O(rows x docSize) in both time and memory. Indexing one 0.5 MB debate
 *  file that way took 102 s and 2.7 GB — the Search Evidence crash (field
 *  bug 2026-07-20). Flatten once, then call this per range.
 *
 *  `maxQuoteLen` bounds the stored quote (unbounded by default, for the
 *  single-selection callers below). The bulk evidence indexer passes a cap:
 *  a card body can run thousands of chars, and without a cap the quote
 *  duplicates the row's full text a second time in memory — the dominant
 *  cost in the "11 KB/row" evidence-index budget (field bug 2026-07-20,
 *  slimmer-rows follow-up). The stored prefix/suffix context is enough to
 *  relocate the passage uniquely even with a short quote; re-opening a
 *  capped row selects the first `maxQuoteLen` chars of it rather than the
 *  whole block. */
export function buildDescriptorIn(
  flat: Flat,
  from: number,
  to: number,
  maxQuoteLen = Number.POSITIVE_INFINITY,
): AnchorDescriptor {
  let start = firstIndexAtOrAfter(flat.pos, from);
  if (start >= flat.pos.length) start = flat.text.length;
  let end = firstIndexAtOrAfter(flat.pos, to);
  if (end >= flat.pos.length) end = flat.text.length;
  if (end - start > maxQuoteLen) end = start + maxQuoteLen;
  return {
    quote: flat.text.slice(start, end),
    prefix: flat.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: flat.text.slice(end, end + CONTEXT),
    approxPos: start,
  };
}

/** Single-shot descriptor for one range (a user selection). Flattens the doc;
 *  for bulk use `flattenDoc` + `buildDescriptorIn`. */
export function buildDescriptor(doc: PMNode, from: number, to: number): AnchorDescriptor {
  return buildDescriptorIn(flatten(doc), from, to);
}

/** Length of the common suffix of `a` and the trailing of `b` (how well a
 *  candidate's preceding text matches the stored prefix). */
function backMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of `a` and `b`. */
function frontMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Re-resolve a descriptor against `doc`. Returns the matched range, or
 * `null` if the quote no longer occurs OR the best occurrence's
 * surroundings don't match the stored context (both are "broken
 * grounding" — the annotation goes to the Unanchored list with a
 * Re-ground action rather than silently grounding onto unrelated text).
 * Multiple matches are disambiguated by surrounding-context match, then by
 * nearest position to `approxPos`; ties set `ambiguous`.
 */
export function resolveDescriptor(doc: PMNode, d: AnchorDescriptor): ResolveResult | null {
  return resolveDescriptorIn(flatten(doc), d);
}

/** Resolve a descriptor against an ALREADY-flattened doc. Use this when
 *  resolving several descriptors against the same doc so the O(doc)
 *  flatten happens once, not per descriptor. */
export function resolveDescriptorIn(flat: Flat, d: AnchorDescriptor): ResolveResult | null {
  if (d.quote === '') return null;
  const hits: number[] = [];
  for (let i = flat.text.indexOf(d.quote); i >= 0; i = flat.text.indexOf(d.quote, i + 1)) {
    hits.push(i);
  }
  if (hits.length === 0) return null;

  // Score EVERY hit (even a lone one) by how well its surroundings match
  // the stored context, then pick the best, breaking ties by nearest
  // position. Scoring the single-hit case too is what lets the context
  // gate below reject a coincidental substring match.
  const scored = hits.map((i) => {
    const before = flat.text.slice(Math.max(0, i - CONTEXT), i);
    const after = flat.text.slice(i + d.quote.length, i + d.quote.length + CONTEXT);
    const context = backMatch(before, d.prefix) + frontMatch(after, d.suffix);
    return { i, context, dist: Math.abs(i - d.approxPos) };
  });
  scored.sort((a, b) => b.context - a.context || a.dist - b.dist);
  const best = scored[0]!;

  // Context gate: require the best match to overlap the stored context by
  // at least MIN_CONTEXT_FRACTION of what's available. After the anchored
  // text is deleted, the quote may still occur elsewhere with totally
  // unrelated surroundings (context ≈ 0) — grounding there is worse than
  // unanchoring. `avail` is how much context we even have to match
  // against, so a quote near a doc boundary (little/no context) isn't
  // over-penalized.
  const avail = Math.min(d.prefix.length, CONTEXT) + Math.min(d.suffix.length, CONTEXT);
  const need = Math.ceil(avail * MIN_CONTEXT_FRACTION);
  if (best.context < need) return null;

  // Ambiguous if the runner-up matched context just as well and sat equally
  // close — i.e. context didn't actually distinguish them.
  const ambiguous = scored.some(
    (s) => s.i !== best.i && s.context === best.context && s.dist === best.dist,
  );

  return {
    from: flat.pos[best.i]!,
    to: endPos(flat, best.i + d.quote.length),
    ambiguous,
  };
}
