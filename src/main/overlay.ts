import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';
// R27：壳窗口被真销毁后，重试的唯一正确出路是重建壳。overlay ↔ shellWindow 是
// 运行期循环依赖（两边都只在函数体内调用对方），ESM/esbuild 的函数声明提升兜住；
// 若这里不引 showOrFocusShell，就得把壳的重建逻辑复制一份到覆盖层模块里。
import { showOrFocusShell } from './shellWindow';

const SHELL_PARTITION = 'persist:shell';
type OverlayReason = 'load-failed' | 'render-gone';

// 文案只来自这个封闭枚举：页面可控的 desc/url 字符串永不进 DOM。
const REASON_TEXT: Record<OverlayReason, string> = {
  'load-failed': '网络不可达或站点无响应。',
  'render-gone': '窗口进程意外退出，已重新加载。',
};

let overlay: BrowserWindow | null = null;
// 覆盖层当前文案属于哪个 reason。必须是模块状态而不是创建期的闭包（R29）：
// 规格降级表给两个 reason 两条不同文案，先 load-failed 后 render-gone 时必须换措辞。
let overlayReason: OverlayReason = 'load-failed';

function writeReason(win: BrowserWindow): void {
  void win.webContents.executeJavaScript(
    `document.getElementById('reason').textContent = ${JSON.stringify(REASON_TEXT[overlayReason])}`);
}

export function showOfflineOverlay(reason: OverlayReason): void {
  if (!overlay || overlay.isDestroyed()) {
    overlayReason = reason;
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
      if (overlay && !overlay.isDestroyed()) writeReason(overlay);
    });
    void overlay.loadFile(path.join(app.getAppPath(), 'out/renderer/offline/index.html'));
  } else if (overlayReason !== reason) {
    // 覆盖层已在位：只刷新文案，不新建窗口（did-finish-load 设置器读同一份状态）
    overlayReason = reason;
    writeReason(overlay);
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
    // R27：closeToTray=false 时用户关窗 → shellWindow 的 close 放行、window-all-closed
    // 故意空转 → 覆盖层成为唯一窗口。此时对已销毁的 win.webContents 取 reload() 会抛
    // "Object has been destroyed"，异常落在 ipcMain handler 里 = 主进程未捕获异常：
    // 退出绕过 will-quit（R25/R22 的幽灵托盘缺陷复活），或留下一个 0 窗口的躯壳。
    // 壳没了就重建壳，绝不碰那个已销毁的实例。
    if (win.isDestroyed()) {
      showOrFocusShell();
      return;
    }
    void win.webContents.reload();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    failed = true;
    showOfflineOverlay('load-failed');
    console.warn(`[shell] load failed code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    const wasFailed = failed;
    failed = false;
    // R29：吞只为"覆盖层真的在位时的那次错误页 commit"服务。覆盖层不在位，吞住这条
    // finish 保护不了任何东西，还会把它后面那条真正的成功加载当成错误页。
    if (wasFailed && overlay && !overlay.isDestroyed()) return;
    hideOfflineOverlay();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[shell] renderer gone ' + details.reason);
    // 这条事件来自 win 自己的 webContents，触发时窗口必然还活着，无需 R27 那样的销毁检查。
    showOfflineOverlay('render-gone');
    void win.webContents.reload();
  });
}
