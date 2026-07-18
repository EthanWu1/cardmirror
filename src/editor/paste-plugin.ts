/**
 * Paste-handling plugin.
 *
 * Two interventions over PM's default clipboard handling:
 *
 * 1. **Plain-paste-armed mode (F2).** Browsers won't let a web app
 *    read the clipboard programmatically without a permission prompt
 *    (Chrome's "Paste" chip, Firefox's "Paste" popup — Mozilla doesn't
 *    even offer a permanent grant), so a Verbatim-style "F2 pastes
 *    plain text" can't be a single-keystroke action in a browser.
 *    Instead F2 toggles a plugin-state flag; while armed, every real
 *    `paste` event (a user-initiated Ctrl/Cmd+V) strips all
 *    formatting and inserts the clipboard's `text/plain` content.
 *    If `condenseOnPaste` is on, the F3 default condense then runs
 *    scoped to the pasted range (see `condensePastedRange`). F2
 *    again (or the ribbon button) disarms. The status-bar UI shows
 *    the armed state.
 *
 * 2. **A structural-led paste splits the destination container.** When the
 *    clipboard leads with structural content — a `tag` / `analytic` head, a
 *    doc-level heading (`pocket` / `hat` / `block`), or a whole `card` /
 *    `analytic_unit` — and the cursor sits in a body slot (`card_body` /
 *    `cite_paragraph` / `undertag`) of a `card` / `analytic_unit`, PM's default
 *    fitting demotes the structure to body text (the clipboard's flat, open
 *    `[tag, card_body, …]` shape merges its open head into the cursor's body).
 *    That's wrong — the user wanted the structural type, with its content. We
 *    instead re-group the pasted nodes into proper containers and split the
 *    destination, preserving the FULL pasted structure (see
 *    `tryPasteSplitContainer`). Falls through to default PM behavior in any
 *    other shape (no structural head, cursor not in a body slot, etc.).
 *
 * Order: armed mode wins over auto-split.
 */

import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import {
  DOMParser as PMDOMParser,
  Fragment,
  Slice,
  type Node as PMNode,
  type NodeType,
  type ResolvedPos,
} from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../schema/index.js';
import { freshHeadingIds } from './drag-controller.js';
import { condenseBranchC, condenseMerge } from './condense.js';
import { buildImageNodeFromBlob, insertImageNode } from './image-insert.js';
import { fragmentHasZone, flattenZonesInSlice, enclosingZonePos } from './transclusion.js';
import { recallLinkedCopy } from './clipboard-link-cache.js';

export function clipboardHasTextPayload(data: DataTransfer | null | undefined): boolean {
  if (!data) return false;
  const html = data.getData('text/html').trim();
  if (html) return true;
  const plain = data.getData('text/plain').trim();
  if (plain) return true;
  const types = Array.from(data.types ?? []);
  return types.some((type) => {
    const t = String(type).toLowerCase();
    return (
      t === 'text/rtf' ||
      t === 'application/rtf' ||
      t === 'public.rtf' ||
      t === 'public.html' ||
      t === 'text/html' ||
      t === 'text/plain' ||
      t.startsWith('text/')
    );
  });
}

/**
 * Build a Slice representing `text` as plain inline content, splitting
 * on newlines into paragraph breaks. Exported for unit tests.
 *
 * - Single line → `Slice(Fragment(text), 0, 0)` so it merges into the
 *   selection's textblock without forcing a paragraph type.
 * - Multi-line → `Slice([paragraph(line0), paragraph(line1), …], 1, 1)`.
 *   The 1/1 opens mean the first line's content joins the cursor's
 *   block and intermediate splits inherit the surrounding block type
 *   (card_body inside a card, etc.). This is the same shape PM's
 *   default plain-text clipboard parser produces.
 */
export function buildPlainTextSlice(text: string): Slice {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length === 1) {
    return new Slice(
      lines[0] ? Fragment.from(schema.text(lines[0])) : Fragment.empty,
      0,
      0,
    );
  }
  const paragraphs = lines.map((line) =>
    schema.nodes['paragraph']!.create(null, line ? schema.text(line) : null),
  );
  return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}

const WORD_BLOCK_STYLE_CLASSES: Record<string, { tag: string; className: string }> = {
  heading1: { tag: 'h1', className: 'pmd-pocket' },
  heading1char: { tag: 'h1', className: 'pmd-pocket' },
  pocket: { tag: 'h1', className: 'pmd-pocket' },
  pocketchar: { tag: 'h1', className: 'pmd-pocket' },
  heading2: { tag: 'h2', className: 'pmd-hat' },
  heading2char: { tag: 'h2', className: 'pmd-hat' },
  hat: { tag: 'h2', className: 'pmd-hat' },
  hatchar: { tag: 'h2', className: 'pmd-hat' },
  heading3: { tag: 'h3', className: 'pmd-block' },
  heading3char: { tag: 'h3', className: 'pmd-block' },
  block: { tag: 'h3', className: 'pmd-block' },
  blockchar: { tag: 'h3', className: 'pmd-block' },
  blockheading: { tag: 'h3', className: 'pmd-block' },
  blockheadingchar: { tag: 'h3', className: 'pmd-block' },
  blockheadings: { tag: 'h3', className: 'pmd-block' },
  blockheadingschar: { tag: 'h3', className: 'pmd-block' },
  blocktitle: { tag: 'h3', className: 'pmd-block' },
  blocktitlechar: { tag: 'h3', className: 'pmd-block' },
  hiddenblockheader: { tag: 'h3', className: 'pmd-block' },
  hiddenblockheaderchar: { tag: 'h3', className: 'pmd-block' },
  heading4: { tag: 'h4', className: 'pmd-tag' },
  heading4char: { tag: 'h4', className: 'pmd-tag' },
  tag: { tag: 'h4', className: 'pmd-tag' },
  tagchar: { tag: 'h4', className: 'pmd-tag' },
  styletag: { tag: 'h4', className: 'pmd-tag' },
  styletagchar: { tag: 'h4', className: 'pmd-tag' },
  tags: { tag: 'h4', className: 'pmd-tag' },
  tagschar: { tag: 'h4', className: 'pmd-tag' },
  styletags: { tag: 'h4', className: 'pmd-tag' },
  styletagschar: { tag: 'h4', className: 'pmd-tag' },
  cards: { tag: 'h4', className: 'pmd-tag' },
  card: { tag: 'h4', className: 'pmd-tag' },
  cardchar: { tag: 'h4', className: 'pmd-tag' },
  cardschar: { tag: 'h4', className: 'pmd-tag' },
  stylecard: { tag: 'h4', className: 'pmd-tag' },
  stylecardchar: { tag: 'h4', className: 'pmd-tag' },
  stylecards: { tag: 'h4', className: 'pmd-tag' },
  stylecardschar: { tag: 'h4', className: 'pmd-tag' },
  analytic: { tag: 'p', className: 'pmd-analytic' },
  analyticchar: { tag: 'p', className: 'pmd-analytic' },
  analyticreal: { tag: 'p', className: 'pmd-analytic' },
  undertag: { tag: 'p', className: 'pmd-undertag' },
  undertagchar: { tag: 'p', className: 'pmd-undertag' },
};

const GENERIC_WORD_HEADING_TOKENS = new Set(['heading1', 'heading2', 'heading3', 'heading4']);

const WORD_MARK_STYLE_CLASSES: Record<string, string> = {
  style13ptbold: 'pmd-cite',
  stylebold: 'pmd-cite',
  stylebold12pt: 'pmd-cite',
  stylestylebold12pt: 'pmd-cite',
  bold: 'pmd-cite',
  cite: 'pmd-cite',
  styleunderline: 'pmd-underline',
  underline: 'pmd-underline',
  underlinechar: 'pmd-underline',
  styleboldunderline: 'pmd-underline',
  emphasis: 'pmd-emphasis',
  styleemphasis: 'pmd-emphasis',
  emphasischar: 'pmd-emphasis',
  emphasischaracter: 'pmd-emphasis',
  styleemphasischar: 'pmd-emphasis',
  styleemphasischaracter: 'pmd-emphasis',
  intenseemphasis: 'pmd-emphasis',
  intenseemphasischar: 'pmd-emphasis',
  intenseemphasischaracter: 'pmd-emphasis',
  undertagchar: 'pmd-undertag-mark',
  analyticchar: 'pmd-analytic-mark',
};

interface WordCssInfo {
  tokens: string[];
  outlineLevel: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fontSizePt: number | null;
}

