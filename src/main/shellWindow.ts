import { app, BrowserWindow, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { browserLikeUA } from './ua';

export const REMOTE_URL = process.env.DS_SHELL_URL ?? 'https://chat.deepseek.com/';
export const DEEPSEEK_PARTITION = 'persist:deepseek';

const ALLOWED_HOSTS = new Set(['chat.deepseek.com', 'deepseek.com', 'www.deepseek.com', 'cdn.deepseek.com', 'ssl.cdn.one', 'accounts.google.com', 'github.com', 'appleid.apple.com']);

let win: BrowserWindow | null = null;

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && [...ALLOWED_HOSTS].some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

export function createShellWindow(): BrowserWindow {
  const preload = path.join(app.getAppPath(), 'out/preload/deepseek.js');
  win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    title: 'DeepSeek',
    icon: path.join(app.getAppPath(), 'out/resources/icon.png'),
    webPreferences: {
      partition: DEEPSEEK_PARTITION,
      // Electron 的 WebPreferences.preload 类型是 `preload?: string`（不含 undefined），
      // 在 exactOptionalPropertyTypes 下只能整体省略这个键。
      ...(existsSync(preload) ? { preload } : {}),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });

  const ses = session.fromPartition(DEEPSEEK_PARTITION);
  ses.setUserAgent(browserLikeUA(ses.getUserAgent()));

  win.once('ready-to-show', () => win?.show());
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  void win.loadURL(REMOTE_URL, { userAgent: browserLikeUA(session.defaultSession.getUserAgent()) });
  return win;
}

export function getShellWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
