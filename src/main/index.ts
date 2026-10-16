import { app, BrowserWindow } from 'electron';
import { createShellWindow, initShell, quitApp, showOrFocusShell, toggleShell } from './shellWindow';
import { userDataDir } from './paths';

if (process.env.DS_SHELL_USER_DATA) {
  app.setPath('userData', process.env.DS_SHELL_USER_DATA);
}

// 测试钩子（brief Step 4「暴露测试钩子」）：只在 DS_SHELL_TEST_HOOKS 置位时挂载，
// 生产启动路径不留任何全局。生命周期 API 只能由主进程调用，而 e2e 必须在同一个
// 同步 tick 内连续构造两个壳窗口——正常启动做不到，ready-to-show/closed 的
// 「绑定到模块级当前窗口指针」缺陷就永远无法回归。
if (process.env.DS_SHELL_TEST_HOOKS) {
  (globalThis as unknown as { __dsShellTestHooks: unknown }).__dsShellTestHooks = {
    createShellWindow,
    showOrFocusShell,
  };
}

// 单实例锁：重复启动不开第二个登录态，而是唤起已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggleShell());

  // 顶层 `await app.whenReady()` 在 ESM 入口会死锁（Task 2 踩过），只能用 then。
  void app.whenReady().then(() => {
    initShell(userDataDir());
    createShellWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createShellWindow();
    });
  });

  // before-quit 里再调 quitApp 会二次 app.quit()；quitters 标志让第二次空转，
  // 这是刻意的幂等设计，保证任何退出路径都先落盘窗口状态。
  app.on('before-quit', () => { quitApp(); });
}