function normalizeMsoHighlight(html: string): string {
  if (!/mso-highlight/i.test(html)) return html;
  return html.replace(
    /style\s*=\s*(["'])([\s\S]*?)\1/gi,
    (_full: string, quote: string, style: string) => {
      const normalized = style.replace(
        /(^|;)\s*mso-highlight\s*:\s*([^;]+)/gi,
        (_decl: string, prefix: string, color: string) => {
          const value = color.trim();
          if (!value || /^none$/i.test(value)) return prefix;
          return `${prefix}background-color:${value}`;
        },
      );
      return `style=${quote}${normalized}${quote}`;
    },
  );
}

function normalizeWordStyleToken(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^mso/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function blankWordCssInfo(): WordCssInfo {
  return {
    tokens: [],
    outlineLevel: null,
    bold: false,
    italic: false,
    underline: false,
    fontSizePt: null,
  };
}

function mergeWordCssInfo(target: WordCssInfo, source: WordCssInfo): WordCssInfo {
  target.tokens.push(...source.tokens);
  target.outlineLevel = source.outlineLevel ?? target.outlineLevel;
  target.bold ||= source.bold;
  target.italic ||= source.italic;
  target.underline ||= source.underline;
  target.fontSizePt = Math.max(target.fontSizePt ?? 0, source.fontSizePt ?? 0) || null;
  return target;
}

function parseWordFontSizePt(declarations: string): number | null {
  const match = /(?:^|;)\s*font-size\s*:\s*(-?\d+(?:\.\d+)?)\s*(pt|px)\b/i.exec(declarations);
  if (!match?.[1] || !match[2]) return null;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return match[2].toLowerCase() === 'px' ? n * 0.75 : n;
}

function parseWordCssDeclarations(declarations: string): WordCssInfo {
  const info = blankWordCssInfo();
  const styleNamePattern = /(?:^|;)\s*mso-style-(?:name|link|id)\s*:\s*("[^"]+"|'[^']+'|[^;]+)/gi;
  for (const match of declarations.matchAll(styleNamePattern)) {
    const token = normalizeWordStyleToken(match[1] ?? '');
    if (token) info.tokens.push(token);
  }

  const outlineMatch = /(?:^|;)\s*mso-outline-level\s*:\s*(\d+)/i.exec(declarations);
  if (outlineMatch?.[1]) info.outlineLevel = Number(outlineMatch[1]);

  info.bold = /(?:^|;)\s*(?:font-weight|mso-bidi-font-weight)\s*:\s*(?:bold|[5-9]\d{2})\b/i.test(declarations);
  info.italic = /(?:^|;)\s*(?:font-style|mso-bidi-font-style)\s*:\s*italic\b/i.test(declarations);
  info.underline = /(?:^|;)\s*text-decoration(?:-line)?\s*:\s*[^;]*underline\b/i.test(declarations);
  info.fontSizePt = parseWordFontSizePt(declarations);
  return info;
}

function parseWordCssClassInfo(root: ParentNode): Map<string, WordCssInfo> {
  const map = new Map<string, WordCssInfo>();
  const css = Array.from(root.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    const selectors = match[1] ?? '';
    const declarations = match[2] ?? '';
    const info = parseWordCssDeclarations(declarations);
    if (
      info.tokens.length === 0 &&
      info.outlineLevel === null &&
      !info.bold &&
      !info.italic &&
      !info.underline &&
      info.fontSizePt === null
    ) {
      continue;
    }
    for (const selector of selectors.split(',')) {
      for (const classMatch of selector.matchAll(/\.([_a-zA-Z][-_a-zA-Z0-9]*)/g)) {
        const className = classMatch[1];
        if (!className) continue;
        const existing = map.get(className) ?? blankWordCssInfo();
        map.set(className, mergeWordCssInfo(existing, info));
      }
    }
  }
  return map;
}

function wordCssInfoForElement(el: Element, classInfo: Map<string, WordCssInfo>): WordCssInfo {
  const info = blankWordCssInfo();
  const classAttr = el.getAttribute('class') ?? '';
  for (const className of classAttr.split(/\s+/)) {
    if (!className) continue;
    const mapped = classInfo.get(className);
    if (mapped) mergeWordCssInfo(info, mapped);
  }
  mergeWordCssInfo(info, parseWordCssDeclarations(el.getAttribute('style') ?? ''));
  return info;
}

function wordTagInfoForElement(el: Element): WordCssInfo {
  const info = blankWordCssInfo();
  const tagName = el.tagName.toLowerCase();
  if (tagName === 'b' || tagName === 'strong') info.bold = true;
  if (tagName === 'i' || tagName === 'em') info.italic = true;
  if (tagName === 'u') info.underline = true;
  return info;
}

function wordVisualInfoForElement(el: Element, classInfo: Map<string, WordCssInfo>): WordCssInfo {
  return mergeWordCssInfo(wordCssInfoForElement(el, classInfo), wordTagInfoForElement(el));
}

function wordVisualInfoForTextNode(
  text: Text,
  root: Element,
  classInfo: Map<string, WordCssInfo>,
): WordCssInfo {
  const info = blankWordCssInfo();
  let cur: Node | null = text.parentElement;
  while (cur instanceof Element) {
    mergeWordCssInfo(info, wordVisualInfoForElement(cur, classInfo));
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return info;
}

function wordTextRunVisualInfos(root: Element, classInfo: Map<string, WordCssInfo>): WordCssInfo[] {
  const infos: WordCssInfo[] = [];
  const walker = document.createTreeWalker(root, 4);
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (!text.data.replace(/\s+/g, ' ').trim()) continue;
    infos.push(wordVisualInfoForTextNode(text, root, classInfo));
  }
  return infos;
}

function looksLikeWordCitationText(text: string): boolean {
  return (
    /\b(?:19|20)\d{2}\b/.test(text) ||
    /\b[A-Z][A-Za-z'’-]{2,}\s+\d{2,4}\b/.test(text) ||
    /\b(?:doi|journal|rev\.|vol\.|https?:\/\/)\b/i.test(text)
  );
}

function inferWordVisualBlockStyle(
  el: Element,
  classInfo: Map<string, WordCssInfo>,
): { tag: string; className: string } | null {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120 || looksLikeWordCitationText(text)) return null;

  const runs = wordTextRunVisualInfos(el, classInfo);
  if (runs.length === 0) return null;

  const allTextIsBold = runs.every((info) => info.bold);
  const maxFontSizePt = Math.max(...runs.map((info) => info.fontSizePt ?? 0));
  if (allTextIsBold && maxFontSizePt >= 12.5) {
    return WORD_BLOCK_STYLE_CLASSES['tag'] ?? null;
  }
  return null;
}

function wordBlockStyleForToken(
  token: string,
  includeGenericHeading: boolean,
): { tag: string; className: string } | null {
  if (!includeGenericHeading && GENERIC_WORD_HEADING_TOKENS.has(token)) return null;
  return WORD_BLOCK_STYLE_CLASSES[token] ?? null;
}

function firstWordBlockStyleForTokens(
  tokens: readonly string[],
  includeGenericHeading: boolean,
): { tag: string; className: string } | null {
  for (const token of tokens) {
    const mapped = wordBlockStyleForToken(token, includeGenericHeading);
    if (mapped) return mapped;
  }
  return null;
}

function wholeTextWordBlockStyle(
  el: Element,
  classInfo: Map<string, WordCssInfo>,
): { tag: string; className: string } | null {
  const runs = wordTextRunVisualInfos(el, classInfo);
  if (runs.length === 0) return null;

  let shared: { tag: string; className: string } | null = null;
  for (const info of runs) {
    const mapped =
      firstWordBlockStyleForTokens(info.tokens, false) ??
      firstWordBlockStyleForTokens(info.tokens, true);
    if (!mapped) return null;
    if (!shared) {
      shared = mapped;
      continue;
    }
    if (shared.tag !== mapped.tag || shared.className !== mapped.className) return null;
  }
  return shared;
}

function inferWordVisualMarkClass(
  el: Element,
  classInfo: Map<string, WordCssInfo>,
): string | null {
  const info = wordVisualInfoForElement(el, classInfo);
  if (info.italic) return 'pmd-emphasis';
  return null;
}

function wordStyleTokens(el: Element, classInfo: Map<string, WordCssInfo>): string[] {
  const classTokens: string[] = [];
  const classAttr = el.getAttribute('class') ?? '';
  for (const className of classAttr.split(/\s+/)) {
    if (!className) continue;
    classTokens.push(className);
    if (/^mso/i.test(className)) classTokens.push(className.replace(/^mso/i, ''));
  }

  const classStyleTokens = classTokens.map(normalizeWordStyleToken).filter(Boolean);
  return [...wordCssInfoForElement(el, classInfo).tokens, ...classStyleTokens];
}

function addClass(el: Element, className: string): void {
  const classes = new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
  classes.add(className);
  el.setAttribute('class', [...classes].join(' '));
}

function removeClasses(el: Element, classNames: readonly string[]): void {
  const classes = new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
  for (const className of classNames) classes.delete(className);
  if (classes.size) el.setAttribute('class', [...classes].join(' '));
  else el.removeAttribute('class');
}

function replaceElementTag(el: HTMLElement, tagName: string): HTMLElement {
  if (el.tagName.toLowerCase() === tagName) return el;
  const replacement = document.createElement(tagName);
  for (const attr of Array.from(el.attributes)) {
    replacement.setAttribute(attr.name, attr.value);
  }
  while (el.firstChild) replacement.appendChild(el.firstChild);
  el.replaceWith(replacement);
  return replacement;
}

function firstWordBlockStyle(
  el: Element,
  classInfo: Map<string, WordCssInfo>,
  allowVisualInference: boolean,
): { tag: string; className: string } | null {
  const tokens = wordStyleTokens(el, classInfo);
  const explicit = firstWordBlockStyleForTokens(tokens, false);
  if (explicit) return explicit;
  const linkedTextStyle = wholeTextWordBlockStyle(el, classInfo);
  if (linkedTextStyle) return linkedTextStyle;
  const generic = firstWordBlockStyleForTokens(tokens, true);
  if (generic) return generic;
  const outlineLevel = wordCssInfoForElement(el, classInfo).outlineLevel;
  if (outlineLevel === 1) return WORD_BLOCK_STYLE_CLASSES['heading1'] ?? null;
  if (outlineLevel === 2) return WORD_BLOCK_STYLE_CLASSES['heading2'] ?? null;
  if (outlineLevel === 3) return WORD_BLOCK_STYLE_CLASSES['heading3'] ?? null;
  if (outlineLevel === 4) return WORD_BLOCK_STYLE_CLASSES['heading4'] ?? null;
  if (allowVisualInference) return inferWordVisualBlockStyle(el, classInfo);
  return null;
}

function firstWordMarkClass(
  el: Element,
  classInfo: Map<string, WordCssInfo>,
  allowVisualInference: boolean,
): string | null {
  for (const token of wordStyleTokens(el, classInfo)) {
    const mapped = WORD_MARK_STYLE_CLASSES[token];
    if (mapped) return mapped;
  }
  if (allowVisualInference) return inferWordVisualMarkClass(el, classInfo);
  return null;
}

function appendStyleDeclaration(el: HTMLElement, property: string, value: string): void {
  const style = el.getAttribute('style') ?? '';
  const propertyPattern = new RegExp(`(?:^|;)\\s*${property.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`, 'i');
  if (propertyPattern.test(style)) return;
  const separator = style.trim() && !style.trim().endsWith(';') ? '; ' : '';
  el.setAttribute('style', `${style.trim()}${separator}${property}:${value}`.trim());
}

function removeStyleDeclarations(el: HTMLElement, properties: string[]): void {
  const style = el.getAttribute('style');
  if (!style) return;
  const remove = new Set(properties.map((property) => property.toLowerCase()));
  const kept = style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const property = declaration.split(':', 1)[0]?.trim().toLowerCase();
      return property && !remove.has(property);
    });
  if (kept.length) el.setAttribute('style', kept.join('; '));
  else el.removeAttribute('style');
}

function applyWordClassFormatting(el: HTMLElement, classInfo: Map<string, WordCssInfo>): void {
  const info = wordCssInfoForElement(el, classInfo);
  if (info.bold) appendStyleDeclaration(el, 'font-weight', 'bold');
  if (info.italic) appendStyleDeclaration(el, 'font-style', 'italic');
  if (info.underline) appendStyleDeclaration(el, 'text-decoration', 'underline');
}

function stripItalicFormatting(el: HTMLElement): void {
  removeStyleDeclarations(el, ['font-style', 'mso-bidi-font-style']);
  for (const styled of Array.from(el.querySelectorAll<HTMLElement>('[style]'))) {
    removeStyleDeclarations(styled, ['font-style', 'mso-bidi-font-style']);
  }
  for (const italicEl of Array.from(el.querySelectorAll<HTMLElement>('i,em'))) {
    replaceElementTag(italicEl, 'span');
  }
}

function wrapElementChildrenWithMark(el: HTMLElement, className: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = className;
  while (el.firstChild) wrapper.appendChild(el.firstChild);
  el.appendChild(wrapper);
  return wrapper;
}

function isWordCiteBlock(el: Element): boolean {
  return el.classList.contains('pmd-cite-para') || !!el.querySelector('.pmd-cite');
}

function looksLikeWordCitationBlock(el: Element): boolean {
  if (isWordCiteBlock(el)) return true;
  if (!['p', 'div'].includes(el.tagName.toLowerCase())) return false;
  if (
    el.classList.contains('pmd-pocket') ||
    el.classList.contains('pmd-hat') ||
    el.classList.contains('pmd-block') ||
    el.classList.contains('pmd-tag') ||
    el.classList.contains('pmd-analytic') ||
    el.classList.contains('pmd-undertag') ||
    el.classList.contains('pmd-card-body')
  ) {
    return false;
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 500) return false;
  return looksLikeWordCitationText(text);
}

function isTagLineBeforeCiteCandidate(el: Element): boolean {
  if (isWordCiteBlock(el)) return false;
  // Native CardMirror headings carry data-id. Word-recovered headings do not.
  // Keep real blocks intact when copying CardMirror -> CardMirror, while still
  // allowing the Word fallback to recover short Heading 3 lines above cites as
  // tags when Word dropped the debate style name.
  if (el.classList.contains('pmd-block') && el.hasAttribute('data-id')) return false;
  if (
    el.classList.contains('pmd-pocket') ||
    el.classList.contains('pmd-hat') ||
    el.classList.contains('pmd-analytic') ||
    el.classList.contains('pmd-undertag') ||
    el.classList.contains('pmd-card-body')
  ) {
    return false;
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120 || looksLikeWordCitationText(text)) return false;
  return el.classList.contains('pmd-block') || !el.classList.contains('pmd-tag');
}

function isEmptyWordSpacingBlock(el: Element): boolean {
  const text = (el.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  return !text && ['p', 'div'].includes(el.tagName.toLowerCase());
}

function promoteLineBeforeCiteToTag(el: HTMLElement): void {
  const target = replaceElementTag(el, 'h4');
  removeClasses(target, ['pmd-block']);
  addClass(target, 'pmd-tag');
}

function promoteLikelyCitationToCite(el: HTMLElement): void {
  addClass(el, 'pmd-cite-para');
  if (!el.querySelector('.pmd-cite')) {
    wrapElementChildrenWithMark(el, 'pmd-cite');
  }
}

function promoteLinesBeforeCitesToTags(root: ParentNode): void {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,div'));
  for (let i = 0; i < blocks.length; i += 1) {
    const cite = blocks[i];
    if (!cite) continue;
    const citeKnown = isWordCiteBlock(cite);
    const citeLooksLikely = !citeKnown && looksLikeWordCitationBlock(cite);
    if (!citeKnown && !citeLooksLikely) continue;
    const blanks: HTMLElement[] = [];
    for (let j = i - 1; j >= 0; j -= 1) {
      const current = blocks[j];
      if (!current) break;
      if (isEmptyWordSpacingBlock(current)) {
        blanks.push(current);
        continue;
      }
      if (isTagLineBeforeCiteCandidate(current)) {
        promoteLineBeforeCiteToTag(current);
        if (citeLooksLikely) promoteLikelyCitationToCite(cite);
        for (const blank of blanks) blank.remove();
      }
      break;
    }
  }
}

function isStructuralBoundaryElement(el: HTMLElement): boolean {
  return (
    el.classList.contains('pmd-card') ||
    el.classList.contains('pmd-analytic-unit') ||
    el.classList.contains('pmd-pocket') ||
    el.classList.contains('pmd-hat') ||
    el.classList.contains('pmd-block') ||
    el.classList.contains('pmd-tag') ||
    el.classList.contains('pmd-analytic')
  );
}

function isLooseAnalyticBodyElement(el: HTMLElement): boolean {
  if (isStructuralBoundaryElement(el)) return false;
  if (
    el.classList.contains('pmd-card-body') ||
    el.classList.contains('pmd-cite-para') ||
    el.classList.contains('pmd-undertag')
  ) {
    return true;
  }
  const tagName = el.tagName.toLowerCase();
  return tagName === 'p' || tagName === 'div' || tagName === 'table';
}

function coerceLooseAnalyticBodyElement(el: HTMLElement): HTMLElement {
  if (
    el.classList.contains('pmd-card-body') ||
    el.classList.contains('pmd-cite-para') ||
    el.classList.contains('pmd-undertag') ||
    el.tagName.toLowerCase() === 'table'
  ) {
    return el;
  }
  const target = replaceElementTag(el, 'p');
  addClass(target, 'pmd-card-body');
  return target;
}

function isIgnorableWhitespaceNode(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim();
}

function wrapLooseAnalyticsInContainer(container: ParentNode): void {
  let child: ChildNode | null = container.firstChild;
  while (child) {
    if (
      child instanceof HTMLElement &&
      child.classList.contains('pmd-analytic') &&
      !child.closest('.pmd-analytic-unit')
    ) {
      const unit = document.createElement('div');
      unit.className = 'pmd-analytic-unit';
      child.before(unit);
      const afterUnit = child.nextSibling;
      unit.appendChild(child);
      child = afterUnit;
      while (child) {
        const next = child.nextSibling;
        if (isIgnorableWhitespaceNode(child)) {
          unit.appendChild(child);
          child = next;
          continue;
        }
        if (!(child instanceof HTMLElement) || !isLooseAnalyticBodyElement(child)) break;
        unit.appendChild(coerceLooseAnalyticBodyElement(child));
        child = next;
      }
      continue;
    }
    if (child instanceof HTMLElement && !child.classList.contains('pmd-analytic-unit')) {
      wrapLooseAnalyticsInContainer(child);
    }
    child = child.nextSibling;
  }
}

function wrapLooseAnalyticsIntoUnits(root: ParentNode): void {
  wrapLooseAnalyticsInContainer(root);
}

function isNativeCardMirrorClipboardHtml(html: string): boolean {
  return /\bpmd-(?:pocket|hat|block|card|tag|analytic-unit|analytic|cite-para|card-body|undertag|cite|underline|emphasis|highlight|undertag-mark|analytic-mark)\b/i.test(html);
}

const NATIVE_CARDMIRROR_BLOCK_TAGS: Array<[string, string]> = [
  ['pmd-card', 'div'],
  ['pmd-analytic-unit', 'div'],
  ['pmd-pocket', 'h1'],
  ['pmd-hat', 'h2'],
  ['pmd-block', 'h3'],
  ['pmd-tag', 'h4'],
  ['pmd-analytic', 'p'],
  ['pmd-cite-para', 'p'],
  ['pmd-card-body', 'p'],
  ['pmd-undertag', 'p'],
];

const NATIVE_CARDMIRROR_MARK_CLASSES = new Set([
  'pmd-cite',
  'pmd-underline',
  'pmd-emphasis',
  'pmd-highlight',
  'pmd-undertag-mark',
  'pmd-analytic-mark',
]);

function nativeCardMirrorBlockTag(el: Element): string | null {
  for (const [className, tagName] of NATIVE_CARDMIRROR_BLOCK_TAGS) {
    if (el.classList.contains(className)) return tagName;
  }
  return null;
}

function hasNativeCardMirrorMarkClass(el: Element): boolean {
  for (const className of NATIVE_CARDMIRROR_MARK_CLASSES) {
    if (el.classList.contains(className)) return true;
  }
  return false;
}

function stripNativeCardMirrorClipboardStyles(el: HTMLElement): void {
  const strip = [
    'mso-style-name',
    'mso-style-link',
    'mso-style-id',
    'mso-outline-level',
    'mso-bidi-font-weight',
    'mso-bidi-font-style',
    'font-weight',
    'font-size',
    'font-style',
    'text-align',
    'text-decoration',
    'text-decoration-line',
    'border',
    'color',
  ];
  if (nativeCardMirrorBlockTag(el) || hasNativeCardMirrorMarkClass(el)) {
    removeStyleDeclarations(el, strip);
  }
}

function canonicalizeNativeCardMirrorHtml(html: string): string {
  if (typeof document === 'undefined' || !isNativeCardMirrorClipboardHtml(html)) return html;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;

  for (const original of Array.from(wrap.querySelectorAll<HTMLElement>('*'))) {
    const tagName = nativeCardMirrorBlockTag(original);
    if (tagName) {
      const el = replaceElementTag(original, tagName);
      stripNativeCardMirrorClipboardStyles(el);
    }
  }

  for (const original of Array.from(wrap.querySelectorAll<HTMLElement>('*'))) {
    if (!hasNativeCardMirrorMarkClass(original)) continue;
    const el = replaceElementTag(original, 'span');
    stripNativeCardMirrorClipboardStyles(el);
    if (el.classList.contains('pmd-emphasis')) stripItalicFormatting(el);
  }

  return wrap.innerHTML;
}

function normalizeWordNamedStyles(html: string): string {
  if (typeof document === 'undefined') return html;
  if (isNativeCardMirrorClipboardHtml(html)) return canonicalizeNativeCardMirrorHtml(html);
  const hasWordSignal =
    /(?:\bclass\s*=\s*["'][^"']*\bMso|mso-|xmlns:w=|urn:schemas-microsoft-com:office:word|Microsoft Word)/i.test(html);
  const hasNamedStyleSignal =
    /(?:mso-style-(?:name|link|id)|mso-outline-level|mso-bidi-font-weight|Mso|Heading[1-4]|Style13ptBold|StyleUnderline|StyleBoldUnderline|StyleStyleBold12pt|UndertagChar|AnalyticChar|TagChar|\bTag\b|\bTags\b|\bCard\b|\bCards\b|Emphasis)/i.test(html);
  const hasVisualStyleSignal =
    /(?:font-weight\s*:|font-style\s*:|text-decoration\s*:|font-size\s*:|<(?:b|strong|i|em|u)\b)/i.test(html);
  if (!hasNamedStyleSignal && !hasVisualStyleSignal) {
    return html;
  }
  const allowVisualBlockInference = hasWordSignal;
  const allowVisualMarkInference = hasVisualStyleSignal || hasWordSignal;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const classInfo = parseWordCssClassInfo(wrap);

  for (const original of Array.from(wrap.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,div'))) {
    const block = firstWordBlockStyle(original, classInfo, allowVisualBlockInference);
    if (!block) continue;
    const el = replaceElementTag(original, block.tag);
    addClass(el, block.className);
  }

  for (const el of Array.from(wrap.querySelectorAll<HTMLElement>('span,b,i,em,u,a'))) {
    const className = firstWordMarkClass(el, classInfo, allowVisualMarkInference);
    const target = className === 'pmd-emphasis' &&
      /^(?:i|em)$/i.test(el.tagName)
      ? replaceElementTag(el, 'span')
      : el;
    if (className) addClass(target, className);
    applyWordClassFormatting(target, classInfo);
    if (className === 'pmd-emphasis') stripItalicFormatting(target);
  }

  for (const el of Array.from(wrap.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4'))) {
    const className = firstWordMarkClass(el, classInfo, allowVisualMarkInference);
    if (!className || el.querySelector(`.${className}`)) continue;
    const target = wrapElementChildrenWithMark(el, className);
    applyWordClassFormatting(target, classInfo);
    if (className === 'pmd-emphasis') {
      stripItalicFormatting(target);
      removeStyleDeclarations(el, ['font-style', 'mso-bidi-font-style']);
    }
  }

  for (const para of Array.from(wrap.querySelectorAll<HTMLElement>('p'))) {
    if (
      !para.classList.contains('pmd-cite-para') &&
      !para.classList.contains('pmd-card-body') &&
      !para.classList.contains('pmd-analytic') &&
      !para.classList.contains('pmd-undertag') &&
      para.querySelector('.pmd-cite')
    ) {
      addClass(para, 'pmd-cite-para');
    }
  }

  promoteLinesBeforeCitesToTags(wrap);
  wrapLooseAnalyticsIntoUnits(wrap);

  return wrap.innerHTML;
}

/**
 * Word clipboard HTML often stores visible debate formatting in proprietary
 * CSS (`mso-highlight`) or Word style names/classes (`Heading4`,
 * `Style13ptBold`, `StyleUnderline`). Translate those into CardMirror's
 * existing DOM classes before ProseMirror parses the clipboard.
 */
export function normalizeWordClipboardHtml(html: string): string {
  return normalizeWordNamedStyles(normalizeMsoHighlight(html));
}

/** Block types that hold single-line / single-paragraph content
 *  in our schema. Plain-paste into these MUST flatten any
 *  internal newlines to spaces — pasting "Article Title\n" (a
 *  triple-click selection in the browser often carries that
 *  trailing newline) would otherwise split the surrounding card
 *  at the newline boundary, because the multi-paragraph slice
 *  forces PM to break out of the single-line parent. */
const SINGLE_LINE_PASTE_PARENTS = new Set<string>([
  'tag',
  'cite_paragraph',
  'undertag',
  'analytic',
]);

/** Normalize clipboard text for paste into the given parent block.
 *  In single-line contexts (`SINGLE_LINE_PASTE_PARENTS`), collapse
 *  any whitespace run (newlines, tabs, repeated spaces) to a single
 *  space and trim the edges. In multi-paragraph contexts
 *  (`card_body`, `paragraph`, etc.) leave the text alone so
 *  intentional paragraph splits in the clipboard survive. */
export function normalizeClipboardTextForPaste(
  text: string,
  parentTypeName: string,
): string {
  if (SINGLE_LINE_PASTE_PARENTS.has(parentTypeName)) {
    return text.replace(/\s+/g, ' ').trim();
  }
  return text;
}

const SPLITTABLE_BODY_SLOTS = new Set<string>([
  'card_body',
  'cite_paragraph',
  'undertag',
]);

/** Structural heads a paste can lead with that must "win" over a card body:
 *  the card-anchoring `tag`, the analytic_unit-anchoring `analytic`, and the
 *  doc-level headings (`pocket` / `hat` / `block`). */
const STRUCTURAL_HEAD_NAMES = new Set<string>([
  'tag',
  'analytic',
  'pocket',
  'hat',
  'block',
]);
const DOC_LEVEL_HEADINGS = new Set<string>(['pocket', 'hat', 'block']);
/** Whole structural containers a paste can lead with. */
const STRUCTURAL_CONTAINERS = new Set<string>(['card', 'analytic_unit']);
/** Blocks that are valid `card` / `analytic_unit` content, so a paste of them
 *  can be fitted INTO the container instead of bubbling a split up to the card
 *  level. `paragraph` is converted to `card_body`; the rest keep their type. */
const CARD_FITTABLE_PASTE = new Set<string>([
  'paragraph',
  'cite_paragraph',
  'undertag',
  'card_body',
]);

/** Fit an arbitrary body node into a `card`'s content rule
 *  (`card_body | undertag | cite_paragraph | table`). A bare `paragraph`
 *  (common from external HTML) — or a stray `analytic`, which is not
 *  legal card content — becomes a `card_body`; the rest pass through.
 *  (Structural-led pastes route analytics into their own analytic_unit via
 *  `groupStructuralNodes`, so an analytic shouldn't reach here; the coercion is
 *  defensive, keeping the card schema-valid either way.) */
function fitForCard(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'undertag' || t === 'cite_paragraph' || t === 'table') {
    return child;
  }
  return schema.nodes['card_body']!.create(null, child.content);
}

/** Fit a body node into an `analytic_unit`'s content rule
 *  (`card_body | undertag | cite_paragraph | table`). An `analytic` (only one
 *  is allowed, the head) or a bare `paragraph` folds into a `card_body`. */
function fitForAnalyticUnit(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'undertag' || t === 'cite_paragraph' || t === 'table') {
    return child;
  }
  return schema.nodes['card_body']!.create(null, child.content);
}

/** Convert a card/unit body child into the equivalent node valid at the doc
 *  root — for when a pasted doc-level heading ejects the post-cursor remainder
 *  out of its container. Mirrors `liftCardChild` in ribbon-commands. */
function liftToDocRoot(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'cite_paragraph') {
    return schema.nodes['paragraph']!.create(null, child.content);
  }
  if (t === 'analytic') {
    return schema.nodes['analytic_unit']!.create(null, [child]);
  }
  return child;
}

/** Normalize a flat sequence of pasted structural nodes into doc-level-valid
 *  containers: a bare `tag` (plus the body nodes that follow it) wraps into a
 *  `card`; a bare `analytic` into an `analytic_unit`; doc-level headings,
 *  whole `card`/`analytic_unit` nodes, and loose blocks pass through. This
 *  re-closes the open, flat `[tag, card_body, …]` shape the clipboard produces
 *  when a selection starts inside a tag — the shape PM would otherwise demote
 *  by merging the open head into the cursor's body. */
function groupStructuralNodes(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  let i = 0;
  const isBoundary = (n: PMNode): boolean =>
    STRUCTURAL_HEAD_NAMES.has(n.type.name) || STRUCTURAL_CONTAINERS.has(n.type.name);
  while (i < nodes.length) {
    const n = nodes[i]!;
    const t = n.type.name;
    if (t === 'tag' || t === 'analytic') {
      const isCard = t === 'tag';
      const fit = isCard ? fitForCard : fitForAnalyticUnit;
      const bodies: PMNode[] = [];
      i++;
      while (i < nodes.length && !isBoundary(nodes[i]!)) {
        bodies.push(fit(nodes[i]!));
        i++;
      }
      out.push(
        schema.nodes[isCard ? 'card' : 'analytic_unit']!.create(null, [n, ...bodies]),
      );
    } else {
      out.push(n);
      i++;
    }
  }
  return out;
}

export interface PastePluginCtx {
  condenseOnPaste: () => boolean;
  paragraphIntegrity: () => boolean;
  usePilcrows: () => boolean;
  headingMode: () => 'strict' | 'respect' | 'demolish';
  /** Called whenever the armed flag flips, so the chrome can mirror it. */
  onArmedChange?: (armed: boolean) => void;
}

interface PluginState {
  plainPasteArmed: boolean;
}

export const plainPasteKey = new PluginKey<PluginState>('pmd-paste');

/** Is the next Ctrl/Cmd+V going to be treated as plain-paste? */
export function isPlainPasteArmed(state: EditorState): boolean {
  return plainPasteKey.getState(state)?.plainPasteArmed ?? false;
}

/** Toggle the plain-paste flag. Used by F2 in the browser edition,
 *  where Chromium's clipboard-permission UI forbids a synchronous
 *  one-keystroke paste. Electron's F2 path uses
 *  `applyPlainPasteFromText` directly instead. */
export function togglePlainPaste(): (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const armed = isPlainPasteArmed(state);
    dispatch(state.tr.setMeta(plainPasteKey, { plainPasteArmed: !armed }));
    return true;
  };
}

/** Settings-driven condense over just-pasted content. `from` is the
 *  selection start captured BEFORE the paste transaction; the cursor
 *  parks at the far end afterwards, so [from, cursor] spans the
 *  pasted range. Selects that range, condenses it (same pattern as
 *  `pasteTextAndCondense`), then collapses the cursor back to the
 *  end. The range selection is essential: condensing against the
 *  post-paste empty cursor would scope to the enclosing card — or
 *  no-op entirely at doc level, where plain-text blobs usually land. */
function condensePastedRange(
  view: EditorView,
  from: number,
  ctx: Pick<PastePluginCtx, 'paragraphIntegrity' | 'usePilcrows' | 'headingMode'>,
): void {
  const to = view.state.selection.from;
  if (to <= from) return; // nothing landed
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const cmd = ctx.paragraphIntegrity()
      ? condenseBranchC()
      : condenseMerge({
          withPilcrows: ctx.usePilcrows(),
          headingMode: ctx.headingMode(),
        });
    cmd(view.state, view.dispatch.bind(view));
  } catch (err) {
    console.warn('Condense after paste — condense step failed:', err);
  }
  // F2 normally leaves a collapsed cursor at the end of the paste;
  // restore that after the temporary range selection.
  const sel = view.state.selection;
  if (!sel.empty) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.to)));
  }
}

