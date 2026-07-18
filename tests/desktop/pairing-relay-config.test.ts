import { describe, expect, it } from 'vitest';
import {
  normalizeRelayBaseUrl,
  resolvePairingRelayConfig,
} from '../../apps/desktop/src/pairing-relay-config.js';

describe('desktop pairing relay config', () => {
  it('keeps baked private relay defaults ahead of stale saved custom settings', () => {
    expect(
      resolvePairingRelayConfig({
        settingsUrl: 'http://5.78.181.236:8410/relay',
        settingsToken: 'old-wrong-token',
        defaultUrl: 'https://verba.top/relay',
        defaultToken: 'baked-token',
        entitlementToken: 'old-entitlement',
      }),
    ).toEqual({ url: 'https://verba.top/relay', token: 'baked-token' });
  });

  it('uses custom relay settings only when no baked private relay is available', () => {
    expect(
      resolvePairingRelayConfig({
        settingsUrl: 'https://relay.example.com',
        settingsToken: 'custom-token',
        defaultUrl: '',
        defaultToken: '',
        entitlementToken: 'old-entitlement',
      }),
    ).toEqual({ url: 'https://relay.example.com/relay', token: 'custom-token' });
  });

  it('falls back to entitlement only when no shared default token exists', () => {
    expect(
      resolvePairingRelayConfig({
        settingsUrl: '',
        settingsToken: 'stale',
        defaultUrl: 'https://verba.top',
        defaultToken: '',
        entitlementToken: 'account-token',
      }),
    ).toEqual({ url: 'https://verba.top/relay', token: 'account-token' });
  });

  it('normalizes relay URLs the same way as the renderer', () => {
    expect(normalizeRelayBaseUrl('https://relay.example.com/base')).toBe(
      'https://relay.example.com/base/relay',
    );
  });
});
