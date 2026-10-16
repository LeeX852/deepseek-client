import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';

const SHELL_PARTITION = 'persist:shell';
let overlay: BrowserWindow | null = null;

export function showOfflineOverlay(reason: 'load-failed' | 'render-gone'): void {
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      width: 420, height: 260,
      title: '无法连接', autoHideMenuBar: true, resizable: false,
      webPreferences: {
        partition: SHELL_PARTITION,
        preload: path.join(app.getAppPath(), 'out/preload/overlay.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    overlay.on('closed', () => { overlay = null; });
    overlay.webContents.on('did-finish-load', () => {
      const text = reason === 'render-gone' ? '窗口进程意外退出，已重新加载。' : '网络不可达或站点无响应。';
      void overlay?.webContents.executeJavaScript(
        `document.getElementById('reason').textContent = ${JSON.stringify(text)}`);
    });
    void overlay.loadFile(path.join(app.getAppPath(), 'out/renderer/offline/index.html'));
  }
  overlay.show();
  overlay.focus();
}

export function hideOfflineOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

export function attachLoadGuards(win: BrowserWindow): void {
  // Electron 44 实测：主框架加载失败后，Chromium 错误页的 commit 会紧跟一条
  // did-fail-load 再触发一次 did-finish-load（事件顺序 fail→finish，探针复现）。
  // brief 里 did-finish-load 无条件 hide 会立刻关掉刚弹出的覆盖层。用一个随窗口
  // 生命周期走样的 failed 标志把"错误页 commit"和"真的加载成功"区分开。
  let failed = false;
  // 窗口可能因 activate 或重载而重建，先摘掉旧监听避免 retry 被处理多次
  ipcMain.removeAllListeners('overlay:retry');
  ipcMain.on('overlay:retry', (e) => {
    if (e.sender.id !== overlay?.webContents.id) return;
    hideOfflineOverlay();
    failed = false;
    void win.webContents.reload();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    failed = true;
    showOfflineOverlay('load-failed');
    console.warn(`[shell] load failed code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    if (failed) {
      // 这条 finish 是错误页自己的 commit，不是恢复；标志消费掉，覆盖层留在原位。
      failed = false;
      return;
    }
    hideOfflineOverlay();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[shell] renderer gone ' + details.reason);
    showOfflineOverlay('render-gone');
    void win.webContents.reload();
  });
}