/** Replace the current selection with `text` as plain inline
 *  content, with the same condense-after-paste behavior the armed-
 *  mode `handlePaste` path uses. Exported for Electron's F2 flow,
 *  which fetches the clipboard via IPC and pastes directly without
 *  the browser-only "arm then Ctrl/Cmd+V" dance. No-op when `text`
 *  is empty. */
export function applyPlainPasteFromText(
  view: EditorView,
  text: string,
  ctx: {
    condenseOnPaste: () => boolean;
    paragraphIntegrity: () => boolean;
    usePilcrows: () => boolean;
    headingMode: () => 'strict' | 'respect' | 'demolish';
  },
): void {
  if (!text) return;
  // Same normalization as the armed-paste handler, for the Electron
  // F2 / menu path.
  const normalized = normalizeClipboardTextForPaste(
    text,
    view.state.selection.$from.parent.type.name,
  );
  if (!normalized) return;
  const slice = buildPlainTextSlice(normalized);
  // Multi-line plain-paste into a card_body cursor: pre-convert
  // the slice's paragraphs to card_body nodes so PM's Fitter
  // doesn't bubble the split up to the card level. Without this,
  // a 3+ line F2 paste mid-card_body lifts the middle paragraphs
  // out as doc-level orphans — the absorb plugin claims them back,
  // but with visible artifacts and a cursor mapping that bounces
  // through the lift+re-absorb instead of landing at the end of
  // the pasted content. Same template as the rich-paste path
  // (handlePaste below).
  const pasteFrom = view.state.selection.from;
  let tr = tryPasteAsCardBodies(view.state, slice);
  if (!tr) tr = view.state.tr.replaceSelection(slice);
  tr.setStoredMarks([]);
  view.dispatch(tr.scrollIntoView());
  if (ctx.condenseOnPaste()) condensePastedRange(view, pasteFrom, ctx);
}

