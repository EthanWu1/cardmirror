import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');

describe('desktop update publishing', () => {
  test('desktop app publishes updates from the user fork, not upstream', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
    ) as {
      homepage?: string;
      build: {
        publish: { provider: string; owner: string; repo: string };
      };
    };
    const main = readFileSync(join(repoRoot, 'apps', 'desktop', 'src', 'main.ts'), 'utf8');

    expect(pkg.homepage).toBe('https://github.com/EthanWu1/cardmirror');
    expect(pkg.build.publish).toEqual({
      provider: 'github',
      owner: 'EthanWu1',
      repo: 'cardmirror',
    });
    expect(main).toContain("const RELEASES_URL = 'https://github.com/EthanWu1/cardmirror/releases';");
    expect(main).not.toContain('https://github.com/ant981228/cardmirror/releases');
  });

  test('mac builds include zip artifacts for electron-updater metadata', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
    ) as {
      build: {
        mac: {
          target: Array<{ target: string; arch: string[] }>;
        };
      };
    };
    const targets = pkg.build.mac.target.map((entry) => entry.target).sort();
    const dmg = pkg.build.mac.target.find((entry) => entry.target === 'dmg');
    const zip = pkg.build.mac.target.find((entry) => entry.target === 'zip');

    expect(targets).toEqual(['dmg', 'zip']);
    expect(dmg?.arch).toEqual(['x64', 'arm64']);
    expect(zip?.arch).toEqual(['x64', 'arm64']);
  });

  test('manual mac workflow uploads dmg and zip artifacts', () => {
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'mac-desktop.yml'), 'utf8');

    expect(workflow).toContain('electron-builder --mac dmg zip --arm64 --publish never');
    expect(workflow).toContain('electron-builder --mac dmg zip --x64 --publish never');
    expect(workflow).toContain('apps/desktop/release/*.dmg');
    expect(workflow).toContain('apps/desktop/release/*.zip');
    expect(workflow).toContain('apps/desktop/release/latest-mac.yml');
  });
});
