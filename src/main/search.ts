import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import type { ArchiveStore } from './archive/store';

let win: BrowserWindow | null = null;
export function openSearchWindow(store: ArchiveStore, onJump: (title: string) => void): void {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 520, height: 420, title: '搜索会话', show: false,
    webPreferences: { partition: 'persist:shell', preload: path.join(app.getAppPath(), 'out/preload/search.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  ipcMain.removeHandler(IPC.SEARCH_QUERY);
  ipcMain.handle(IPC.SEARCH_QUERY, (_e, arg: unknown) => {
    const query = typeof (arg as { query?: unknown })?.query === 'string' ? (arg as { query: string }).query.trim().toLowerCase() : '';
    const items = store.list().sort((a, b) => b.updatedAt - a.updatedAt);
    return query ? items.filter(i => i.title.toLowerCase().includes(query)) : items.slice(0, 50);
  });
  ipcMain.removeAllListeners(IPC.SEARCH_JUMP);
  ipcMain.on(IPC.SEARCH_JUMP, (e, arg: unknown) => {
    if (e.sender.id !== win?.webContents.id) return;
    const title = typeof (arg as { title?: unknown })?.title === 'string' ? (arg as { title: string }).title : '';
    if (title) onJump(title);
  });
  win.on('closed', () => { win = null; });
  void win.loadFile(path.join(app.getAppPath(), 'out/renderer/search/index.html'));
  win.once('ready-to-show', () => { win?.show(); win?.focus(); });
}
export function closeSearchWindow(): void { if (win && !win.isDestroyed()) win.close(); win = null; }
