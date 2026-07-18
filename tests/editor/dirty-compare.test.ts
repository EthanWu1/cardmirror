import { describe, expect, it } from 'vitest';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { isMeaningfullyDirtyFromBaseline } from '../../src/editor/dirty-compare.js';

const n = schema.nodes;
const m = schema.marks;

function para(text: string, marks: Mark[] = []) {
  return n['paragraph']!.create(null, text ? schema.text(text, marks) : null);
}

function doc(...children: PMNode[]) {
  return n['doc']!.createChecked(null, children);
}

describe('dirty comparison', () => {
  it('treats an exact return to the opened baseline as clean', () => {
    const baseline = doc(para('abc'));
    expect(isMeaningfullyDirtyFromBaseline(baseline, doc(para('abc')), 'cmir')).toBe(false);
  });

  it('ignores whitespace-only churn for docx files', () => {
    const baseline = doc(para('Rising costs harm productivity.'));
    const edited = doc(para('  Rising   costs harm productivity.  '));
    expect(isMeaningfullyDirtyFromBaseline(baseline, edited, 'docx')).toBe(false);
  });

  it('ignores a one-character accidental docx text drift', () => {
    const baseline = doc(para('Rising costs harm productivity.'));
    const edited = doc(para('Rising costs harm productivity.!'));
    expect(isMeaningfullyDirtyFromBaseline(baseline, edited, 'docx')).toBe(false);
  });

  it('keeps real docx text edits dirty', () => {
    const baseline = doc(para('Rising costs harm productivity.'));
    const edited = doc(para('Falling costs improve productivity.'));
    expect(isMeaningfullyDirtyFromBaseline(baseline, edited, 'docx')).toBe(true);
  });

  it('keeps docx formatting edits dirty even when text is the same', () => {
    const baseline = doc(para('Rising costs harm productivity.'));
    const edited = doc(para('Rising costs harm productivity.', [m['bold']!.create()]));
    expect(isMeaningfullyDirtyFromBaseline(baseline, edited, 'docx')).toBe(true);
  });
});