export function buildPastePlugin(ctx: PastePluginCtx): Plugin<PluginState> {
  return new Plugin<PluginState>({
    key: plainPasteKey,
    state: {
      init: () => ({ plainPasteArmed: false }),
      apply(tr, value) {
        const meta = tr.getMeta(plainPasteKey) as PluginState | undefined;
        if (meta && typeof meta.plainPasteArmed === 'boolean') {
          if (meta.plainPasteArmed !== value.plainPasteArmed) {
            ctx.onArmedChange?.(meta.plainPasteArmed);
          }
          return meta;
        }
        return value;
      },
    },
    props: {
      transformPastedHTML(html) {
        return normalizeWordClipboardHtml(html);
      },
      // Stamp every pasted heading with a fresh unique id. The clipboard
      // parser drops `data-id` (our `parseDOM.getAttrs` reads only
      // `indent`), so headings arrive with `id: null`; the nav pane keys
      // expand/collapse, jump, and the 1/2/3/4 level filter off the id,
      // so id-less pasted pockets/hats/blocks/tags would be inert. Runs
      // inside PM's `parseFromClipboard`, before `handlePaste` sees the
      // slice, so the split / card-body paths below also get fresh ids.
      //
      // Layout-table unwrap runs in the same hook so head-detect /
      // card-body fitting downstream see content that's already been
      // lifted out of any single-cell wrapping table.
      transformPasted(slice, view) {
        // Same-doc paste of our own live view / linked copy: restore the link-
        // bearing original (fresh heading ids so the pasted cards don't collide
        // with the source — freshHeadingIds leaves the source-ref attrs alone, so
        // the link survives). A cross-doc / external paste falls through and gets
        // the flattened clipboard content.
        //
        // EXCEPT when the paste lands INSIDE a live zone: a nested transclusion
        // would stack two rails updating from different sources. There we skip the
        // link restore and fall through to flatten (matching drag/create, which
        // never nest a unit in a zone). `selection.from` is the pre-paste caret —
        // where PM will drop the slice.
        const intoZone = enclosingZonePos(view.state.doc, view.state.selection.from) !== null;
        if (!intoZone) {
          const linked = recallLinkedCopy(view, slice);
          if (linked) return freshHeadingIds(unwrapSingleCellTables(linked));
        }
        const out = freshHeadingIds(unwrapSingleCellTables(slice));
        if (!fragmentHasZone(out.content)) return out;
        // Any zone content on the clipboard pastes as a PLAIN cached copy (its
        // cards), never a live link. A partial in-zone copy shouldn't drag the
        // whole zone's linkage along (which would make a refresh pull ALL the
        // source's cards into both the copy and the paste), and a paste into a
        // zone can't nest. flattenZonesInSlice also corrects the open depths so
        // the pasted headings keep their formatting. To duplicate a live zone,
        // use the transclude command (it mints a fresh link).
        return flattenZonesInSlice(out);
      },
      handlePaste(view, event, slice) {
        // Clipboard image paste — screenshots, copy-image from a
        // browser, etc. Take precedence over text / HTML branches
        // when the clipboard carries `image/*` file data; users
        // pasting a screenshot don't want the fallback text label.
        const files = event.clipboardData?.files;
        if (files && files.length > 0 && !clipboardHasTextPayload(event.clipboardData)) {
          const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
          if (imageFile) {
            event.preventDefault();
            void (async () => {
              const node = await buildImageNodeFromBlob(imageFile);
              if (node) insertImageNode(view, node);
            })();
            return true;
          }
        }
        const armed = isPlainPasteArmed(view.state);
        if (armed) {
          // Sticky-toggle behavior: plain-paste stays on until the user
          // explicitly turns it off (F2 again or the ribbon button).
          // Every Ctrl/Cmd+V while armed pastes plain.
          event.preventDefault();
          const raw = event.clipboardData?.getData('text/plain') ?? '';
          const text = normalizeClipboardTextForPaste(
            raw,
            view.state.selection.$from.parent.type.name,
          );
          if (!text) return true;
          const plainSlice = buildPlainTextSlice(text);
          // Same card_body pre-fit as `applyPlainPasteFromText` — see
          // the rationale comment there. Keeps the armed-paste path
          // (browser/web F2) in sync with the direct Electron F2 path.
          const pasteFrom = view.state.selection.from;
          let tr = tryPasteAsCardBodies(view.state, plainSlice);
          if (!tr) tr = view.state.tr.replaceSelection(plainSlice);
          tr.setStoredMarks([]);
          view.dispatch(tr.scrollIntoView());
          if (ctx.condenseOnPaste()) condensePastedRange(view, pasteFrom, ctx);
          return true;
        }

        // Card-fitting FIRST. Content that BELONGS in the cursor's card — a
        // cite_paragraph / undertag / multiple body paragraphs, OR a cite/body
        // copied from inside a card (which serializes as a single OPEN `card`,
        // openStart>0, with its tag cut off) — must fit INTO the card. Doing it
        // before the split path keeps the split at the card_body level instead
        // of bubbling up to spawn a phantom empty-tag card sibling (the
        // "disconnected tag" bug). Bails for content that should WIN — a tag /
        // heading / closed whole card — which the split path below then handles.
        const cardBodyTr = tryPasteCardContent(view.state, slice);
        if (cardBodyTr) {
          event.preventDefault();
          view.dispatch(cardBodyTr.scrollIntoView());
          return true;
        }

        // A structural-led paste (tag / analytic / heading / whole card) into
        // a card body splits the destination so the pasted structure wins.
        // Try the slice PM gave us first; if its head was flattened to inline
        // while fitting the cursor's body slot, recover the true structure by
        // re-parsing the clipboard HTML at the doc level. The reparsed (flat,
        // doc-level) slice is also what the body-then-structural path below
        // wants, so compute it once, lazily.
        let reparsed: Slice | null | undefined;
        const getReparsed = (): Slice | null => {
          if (reparsed === undefined) reparsed = reparseClipboardStructuralSlice(event);
          return reparsed;
        };

        let splitTr = tryPasteSplitContainer(view.state, slice);
        if (!splitTr) {
          const r = getReparsed();
          if (r) splitTr = tryPasteSplitContainer(view.state, r);
        }
        if (splitTr) {
          event.preventDefault();
          view.dispatch(splitTr.scrollIntoView());
          return true;
        }

        // A paste that LEADS with body content then turns structural (a
        // paragraph copied with a following heading / card) — neither path above
        // catches it. Merge the body into the cursor's card, then split at the
        // structural node. Prefer the reparsed flat slice; fall back to the raw
        // slice when there's no clipboard HTML.
        const r = getReparsed();
        let mixedTr = r ? tryPasteBodyThenStructural(view.state, r) : null;
        if (!mixedTr) mixedTr = tryPasteBodyThenStructural(view.state, slice);
        if (mixedTr) {
          event.preventDefault();
          view.dispatch(mixedTr.scrollIntoView());
          return true;
        }

        return false;
      },
    },
  });
}

