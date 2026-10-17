import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import type { ArchiveStore } from './archive/store';

export type SearchItem = { id: string; title: string; updatedAt: number };

// I-4：SEARCH_QUERY 曾是唯一没做发送方校验的入站 IPC——任意渲染进程（含被注入的
// 远端页面）都能 invoke 它枚举全部归档标题。handler 抽成纯函数，只吃
// (senderId, arg, store, 期望搜索窗 id)，脱离 Electron 可单测；ipcMain.handle 只做接线。
// 非搜索窗 sender 一律返回空数组，不泄露任何标题。
export function buildSearchQueryHandler(deps: {
  store: ArchiveStore;
  expectedSearchWindowId(): number;
}): (senderId: number, arg: unknown) => SearchItem[] {
  return (senderId, arg) => {
    if (senderId !== deps.expectedSearchWindowId()) return [];
    const query = typeof (arg as { query?: unknown })?.query === 'string'
      ? (arg as { query: string }).query.trim().toLowerCase()
      : '';
    const items = deps.store.list().sort((a, b) => b.updatedAt - a.updatedAt);
    return query ? items.filter(i => i.title.toLowerCase().includes(query)) : items.slice(0, 50);
  };
}

let win: BrowserWindow | null = null;
export function openSearchWindow(store: ArchiveStore, onJump: (title: string) => void): void {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 520, height: 420, title: '搜索会话', show: false,
    webPreferences: { partition: 'persist:shell', preload: path.join(app.getAppPath(), 'out/preload/search.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const handler = buildSearchQueryHandler({ store, expectedSearchWindowId: () => win?.webContents.id ?? -1 });
  ipcMain.removeHandler(IPC.SEARCH_QUERY);
  ipcMain.handle(IPC.SEARCH_QUERY, (event, arg: unknown) => handler(event.sender.id, arg));
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
