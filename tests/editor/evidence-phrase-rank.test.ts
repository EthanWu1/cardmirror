/**
 * Phrase priority in evidence search.
 *
 * A multi-word query whose words appear TOGETHER, in order, must outrank the
 * same words scattered across a long body. Before the phrase tiers, "climate
 * change" in a tag ranked no higher than a body that happened to contain
 * "climate" near the top and "change" near the bottom — and since bodies are
 * long, scattered matches outnumbered real phrase hits, so results read as
 * random (field report, 2026-09-15).
 */

import { describe, expect, it } from 'vitest';
import {
  searchEvidenceRows,
  searchEvidenceRowsAsync,
  type EvidenceSearchRow,
} from '../../src/editor/file-search.js';

let seq = 0;
function row(text: string, over: Partial<EvidenceSearchRow> = {}): EvidenceSearchRow {
  seq += 1;
  return {
    kind: 'body',
    filePath: `C:\files\${seq}.cmir`,
    fileName: `file${seq}`,
    relPath: `${seq}.cmir`,
    // Newer rows first within a tier — so give the SCATTERED row the newer
    // mtime: if it still loses, the phrase tier is doing the work, not recency.
    mtimeMs: 1_000 - seq,
    label: '',
    text,
    snippet: '',
    anchor: { quote: text.slice(0, 20), prefix: '', suffix: '', approxPos: 0 },
    from: 1,
    to: 1 + text.length,
    ...over,
  };
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('evidence search phrase priority', () => {
  it('ranks the words together above the same words scattered across a body', () => {
    const scattered = row(`climate ${filler(300)} change`); // seq 1, newest
    const together = row(`the effects of climate change on policy`);
    const out = searchEvidenceRows([scattered, together], 'climate change');
    expect(out.map((r) => r.text)).toEqual([together.text, scattered.text]);
  });

  it('still finds the phrase across a line break or extra whitespace', () => {
    const scattered = row(`climate ${filler(300)} change`);
    const broken = row(`rising seas from climate\n   change are accelerating`);
    const out = searchEvidenceRows([scattered, broken], 'climate change');
    expect(out[0]?.text).toBe(broken.text);
  });

  it('a phrase starting at a word boundary beats one buried mid-word', () => {
    const midWord = row(`microclimate change zones`);         // "climate change" inside "microclimate"
    const boundary = row(`global climate change trends`);
    const out = searchEvidenceRows([midWord, boundary], 'climate change');
    expect(out.map((r) => r.text)).toEqual([boundary.text, midWord.text]);
  });

  it('prefix still beats phrase-in-the-middle', () => {
    const middle = row(`on the topic of climate change`);
    const prefix = row(`climate change is the topic`);
    const out = searchEvidenceRows([middle, prefix], 'climate change');
    expect(out[0]?.text).toBe(prefix.text);
  });

  it('single-word queries are unaffected', () => {
    const a = row(`warming ${filler(50)}`);
    const b = row(`${filler(50)} warming`);
    const out = searchEvidenceRows([a, b], 'warming');
    expect(out).toHaveLength(2);
  });

  it('the async path ranks identically', async () => {
    const scattered = row(`climate ${filler(300)} change`);
    const together = row(`the effects of climate change on policy`);
    const sync = searchEvidenceRows([scattered, together], 'climate change').map((r) => r.text);
    const async = (await searchEvidenceRowsAsync([scattered, together], 'climate change')).map((r) => r.text);
    expect(async).toEqual(sync);
    expect(async[0]).toBe(together.text);
  });
});