/**
 * Strip single-cell layout tables from a clipboard slice. Source
 * HTML routinely wraps blocks in `<table>` as a layout primitive
 * (Google Docs published views, news-site article bodies, marketing
 * emails, .docx page-frame copies). PM's default clipboard parser
 * preserves those tables, leaving text trapped inside a `table_cell`
 * — which `isolating: true` walls off from Backspace/Delete and
 * which renders inset because of cell padding. The empty-1×1
 * degenerate of the same shape is the "intermediate undeletable
 * line" users see between a tag/cite and freshly-pasted body text.
 *
 * "Single-cell" = every row has exactly one cell. Multi-cell-per-row
 * tables (real data tables) pass through unchanged. Cells with
 * only-empty paragraphs lift to nothing, so empty 1×1 tables drop
 * out of the slice entirely.
 *
 * Runs inside `transformPasted`, before head-detect / card-body
 * fitting see the slice. Emits generic `paragraph` nodes at the
 * slice root (PM's contextual fit + `tryPasteAsCardBodies` adapt
 * them to a card_body slot); when the table sits inside a `card`
 * or `analytic_unit` in the slice itself (whole-card paste case),
 * emits `card_body` to satisfy the parent's content rule directly.
 *
 * Exported for tests.
 */
export function unwrapSingleCellTables(slice: Slice): Slice {
  const transformed = transformFragmentUnwrap(slice.content, null);
  if (transformed === slice.content) return slice;
  return new Slice(transformed, slice.openStart, slice.openEnd);
}

