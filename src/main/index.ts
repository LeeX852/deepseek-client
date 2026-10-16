import { app, BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';
import { createShellWindow, initShell, onShellEvent, quitApp, showOrFocusShell } from './shellWindow';
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
    // R20 回归：quit 广播次数只有主进程内的监听器数得到。记录器把每条壳事件
    // 同步追加进文件，进程退出后 e2e 仍能从磁盘核对 'quit' 的真实次数。
    quitApp,
    recordShellEvents: (file: string) => {
      onShellEvent((e) => { appendFileSync(file, `${e}\n`); });
    },
  };
}

// 单实例锁：重复启动不开第二个登录态，而是唤起已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // R19 裁决（brief 原文写的是 toggleShell，此处以裁决为准）：规格要求
  // "重复启动唤起已有窗口"。toggleShell 在"可见且聚焦"时是隐藏窗口——用户双击
  // 图标/再次执行可执行文件看到的却是窗口消失，语义正好相反。唤起必须是单向的。
  app.on('second-instance', () => showOrFocusShell());

  // 顶层 `await app.whenReady()` 在 ESM 入口会死锁（Task 2 踩过），只能用 then。
  void app.whenReady().then(() => {
    initShell(userDataDir());
    createShellWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createShellWindow();
    });
  });

  // before-quit 里再调 quitApp 会二次 app.quit()；quitters 标志让关闭路径空转、
  // quitEmitted 守卫让 'quit' 恰好广播一次（R20：曾经的无守卫重入是自激循环，
  // e2e 实测 267 次广播）。这条路径保证任何退出方式都先落盘窗口状态。
  app.on('before-quit', () => { quitApp(); });
}
