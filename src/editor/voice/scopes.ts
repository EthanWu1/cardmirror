/**
 * Composable scopes for voice targeting (SPEC-voice.md §4.5; design
 * adapted from Cursorless per reference-docs/RESEARCH-composable-scopes
 * §5). Each scope type yields an ordered list of document ranges; the
 * generic resolvers — containing / nth-in-iteration / every / head /
 * tail — are implemented ONCE over that interface, so every scope
 * works with every modifier, exactly the Cursorless property worth
 * stealing.
 *
 * Schema mapping notes:
 *  - card / analytic_unit / tag / cite / body / analytic / paragraph
 *    are real nodes → ranges are node content ranges.
 *  - pocket / hat / block are FLAT heading paragraphs; their scope is
 *    the SECTION they head (heading start → next same-or-higher
 *    heading), computed from the headings table.
 *  - sentence / word are "dumb" textual scopes (regex / tokenizer),
 *    like Cursorless's sentence and token.
 *  - Iteration scopes (what ordinals/every count within) follow the
 *    research mapping: word→sentence, sentence→paragraph-like,
 *    paragraph→card/unit (else doc), tag/cite/body→card,
 *    card/analytic/unit→block section (else doc), block→hat section,
 *    hat→pocket section, pocket→doc.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { collectHeadings, TYPE_TO_LEVEL } from '../headings.js';
import { collectTokens } from './align.js';

export type ScopeName =
  | 'pocket' | 'hat' | 'block'
  | 'card' | 'unit' | 'analytic'
  | 'tag' | 'cite' | 'body'
  | 'paragraph' | 'sentence' | 'word';

export interface ScopeRange {
  from: number;
  to: number;
}

const NODE_SCOPES: Partial<Record<ScopeName, string>> = {
  card: 'card',
  unit: 'analytic_unit',
  analytic: 'analytic',
  tag: 'tag',
  cite: 'cite_paragraph',
  body: 'card_body',
};

const HEADING_SCOPES: Partial<Record<ScopeName, string>> = {
  pocket: 'pocket',
  hat: 'hat',
  block: 'block',
};

/** Textblock types that count as a "paragraph" for voice purposes —
 *  visible body-text blocks (headings and tags are their own scopes). */
const PARAGRAPH_LIKE = new Set(['paragraph', 'card_body', 'cite_paragraph', 'analytic', 'undertag']);

const SENTENCE_SPLIT = /[.!?…]+["”’)\]]*\s+/g;

const rangeCache = new WeakMap<PMNode, Map<ScopeName, ScopeRange[]>>();

/** All ranges of a scope type, in document order. Cached per doc. */
export function scopeRanges(doc: PMNode, scope: ScopeName): ScopeRange[] {
  const cached = rangeCache.get(doc)?.get(scope);
  if (cached) return cached;

  const out: ScopeRange[] = [];
  const nodeType = NODE_SCOPES[scope];
  const headingType = HEADING_SCOPES[scope];

  if (nodeType) {
    doc.descendants((node, pos) => {
      if (node.type.name === nodeType) {
        out.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
        return false; // these node scopes never nest in themselves
      }
      return true;
    });
  } else if (headingType) {
    // Section ranges: heading start → next heading of same-or-higher
    // level (or doc end). Levels come from the shared headings table.
    const headings = collectHeadings(doc, { skipCite: true });
    const level = TYPE_TO_LEVEL[headingType] as number;
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]!;
      if (h.type !== headingType) continue;
      let end = doc.content.size;
      for (let j = i + 1; j < headings.length; j++) {
        const later = headings[j]!;
        if ((TYPE_TO_LEVEL[later.type] ?? 99) <= level) {
          end = later.pos;
          break;
        }
      }
      out.push({ from: h.pos, to: end });
    }
  } else if (scope === 'paragraph') {
    doc.descendants((node, pos) => {
      if (node.isTextblock) {
        if (PARAGRAPH_LIKE.has(node.type.name)) out.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
        return false;
      }
      return true;
    });
  } else if (scope === 'sentence') {
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (!PARAGRAPH_LIKE.has(node.type.name)) return false;
      const text = node.textContent;
      const start = pos + 1;
      let cursor = 0;
      SENTENCE_SPLIT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SENTENCE_SPLIT.exec(text)) !== null) {
        const endOfSentence = m.index + m[0].trimEnd().length;
        if (endOfSentence > cursor) out.push({ from: start + cursor, to: start + endOfSentence });
        cursor = m.index + m[0].length;
      }
      if (cursor < text.length) {
        const tail = text.slice(cursor).trimEnd();
        if (tail) out.push({ from: start + cursor, to: start + cursor + tail.length });
      }
      return false;
    });
  } else if (scope === 'word') {
    for (const tok of collectTokens(doc, 'joined')) out.push({ from: tok.from, to: tok.to });
  }

  let per = rangeCache.get(doc);
  if (!per) rangeCache.set(doc, (per = new Map()));
  per.set(scope, out);
  return out;
}

/** Innermost range of `scope` containing `pos` (Cursorless
 *  "containing scope"). For flat heading sections, "containing" means
 *  the section the position falls in. */
export function containingScope(doc: PMNode, scope: ScopeName, pos: number): ScopeRange | null {
  let best: ScopeRange | null = null;
  for (const r of scopeRanges(doc, scope)) {
    if (r.from > pos) break;
    if (pos >= r.from && pos <= r.to) best = r; // last match = innermost/nearest
  }
  return best;
}

const ITERATION: Record<ScopeName, ScopeName | 'doc'> = {
  word: 'sentence',
  sentence: 'paragraph',
  paragraph: 'card',
  tag: 'card',
  cite: 'card',
  body: 'card',
  analytic: 'block',
  unit: 'block',
  card: 'block',
  block: 'hat',
  hat: 'pocket',
  pocket: 'doc',
};

/** The container ordinals/every iterate within, from `pos` (research
 *  §5 iteration-scope map). Falls back outward to the whole doc when
 *  the canonical container is absent. */
export function iterationContainer(doc: PMNode, scope: ScopeName, pos: number): ScopeRange {
  let container: ScopeName | 'doc' = ITERATION[scope];
  while (container !== 'doc') {
    const r = containingScope(doc, container, pos);
    if (r) return r;
    container = ITERATION[container];
  }
  return { from: 0, to: doc.content.size };
}

/** All `scope` ranges inside the iteration container at `pos`. */
export function everyInIteration(doc: PMNode, scope: ScopeName, pos: number): ScopeRange[] {
  const container = iterationContainer(doc, scope, pos);
  return scopeRanges(doc, scope).filter((r) => r.from >= container.from && r.to <= container.to);
}

/** nth (1-based) `scope` in the iteration container at `pos`. */
export function nthInIteration(
  doc: PMNode,
  scope: ScopeName,
  pos: number,
  n: number,
): ScopeRange | null {
  return everyInIteration(doc, scope, pos)[n - 1] ?? null;
}