function transformFragmentUnwrap(
  fragment: Fragment,
  parentName: string | null,
): Fragment {
  let changed = false;
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    if (child.type.name === 'table' && isSingleCellTable(child)) {
      changed = true;
      out.push(...liftSingleCellTable(child, parentName));
      return;
    }
    if (!child.isLeaf && child.content.size > 0) {
      const inner = transformFragmentUnwrap(child.content, child.type.name);
      if (inner !== child.content) {
        changed = true;
        out.push(child.copy(inner));
        return;
      }
    }
    out.push(child);
  });
  return changed ? Fragment.fromArray(out) : fragment;
}

function isSingleCellTable(table: PMNode): boolean {
  if (table.childCount === 0) return false;
  for (let i = 0; i < table.childCount; i++) {
    const row = table.child(i);
    if (row.type.name !== 'table_row') return false;
    if (row.childCount !== 1) return false;
  }
  return true;
}

function liftSingleCellTable(
  table: PMNode,
  parentName: string | null,
): PMNode[] {
  const wrapTypeName =
    parentName === 'card' || parentName === 'analytic_unit'
      ? 'card_body'
      : 'paragraph';
  const wrapType = schema.nodes[wrapTypeName];
  if (!wrapType) return [];
  const out: PMNode[] = [];
  table.forEach((row) => {
    row.forEach((cell) => {
      cell.forEach((para) => {
        if (para.content.size === 0) return;
        out.push(wrapType.create(null, para.content));
      });
    });
  });
  return out;
}

/**
 * When a pasted slice leads with structural content — a `tag` / `analytic`
 * head, a doc-level heading (`pocket` / `hat` / `block`), or a whole
 * `card` / `analytic_unit` — and the cursor sits in a body slot of a
 * `card` / `analytic_unit`, split the destination so the pasted structure
 * WINS rather than being demoted to body text. Returns null otherwise so PM
 * handles the paste normally.
 *
 * The whole pasted structure is preserved (head AND its content), not just the
 * head: the clipboard's flat, open `[tag, card_body, …]` shape is re-grouped
 * into proper `card` / `analytic_unit` nodes first (`groupStructuralNodes`).
 * The destination splits at the cursor — the original container keeps the
 * pre-cursor children + pre-cursor body text; the pasted nodes land after it;
 * and the post-cursor remainder (post-body + following children) is absorbed
 * by the LAST pasted container (so two clean cards result, no phantom
 * empty-tag sibling). When the paste ends in a doc-level heading instead, the
 * remainder is ejected to the doc root and lifted.
 *
 * Exported for unit tests.
 */
