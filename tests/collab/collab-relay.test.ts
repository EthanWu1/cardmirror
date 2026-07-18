import { describe, expect, it } from 'vitest';
import {
  normalizeRelayBaseUrl,
  resolveRelayClientConfig,
} from '../../src/editor/collab/collab-relay.js';

describe('collab relay URL normalization', () => {
  it('adds the relay API prefix when the user enters a bare host', () => {
    expect(normalizeRelayBaseUrl('https://scouting-assistant.up.railway.app')).toBe(
      'https://scouting-assistant.up.railway.app/relay',
    );
    expect(normalizeRelayBaseUrl('https://scouting-assistant.up.railway.app/')).toBe(
      'https://scouting-assistant.up.railway.app/relay',
    );
  });

  it('preserves relay URLs that already include the API prefix', () => {
    expect(normalizeRelayBaseUrl('https://relay.example.com/relay/')).toBe(
      'https://relay.example.com/relay',
    );
    expect(normalizeRelayBaseUrl('http://127.0.0.1:3200/relay')).toBe(
      'http://127.0.0.1:3200/relay',
    );
  });

  it('adds the prefix after a deployment base path', () => {
    expect(normalizeRelayBaseUrl('https://example.com/cardmirror')).toBe(
      'https://example.com/cardmirror/relay',
    );
  });

  it('ignores a stale custom token when no custom relay URL is set', () => {
    expect(
      resolveRelayClientConfig({
        settingsUrl: '',
        settingsToken: 'old-account-or-wrong-token',
        baked: { url: 'https://verba.top/relay', token: 'baked-token' },
      }),
    ).toEqual({ url: 'https://verba.top/relay', token: 'baked-token' });
  });

  it('uses a custom token only with a custom relay URL', () => {
    expect(
      resolveRelayClientConfig({
        settingsUrl: 'https://relay.example.com',
        settingsToken: 'custom-token',
        baked: { url: 'https://verba.top/relay', token: 'baked-token' },
      }),
    ).toEqual({ url: 'https://relay.example.com/relay', token: 'custom-token' });
  });

  it('uses the baked token when the custom URL is just the baked relay URL', () => {
    expect(
      resolveRelayClientConfig({
        settingsUrl: 'https://verba.top',
        settingsToken: '',
        baked: { url: 'https://verba.top/relay', token: 'baked-token' },
      }),
    ).toEqual({ url: 'https://verba.top/relay', token: 'baked-token' });
  });

  it('ignores a stale custom token when the URL is the baked relay URL', () => {
    expect(
      resolveRelayClientConfig({
        settingsUrl: 'https://verba.top/relay',
        settingsToken: 'old-wrong-token',
        baked: { url: 'https://verba.top/relay', token: 'baked-token' },
      }),
    ).toEqual({ url: 'https://verba.top/relay', token: 'baked-token' });
  });

  it('trims baked and dev relay tokens before making requests', () => {
    expect(
      resolveRelayClientConfig({
        settingsUrl: '',
        settingsToken: '',
        baked: { url: ' https://verba.top/relay ', token: '  baked-token\n' },
      }),
    ).toEqual({ url: 'https://verba.top/relay', token: 'baked-token' });

    expect(
      resolveRelayClientConfig({
        settingsUrl: '',
        settingsToken: '',
        dev: { url: ' https://relay.example.com/relay ', token: '\tdev-token ' },
        baked: { url: 'https://verba.top/relay', token: 'baked-token' },
      }),
    ).toEqual({ url: 'https://relay.example.com/relay', token: 'dev-token' });
  });
});
