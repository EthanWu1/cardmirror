import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('macOS entitlements packaging config', () => {
  it('keeps the codesign entitlements plist ASCII-only', () => {
    const file = join(process.cwd(), 'apps', 'desktop', 'build', 'entitlements.mac.plist');
    const bytes = readFileSync(file);
    const nonAscii = [...bytes].filter((byte) => byte > 0x7f);

    expect(nonAscii).toEqual([]);
  });
});
