import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { countReadAloudWords } from '../../src/editor/word-count.js';

function cardBodyRuns(...runs: any[]) {
  return schema.nodes['card_body']!.create(null, runs);
}

function makeDoc(...children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

describe('countReadAloudWords', () => {
  it('counts protected background highlighting as read-aloud body text', () => {
    const shading = schema.marks['shading']!.create({ color: 'D2D2D2' });
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const doc = makeDoc(
      cardBodyRuns(
        schema.text('plain '),
        schema.text('protected words', [shading]),
        schema.text(' '),
        schema.text('normal', [highlight]),
      ),
    );

    expect(countReadAloudWords(doc)).toBe(3);
  });
});
