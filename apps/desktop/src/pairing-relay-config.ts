export function normalizeRelayBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/relay';
      return url.toString().replace(/\/+$/, '');
    }
    if (!url.pathname.toLowerCase().endsWith('/relay')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/relay`;
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    /* Relative/test URL fallback below. */
  }
  return /(?:^|\/)relay$/i.test(trimmed) ? trimmed : `${trimmed}/relay`;
}

export function resolvePairingRelayConfig(input: {
  settingsUrl: string;
  settingsToken: string;
  defaultUrl: string;
  defaultToken: string;
  entitlementToken?: string;
}): { url: string; token: string } {
  const defaultUrl = normalizeRelayBaseUrl(input.defaultUrl);
  const defaultToken = input.defaultToken.trim();
  if (defaultUrl && defaultToken) return { url: defaultUrl, token: defaultToken };

  const customUrl = normalizeRelayBaseUrl(input.settingsUrl);
  const customToken = input.settingsToken.trim();
  if (customUrl) return { url: customUrl, token: customToken };

  const entitlementToken = (input.entitlementToken ?? '').trim();
  if (defaultUrl && entitlementToken) return { url: defaultUrl, token: entitlementToken };
  return { url: defaultUrl, token: defaultToken };
}
