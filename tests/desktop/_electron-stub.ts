// Stub the 'electron' module surface the fast-paste-bridge uses,
// so vitest can run desktop-module tests without a real Electron
// install in the project root.

export const sentToRenderer: Array<{ channel: string; payload: any }> = [];
export const ipcListeners = new Map<string, Array<(evt: unknown, ack: any) => void>>();

const fakeWebContents = {
  send: (channel: string, payload: any) => {
    sentToRenderer.push({ channel, payload });
  },
};
const makeWin = () => ({ webContents: fakeWebContents, isDestroyed: () => false });

let mockFocusedWindow: ReturnType<typeof makeWin> | null = makeWin();
let mockAllWindows: ReturnType<typeof makeWin>[] = [mockFocusedWindow];

export function setMockFocusedWindow(win: ReturnType<typeof makeWin> | null): void {
  mockFocusedWindow = win;
  mockAllWindows = win ? [win] : [];
}

export function resetElectronStub(userDataPath: string): void {
  sentToRenderer.length = 0;
  ipcListeners.clear();
  const win = makeWin();
  setMockFocusedWindow(win);
  (app as any).__userData = userDataPath;
}

export const app = {
  __userData: '/tmp',
  getPath: (name: string) => {
    if (name === 'userData') return (app as any).__userData as string;
    return (app as any).__userData as string;
  },
  getVersion: () => 'TEST-1.2.3',
};

export const BrowserWindow = {
  getFocusedWindow: () => mockFocusedWindow,
  getAllWindows: () => mockAllWindows,
};

export const ipcMain = {
  on: (channel: string, listener: (evt: unknown, ack: any) => void) => {
    const arr = ipcListeners.get(channel) ?? [];
    arr.push(listener);
    ipcListeners.set(channel, arr);
  },
  removeListener: (channel: string, listener: (evt: unknown, ack: any) => void) => {
    const arr = ipcListeners.get(channel);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
  },
};