export function tryPasteSplitContainer(
  state: EditorState,
  slice: Slice,
): Transaction | null {
  if (slice.content.childCount === 0) return null;
  const lead = slice.content.firstChild;
  if (!lead) return null;
  // Must lead with structural content; a plain body/inline paste falls through.
  if (!STRUCTURAL_HEAD_NAMES.has(lead.type.name) && !STRUCTURAL_CONTAINERS.has(lead.type.name)) {
    return null;
  }

  const flat: PMNode[] = [];
  slice.content.forEach((n) => flat.push(n));
  return buildContainerSplit(state, flat, []);
}

/**
 * Merge a leading run of pasted body content into the pre-cursor content of a
 * container split. The FIRST body paragraph merges INLINE into the cursor's body
 * (continuing the line); subsequent body paragraphs become their own `card_body`
 * blocks (paragraph breaks preserved); a typed node (`cite_paragraph` /
 * `undertag`) flushes the running body and lands as its own card child. Used by
 * the A4 path (`tryPasteBodyThenStructural`); the plain split passes an empty
 * prefix, which just yields the pre-cursor body (or nothing).
 */
function mergeBodyPrefix(
  preContent: Fragment,
  prefix: PMNode[],
  bodyType: NodeType,
): PMNode[] {
  const out: PMNode[] = [];
  let cur: Fragment | null = preContent.size > 0 ? preContent : null;
  let leadOpen = true; // the lead body can still absorb the first body inline
  for (const node of prefix) {
    if (BODY_PASTE_TYPES.has(node.type.name)) {
      if (leadOpen) {
        cur = (cur ?? Fragment.empty).append(node.content);
        leadOpen = false;
      } else {
        if (cur) out.push(bodyType.create(null, cur));
        cur = null;
        out.push(schema.nodes['card_body']!.create(null, node.content));
      }
    } else {
      if (cur) out.push(bodyType.create(null, cur));
      cur = null;
      leadOpen = false;
      out.push(fitForCard(node));
    }
  }
  if (cur) out.push(bodyType.create(null, cur));
  return out;
}

/**
 * Split the cursor's `card` / `analytic_unit` at the cursor and insert
 * `structuralFlat` (re-grouped into proper containers) after it, with any
 * leading `bodyPrefix` merged into the pre-cursor content. The destination keeps
 * its pre-cursor children + pre-cursor body (+ prefix); the pasted structure
 * lands after; the post-cursor remainder is absorbed by the LAST pasted
 * container, or lifted to the doc root when the paste ends in a doc-level
 * heading. Returns null when the cursor isn't in a splittable body slot.
 */
function buildContainerSplit(
  state: EditorState,
  structuralFlat: PMNode[],
  bodyPrefix: PMNode[],
): Transaction | null {
  const $from = state.selection.$from;
  if ($from.depth !== 2) return null;
  const cursorBody = $from.parent;
  if (!SPLITTABLE_BODY_SLOTS.has(cursorBody.type.name)) return null;
  const container = $from.node(1);
  if (!STRUCTURAL_CONTAINERS.has(container.type.name)) return null;

  let cursorIndex = -1;
  container.forEach((child, _o, idx) => {
    if (cursorIndex === -1 && child === cursorBody) cursorIndex = idx;
  });
  if (cursorIndex < 1) return null;

  // Re-group the (possibly flat, open) pasted nodes into doc-level containers.
  const pastedNodes = groupStructuralNodes(structuralFlat);
  if (pastedNodes.length === 0) return null;

  const parentOffset = $from.parentOffset;
  const preContent = cursorBody.content.cut(0, parentOffset);
  const postContent = cursorBody.content.cut(parentOffset);

  const beforeChildren: PMNode[] = [];
  const followingChildren: PMNode[] = [];
  container.forEach((child, _o, idx) => {
    if (idx < cursorIndex) beforeChildren.push(child);
    else if (idx > cursorIndex) followingChildren.push(child);
  });

  const bodyType = cursorBody.type;
  // Pre-cursor content (with any pasted body prefix merged in) + post-cursor tail.
  const preChildren = mergeBodyPrefix(preContent, bodyPrefix, bodyType);
  const postBody = postContent.size > 0 ? bodyType.create(null, postContent) : null;

  const originalChildren = [...beforeChildren, ...preChildren];
  const originalContainer = container.copy(Fragment.fromArray(originalChildren));

  // The destination's post-cursor remainder.
  const remainder: PMNode[] = [];
  if (postBody) remainder.push(postBody);
  remainder.push(...followingChildren);

  // Absorb the remainder into the LAST pasted container, or — if the paste
  // ends in a doc-level heading — eject + lift it to the doc root after.
  const last = pastedNodes[pastedNodes.length - 1]!;
  const lastName = last.type.name;
  let trailing: PMNode[] = [];
  if (lastName === 'card' || lastName === 'analytic_unit') {
    const fit = lastName === 'card' ? fitForCard : fitForAnalyticUnit;
    const lastKids: PMNode[] = [];
    last.forEach((c) => lastKids.push(c));
    pastedNodes[pastedNodes.length - 1] = last.copy(
      Fragment.fromArray([...lastKids, ...remainder.map(fit)]),
    );
  } else {
    trailing = remainder.map(liftToDocRoot);
  }

  const containerFrom = $from.before(1);
  const containerTo = $from.after(1);
  const replacement = Fragment.fromArray([originalContainer, ...pastedNodes, ...trailing]);
  let tr = state.tr.replaceWith(containerFrom, containerTo, replacement);

  // Cursor at the end of the FIRST pasted head's text — the F7/setHeading
  // convention, so the user can immediately edit the heading name.
  const afterOriginal = containerFrom + originalContainer.nodeSize;
  const firstDoc = pastedNodes[0]!;
  const head = STRUCTURAL_CONTAINERS.has(firstDoc.type.name) ? firstDoc.firstChild : firstDoc;
  const cursorPos = STRUCTURAL_CONTAINERS.has(firstDoc.type.name)
    ? afterOriginal + 2 + (head?.content.size ?? 0) // +1 into container, +1 into head
    : afterOriginal + 1 + (head?.content.size ?? 0); // +1 into the heading
  try {
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  } catch {
    /* schema rejected the position — selection stays where PM left it */
  }
  return tr;
}

/**
 * A pasted slice that LEADS with body content and THEN contains structural
 * content (a heading / tag / analytic / whole card) — e.g. a paragraph copied
 * together with a following heading. Neither `tryPasteCardContent` (bails on the
 * structural node) nor `tryPasteSplitContainer` (bails on the non-structural
 * lead) catches it, so it would otherwise fall to PM's default fitter and split
 * the card. Merge the leading body into the cursor's card, then split the card
 * at the first structural node — the same result as the structural-led split,
 * with the body prefix folded into the pre-cursor content.
 *
 * Cursor only (a range paste of this shape is left to the default path).
 * Exported for unit tests.
 */
export function tryPasteBodyThenStructural(
  state: EditorState,
  slice: Slice,
): Transaction | null {
  if (slice.content.childCount === 0) return null;
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.from !== sel.to) return null;

  const flat: PMNode[] = [];
  slice.content.forEach((n) => flat.push(n));

  // Split at the first structural node; everything before it must be fittable.
  let k = -1;
  for (let i = 0; i < flat.length; i++) {
    const name = flat[i]!.type.name;
    if (STRUCTURAL_HEAD_NAMES.has(name) || STRUCTURAL_CONTAINERS.has(name)) {
      k = i;
      break;
    }
  }
  if (k <= 0) return null; // no structural node, or it leads (handled elsewhere)
  const prefix = flat.slice(0, k);
  if (!prefix.every((n) => CARD_FITTABLE_PASTE.has(n.type.name))) return null;
  const rest = flat.slice(k);

  return buildContainerSplit(state, rest, prefix);
}

/**
 * Pre-fit a multi-paragraph PLAIN-TEXT paste into a `card_body` cursor:
 * convert each top-level paragraph in the slice to a `card_body` and
 * `replaceSelection`, so PM splits WITHIN the card instead of bubbling the
 * split up to the card level (which would spawn a phantom empty-tag sibling).
 * Used by the F2 / plain-text paste path. Returns null unless the slice is 2+
 * plain paragraphs and the cursor is in a `card_body` inside a card /
 * analytic_unit — a lone paragraph falls through to PM's inline merge.
 *
 * (Rich pastes of cite / undertag / body content go through
 * `tryPasteCardContent`, which implements the full card-paste matrix.)
 *
 * Exported for tests.
 */
export function tryPasteAsCardBodies(
  state: EditorState,
  slice: Slice,
): Transaction | null {
  if (slice.content.childCount < 2) return null;
  for (let i = 0; i < slice.content.childCount; i++) {
    if (slice.content.child(i).type.name !== 'paragraph') return null;
  }
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return null;
  const $from = sel.$from;
  if ($from.parent.type.name !== 'card_body') return null;
  if ($from.depth < 2) return null;
  const container = $from.node($from.depth - 1);
  if (container.type.name !== 'card' && container.type.name !== 'analytic_unit') {
    return null;
  }
  const cardBodyType = schema.nodes['card_body'];
  if (!cardBodyType) return null;
  const converted: PMNode[] = [];
  slice.content.forEach((p) => converted.push(cardBodyType.create(null, p.content)));
  const newSlice = new Slice(
    Fragment.fromArray(converted),
    slice.openStart,
    slice.openEnd,
  );
  return state.tr.replace(sel.from, sel.to, newSlice);
}

