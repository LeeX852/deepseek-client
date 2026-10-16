import { app, BrowserWindow, Notification, shell } from 'electron';
import { appendFileSync } from 'node:fs';
import { createShellWindow, initShell, onShellEvent, quitApp, showOrFocusShell, toggleShell } from './shellWindow';
import { createTray } from './tray';
import { registerHotkeys } from './hotkeys';
import { userDataDir } from './paths';

if (process.env.DS_SHELL_USER_DATA) {
  app.setPath('userData', process.env.DS_SHELL_USER_DATA);
}

// 模块级只留托盘句柄：store 由 whenReady 里的局部 const 持有（whenReady 全进程只跑
// 一次，它就是那个唯一句柄，托盘与快捷键共用，绝不再建第二个 store）。
// R24：此前的模块级 settingsStore 自 Task 8 起只写不读（读路径全走局部 settings），
// 死代码删除；现在 tray 在 will-quit 里被读取（destroy），不再是只写变量。
let tray: ReturnType<typeof createTray> | null = null;

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
    // initShell 的返回值是全进程唯一的 store 句柄；局部 const 收窄非 null，
    // 托盘与快捷键共用同一句柄，绝不再建第二个 store。
    const settings = initShell(userDataDir());
    createShellWindow();
    // 关窗后托盘是唯一唤起入口；退出直接走 quitApp()——quitters/quitEmitted 是
    // 进程级永久闩（Task 6 交接裁决），托盘不做可取消退出，否则 before-quit +
    // preventDefault 会让应用活着但 close-to-tray 失效、quit 广播永不再发。
    tray = createTray({
      onToggle: toggleShell,
      onShow: showOrFocusShell,
      onSettings: () => { void shell.openPath(settings.path()); },
      onQuit: quitApp,
    });
    // 全局快捷键：跨应用唤起是常驻壳的核心价值。冲突走一条系统通知而不是弹窗，
    // 让用户知道"为什么按了没反应"，而不是静默失灵。
    const hotkeys = registerHotkeys({
      toggleHotkey: settings.get().toggleHotkey,
      quickAskHotkey: settings.get().quickAskHotkey,
      onToggle: toggleShell,
      onQuickAsk: () => { /* Plan 2 的划词注入接管此处；当前仅唤起窗口 */ showOrFocusShell(); },
      onConflict: (which, key) => {
        new Notification({
          title: '快捷键不可用',
          body: `${which === 'toggle' ? '唤起' : '划词'}快捷键 ${key} 注册失败，请修改 ${settings.path()} 后重启应用`,
        }).show();
      },
    });
    app.on('will-quit', () => {
      // R25：dispose 抛错不能吃掉托盘回收——否则幽灵图标缺陷复活，且 Task 9/10 还要
      // 往这个 handler 里追加清理，隔离必须现在就好。try/finally 保证 tray.destroy 必达。
      try {
        hotkeys.dispose();
      } finally {
        // R22：Windows 上退出前不显式销毁 Tray，通知区域会残留幽灵图标（悬停才消失）。
        // 托盘是唯一唤起入口，退出后一个"还能点"的残留图标是明确缺陷，必须在此回收；
        // tray.destroy() 幂等性由 null 守卫兜住（whenReady 未跑完就退出时 tray 仍是 null）。
        tray?.destroy();
      }
    });
    // 托盘常驻：故意不因为窗口全部关闭而退出（hide 进托盘是主路径，
    // 这里兜住 closeToTray=false 时用户关掉最后一个窗口还想留在托盘的场景）。
    app.on('window-all-closed', () => { /* 空实现：托盘常驻，故意不因窗口关闭而退出 */ });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createShellWindow();
    });
  });

  // before-quit 里再调 quitApp 会二次 app.quit()；quitters 标志让关闭路径空转、
  // quitEmitted 守卫让 'quit' 恰好广播一次（R20：曾经的无守卫重入是自激循环，
  // e2e 实测 267 次广播）。这条路径保证任何退出方式都先落盘窗口状态。
  app.on('before-quit', () => { quitApp(); });
}
