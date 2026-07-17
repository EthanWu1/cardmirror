import type { Node as PMNode } from 'prosemirror-model';

export type DirtyCompareFormat = 'cmir' | 'docx' | null;

function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizedText(doc: PMNode): string {
  return normalizeWhitespace(doc.textBetween(0, doc.content.size, '\n', '\n'));
}

function anonymizeTextInJson(value: unknown, normalizeText: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => anonymizeTextInJson(item, normalizeText));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'text' && typeof child === 'string') {
      out[key] = normalizeText ? normalizeWhitespace(child) : '';
    } else {
      out[key] = anonymizeTextInJson(child, normalizeText);
    }
  }
  return out;
}

function docShape(doc: PMNode): string {
  return JSON.stringify(anonymizeTextInJson(doc.toJSON(), false));
}

function normalizedDocJson(doc: PMNode): string {
  return JSON.stringify(anonymizeTextInJson(doc.toJSON(), true));
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diffs > 1) return false;
    }
    return true;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let skips = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      skips++;
      if (skips > 1) return false;
      j++;
    }
  }
  return true;
}

/**
 * Dirty-state comparison for close prompts.
 *
 * Native `.cmir` stays exact because it supports autosave/co-edit metadata.
 * Word files get a small grace window: transient whitespace churn and a single
 * accidental text character do not force a save prompt, but formatting,
 * structure, and real text edits still do.
 */
export function isMeaningfullyDirtyFromBaseline(
  baseline: PMNode | null | undefined,
  current: PMNode,
  format: DirtyCompareFormat,
): boolean {
  if (!baseline) return true;
  if (baseline.eq(current)) return false;
  if (format !== 'docx') return true;
  if (normalizedDocJson(baseline) === normalizedDocJson(current)) return false;
  if (docShape(baseline) !== docShape(current)) return true;
  return !withinOneEdit(normalizedText(baseline), normalizedText(current));
}
