import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chunkText,
  TRANSLATION_LANGUAGES,
  languageName,
  buildTranslationMarker,
  TRANSLATION_MARKER_NAMES,
  translateText,
} from '../../src/editor/translate.js';
import { compileShrinkProtections } from '../../src/editor/ribbon-commands.js';
import { settings } from '../../src/editor/settings.js';

describe('chunkText (MyMemory request splitting)', () => {
  it('returns the text whole when under the limit', () => {
    expect(chunkText('short text', 480)).toEqual(['short text']);
  });

  it('every chunk stays within the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `This is sentence number ${i} with some words.`).join(' ');
    const chunks = chunkText(text, 100);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it('rejoining the chunks reproduces the original text exactly', () => {
    const text = 'Alpha. Beta! Gamma? Delta.\nEpsilon zeta eta theta iota kappa lambda mu nu xi omicron pi.';
    const chunks = chunkText(text, 30);
    expect(chunks.join('')).toBe(text);
  });

  it('hard-splits an oversized atom with no break points', () => {
    const text = 'x'.repeat(1000);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(10);
    expect(chunks.join('')).toBe(text);
  });
});

describe('TRANSLATION_LANGUAGES', () => {
  it('includes English and uses ISO 639-1 codes', () => {
    expect(TRANSLATION_LANGUAGES.find((l) => l.code === 'en')?.name).toBe('English');
    for (const l of TRANSLATION_LANGUAGES) expect(l.code).toMatch(/^[a-z]{2}$/);
  });

  it('languageName falls back to the raw code', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('zz')).toBe('zz');
  });
});

describe('translation marker', () => {
  it('wraps the attribution in the default condense delimiter', () => {
    // Fresh test env → condenseWarningDelimiter defaults to '['.
    expect(buildTranslationMarker('MYMEMORY')).toBe('[TRANSLATION BY MYMEMORY]');
    expect(buildTranslationMarker('OPUS 4.8')).toBe('[TRANSLATION BY OPUS 4.8]');
  });

  it('every possible marker is protected from Shrink', () => {
    const patterns = compileShrinkProtections([], '', '');
    for (const name of TRANSLATION_MARKER_NAMES) {
      const marker = buildTranslationMarker(name);
      const matched = patterns.some((re) => {
        re.lastIndex = 0;
        return re.test(marker);
      });
      expect(matched, `unprotected: ${marker}`).toBe(true);
    }
  });
});

describe('anthropic translation limits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    settings.set('aiFeaturesEnabled', false);
    settings.set('anthropicApiKey', '');
    settings.set('translationProvider', 'auto');
  });

  function stubAnthropic(stopReason: string) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Hola mundo' }],
          stop_reason: stopReason,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    settings.set('aiFeaturesEnabled', true);
    settings.set('anthropicApiKey', 'sk-test');
    settings.set('translationProvider', 'anthropic');
    return fetchMock;
  }

  it('requests a translation-sized output ceiling, not the 1024 chat default', async () => {
    const fetchMock = stubAnthropic('end_turn');
    const out = await translateText('Hello world');
    expect(out.text).toBe('Hola mundo');
    expect(out.truncated).toBeFalsy();
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(16000);
  });

  it('flags a max_tokens stop as truncated instead of passing it off as complete', async () => {
    stubAnthropic('max_tokens');
    const out = await translateText('Hello world');
    expect(out.truncated).toBe(true);
  });
});