/** Pasted blocks that are body text (vs. a structural label). */
const BODY_PASTE_TYPES = new Set<string>(['card_body', 'paragraph']);
/** Textblocks that ABSORB pasted body text inline (content, not a label). */
const CONTENT_TEXTBLOCKS = new Set<string>(['card_body', 'cite_paragraph']);
/** Card-content slots the cursor can sit in that we fit a paste into. */
const CARD_CONTENT_SLOTS = new Set<string>([
  'card_body',
  'cite_paragraph',
  'undertag',
]);

/**
 * Fit a paste of card content (`cite_paragraph` / `undertag` / body) at the
 * cursor, per the card-paste matrix:
 *  - NEVER breaks the card; pasted block types are preserved.
 *  - Body text is absorbed INLINE into a `card_body` / `cite_paragraph`, and a
 *    same-type paste (cite→cite, undertag→undertag) merges; otherwise the block
 *    inserts as its OWN type, splitting the cursor's block (coalescing empty
 *    edges so there's no stray blank line).
 *  - An EMPTY target block is OVERWRITTEN.
 *  - OUTSIDE a card, content drops in loose (body → `paragraph`).
 *  - Pasting OVER a range selection collapses it first (the selected text is
 *    dropped), then the same matrix runs at the cursor — so pasting over a
 *    paragraph / selection inside a card never tears the card apart either.
 * Returns null for a `tag` / `analytic` / heading / whole closed `card` lead, so
 * the split path handles it — those SHOULD start a new card. Also null when a
 * range selection crosses a structural boundary (into a tag/heading, or between
 * two cards), leaving that rarer case to the default/split path.
 *
 * Exported for tests.
 */
export function tryPasteCardContent(
  state: EditorState,
  slice: Slice,
): Transaction | null {
  if (slice.content.childCount === 0) return null;

  // Unwrap a leading open card / analytic_unit (cite/body copied from inside a
  // card serializes WITH its container — openStart > 0, the tag cut off).
  const lead = slice.content.firstChild!;
  const unwrap =
    slice.content.childCount === 1 &&
    STRUCTURAL_CONTAINERS.has(lead.type.name) &&
    slice.openStart > 0;
  const srcFrag = unwrap ? lead.content : slice.content;
  if (srcFrag.childCount === 0) return null;

  // Every source block must be card-fittable; a tag / analytic / heading /
  // whole card lead bails to the split path — that one breaks the card.
  const blocks: PMNode[] = [];
  let fittable = true;
  srcFrag.forEach((b) => {
    if (!CARD_FITTABLE_PASTE.has(b.type.name)) fittable = false;
    blocks.push(b);
  });
  if (!fittable) return null;

  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return null;

  // Inside a card / analytic_unit? (decided from the selection anchor).
  let inCard = false;
  for (let d = sel.$from.depth; d >= 1; d--) {
    if (STRUCTURAL_CONTAINERS.has(sel.$from.node(d).type.name)) {
      inCard = true;
      break;
    }
  }

  // A RANGE selection — pasting OVER a paragraph / selection — must collapse to a
  // cursor FIRST, then fit. Otherwise PM's default replace of the open-card slice
  // over the range tears the card apart (a phantom empty-tag sibling). Only do
  // this when the whole selection stays in card-content textblocks of a SINGLE
  // container; a selection that reaches into a tag/heading or spans two cards
  // falls through to the default/split path so it isn't silently mangled.
  const tr = state.tr;
  if (sel.from !== sel.to) {
    if (!rangeFitsInOneContainer(sel.$from, sel.$to, inCard)) return null;
    tr.delete(sel.from, sel.to);
  }
  const $from = tr.selection.$from;

  // Outside a card → drop loose; body becomes a plain paragraph.
  if (!inCard) return fitBlocks(tr, blocks, $from, 'paragraph');

  // Cursor must be in a card-content slot (not the tag / analytic head).
  if (!CARD_CONTENT_SLOTS.has($from.parent.type.name)) return null;

  return fitBlocks(tr, blocks, $from, 'card_body');
}

/** Start position of the enclosing `card` / `analytic_unit`, or -1 at the doc
 *  root. Two positions with the same value live in the same container. */
function enclosingContainerStart($pos: ResolvedPos): number {
  for (let d = $pos.depth; d >= 1; d--) {
    if (STRUCTURAL_CONTAINERS.has($pos.node(d).type.name)) return $pos.before(d);
  }
  return -1;
}

/** A range paste is fit in place only when both ends sit in card-content
 *  textblocks of the SAME card (or both at the doc root, outside any card).
 *  Anything crossing a structural boundary — into a tag/heading, or from one
 *  card into another — is left to the default/split path so containers are
 *  never merged or torn. */
function rangeFitsInOneContainer(
  $from: ResolvedPos,
  $to: ResolvedPos,
  inCard: boolean,
): boolean {
  const inSlot = (p: ResolvedPos): boolean =>
    inCard
      ? CARD_CONTENT_SLOTS.has(p.parent.type.name)
      : p.parent.type.name === 'paragraph';
  if (!inSlot($from) || !inSlot($to)) return false;
  return enclosingContainerStart($from) === enclosingContainerStart($to);
}

/**
 * Place `blocks` at the cursor per the card-paste matrix. `bodyType` is what a
 * body block becomes — `card_body` inside a card, `paragraph` at the doc level.
 * A single block MERGES inline into a body-absorbing textblock (or its own type);
 * otherwise blocks insert as their own type, splitting the cursor's block and
 * coalescing empty edges. An EMPTY target is overwritten (filled), not split.
 * The cursor lands at the END of the pasted content, matching the in-card / F2
 * paste paths (so the user keeps typing after what they pasted).
 *
 * Operates on a caller-supplied `tr` whose selection is the (now collapsed)
 * insertion cursor — for a range paste the caller has already deleted the
 * selection, so `tr.selection` is the resulting cursor and `$from` resolves it.
 */
function fitBlocks(
  tr: Transaction,
  blocks: PMNode[],
  $from: ResolvedPos,
  bodyType: 'card_body' | 'paragraph',
): Transaction {
  const sel = tr.selection;
  const Bt = $from.parent.type.name;
  const Bempty = $from.parent.content.size === 0;
  // The destination's own bodyType textblock absorbs body text too (e.g. a
  // plain paragraph at the doc level behaves like a card_body inside a card).
  const absorbsBody = (t: string): boolean =>
    CONTENT_TEXTBLOCKS.has(t) || t === bodyType;

  // A single block can MERGE inline; a multi-block run always lands as blocks.
  if (blocks.length === 1 && !Bempty) {
    const P = blocks[0]!;
    const Pt = P.type.name;
    if ((BODY_PASTE_TYPES.has(Pt) && absorbsBody(Bt)) || Pt === Bt) {
      tr.replaceWith(sel.from, sel.to, P.content); // absorb inline; cursor after
      return tr;
    }
  }

  // Body → bodyType; cite / undertag keep their own type.
  const frag = Fragment.fromArray(
    blocks.map((b) =>
      BODY_PASTE_TYPES.has(b.type.name)
        ? schema.nodes[bodyType]!.create(null, b.content)
        : b,
    ),
  );

  let insertAt: number;
  if (Bempty) {
    insertAt = $from.before();
    tr.replaceWith($from.before(), $from.after(), frag); // fill the empty target
  } else if (sel.from === $from.start()) {
    insertAt = $from.before();
    tr.insert($from.before(), frag); // before B — no empty pre-edge
  } else if (sel.from === $from.end()) {
    insertAt = $from.after();
    tr.insert($from.after(), frag); // after B — no empty post-edge
  } else {
    tr.replaceSelection(new Slice(frag, 0, 0)); // split B, insert between
    return tr; // replaceSelection already lands the cursor after the content
  }
  // Land the cursor at the END of the pasted run (matches in-card / F2).
  tr.setSelection(Selection.near(tr.doc.resolve(insertAt + frag.size), -1));
  return tr;
}

/**
 * Re-parse the clipboard's `text/html` at the DOC level — no `context: $from`,
 * so PM's parser doesn't demote structural heads to fit the cursor's body slot.
 * Used as a fallback when the slice PM handed us has already had its leading
 * head flattened to inline content (it can, when fitting the slice to a
 * `card_body`'s `inline*` rule), so `tryPasteSplitContainer` can still recover
 * the true structure. Re-applies the plugin's `transformPasted` normalization
 * (fresh heading ids + single-cell-table unwrap), which the raw re-parse
 * bypasses. Returns null when there's no HTML or no DOM (headless).
 *
 * Exported for tests.
 */
export function reparseClipboardStructuralSlice(event: ClipboardEvent): Slice | null {
  if (typeof document === 'undefined') return null;
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (!html) return null;
  const wrap = document.createElement('div');
  wrap.innerHTML = normalizeWordClipboardHtml(html);
  const parsed = PMDOMParser.fromSchema(schema).parseSlice(wrap);
  if (parsed.content.childCount === 0) return null;
  return freshHeadingIds(unwrapSingleCellTables(parsed));
}
