import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const mainSource = await fs.readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'main.ts'), 'utf8');
const preloadSource = await fs.readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'preload.ts'), 'utf8');
const hostSource = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'host', 'electron-host.ts'), 'utf8');
const hostTypes = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'host', 'types.ts'), 'utf8');
const indexSource = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8');

describe('frameless desktop window controls', () => {
  it('uses a frameless BrowserWindow and exposes safe window commands to the renderer', () => {
    expect(mainSource).toContain('frame: false');
    expect(mainSource).toContain("ipcMain.handle('host:window-command'");
    expect(mainSource).toContain('win.close();');
    expect(preloadSource).toContain('windowCommand:');
    expect(preloadSource).toContain("ipcRenderer.invoke('host:window-command'");
    expect(hostTypes).toContain("windowCommand(action: 'minimize' | 'maximize-or-restore' | 'close'): Promise<void>;");
    expect(hostSource).toContain('windowCommand(');
    expect(indexSource).toContain("wireWindowButton('window-close-btn', 'close')");
  });

  it('maximizes new desktop windows without fullscreen or kiosk mode', () => {
    expect(mainSource).toMatch(/const win = new BrowserWindow\([\s\S]*?\);\s*win\.maximize\(\);/);
    expect(mainSource).not.toContain('fullscreen: true');
    expect(mainSource).not.toContain('kiosk: true');
  });

  it('uses native fullscreen for the maximize control on macOS', () => {
    expect(mainSource).toContain("process.platform === 'darwin'");
    expect(mainSource).toContain('win.setFullScreen(!win.isFullScreen());');
  });
});
