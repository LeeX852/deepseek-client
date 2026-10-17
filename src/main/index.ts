import { app, BrowserWindow, Notification, clipboard, dialog, session, shell } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createShellWindow, DEEPSEEK_PARTITION, getShellWindow, initShell, onShellEvent, quitApp, showOrFocusShell, toggleShell } from './shellWindow';
import { createTray } from './tray';
import { registerHotkeys } from './hotkeys';
import { registerPageEvents } from './pageEvents';
import { createNotifier } from './notifications';
import { performQuickAsk } from './quickAsk';
import { createArchiveStore, type ArchiveStore } from './archive/store';
import { createExportAction } from './archive/exportAction';
import { closeSearchWindow, openSearchWindow } from './search';
import { IPC } from '../shared/ipc';
import { userDataDir } from './paths';

if (process.env.DS_SHELL_USER_DATA) {
  app.setPath('userData', process.env.DS_SHELL_USER_DATA);
}

// spec §7 / Task 8 交接 2：answer-completed 的 preview 来自远端 DOM——不可信、
// 最长 300 字符。系统通知按纯文本处理并截到 120 字符 + 省略号：
// 折叠空白防换行注入，长度上限防一条长回答霸满整个通知条。
const NOTIFY_BODY_MAX_CHARS = 120;
function safeNotifyBody(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > NOTIFY_BODY_MAX_CHARS ? `${text.slice(0, NOTIFY_BODY_MAX_CHARS)}…` : text;
}

// 模块级只留托盘句柄与 M3 装配句柄：settings 由 whenReady 里的局部 const 持有
// （whenReady 全进程只跑一次，它就是那个唯一句柄，托盘与快捷键共用，绝不再建第二个
// store）。R24：此前的模块级 settingsStore 自 Task 8 起只写不读（读路径全走局部
// settings），死代码删除；现在 tray 在 will-quit 里被读取（destroy），不再是只写变量。
let tray: ReturnType<typeof createTray> | null = null;

// Plan 3 Task 7：归档句柄在 whenReady 里赋值（createArchiveStore 依赖
// userDataDir()，ready 之前 app.getPath 不可靠）。模块级接线函数全部惰性取用：
// ready 之前 archive 为 null，跳转/导出/搜索各自降级为"发送失败即无操作/空提示"，
// 绝不空引用。
let archive: ArchiveStore | null = null;

// 交接 D：搜索选中 → 唤起壳窗口 → 把标题投递给壳 preload（clickSessionByTitle 在
// 页面里按标题点真实 <a>，绝不猜造会话 URL）→ 关掉搜索窗，不留悬空面板。
const jumpToSession = (title: string): void => {
  showOrFocusShell();
  getShellWindow()?.webContents.send(IPC.JUMP_TO_SESSION, { title });
  closeSearchWindow();
};

// Ctrl/Cmd+K 的真实入口：搜索窗与归档 store 共用装配点实例（生产路径唯一句柄）。
const openSearch = (): void => {
  if (archive) openSearchWindow(archive, jumpToSession);
};

// 交接 A（spec §15.7）：Ctrl/Cmd+E 导出最近更新的归档会话。纯转换与全部决策分支
// 在 exportAction（有单测）；这里只做 Electron 胶水。
const exportRecentSession = createExportAction({
  list: () => archive?.list() ?? [],
  get: (id) => archive?.get(id),
  // 有壳窗口时保存框挂到壳上（父窗口模态）；无壳走无参重载。canceled 时
  // filePath 是空字符串，一律归一为 null（取消即整体放弃）。
  pickSavePath: async (defaultPath) => {
    const options = { defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] };
    const parent = getShellWindow();
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  writeMarkdown: (filePath, markdown) => { writeFileSync(filePath, markdown, 'utf8'); },
  notify: (title, body) => { new Notification({ title, body }).show(); },
});

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
    // Task 5 评审交接 C：index.ts 已是装配点，e2e 不再用临时 CJS bundle 自拼
    // store/搜索窗——这里露出生产装配的同一批实例（真实 archive、真实
    // openSearchWindow+jumpToSession 回调、真实导出 action），e2e 驱动的
    // 就是用户按 Ctrl+K/Ctrl+E 会走到的那条线。
    getArchive: () => archive,
    openSearch,
    jumpToSession,
    exportRecentSession,
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

  // M3 壳窗口按键入口（brief Step 1 的 before-input-event）：Ctrl/Cmd+K 开搜索窗、
  // Ctrl/Cmd+E 导出最近归档。挂在 browser-window-created 并按登录分区过滤，而不是
  // "启动时给当前壳挂一次"：壳窗口可能被真销毁后由 activate/托盘唤起重建，逐窗口
  // 绑定才不会在重建路径上漏；搜索窗/覆盖层不在 persist:deepseek，不该有这两把键。
  // Session 类型上没有 partition 读值属性；fromPartition 对同一分区返回同一单例，
  // 用同一性比较代替字符串比较（与 shellWindow.createShellWindow 传的分区串同源）。
  app.on('browser-window-created', (_event, created) => {
    if (created.webContents.session !== session.fromPartition(DEEPSEEK_PARTITION)) return;
    created.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
      const key = input.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        openSearch();
      } else if (key === 'e') {
        e.preventDefault();
        // 保存框被平台拒绝时 reject 上抛（exportAction 不吞异常）：这里兜一条
        // 通知，绝不静默失灵。正常取消（resolve null）不会走到 catch。
        void exportRecentSession().catch(() => {
          new Notification({ title: '导出失败', body: '保存对话框不可用，请稍后再试' }).show();
        });
      }
    });
  });

  // 顶层 `await app.whenReady()` 在 ESM 入口会死锁（Task 2 踩过），只能用 then。
  void app.whenReady().then(() => {
    // initShell 的返回值是全进程唯一的 store 句柄；局部 const 收窄非 null，
    // 托盘与快捷键共用同一句柄，绝不再建第二个 store。
    const settings = initShell(userDataDir());
    createShellWindow();
    // M3 归档落盘：userData/archive/<key>.json，供 Ctrl+K 搜索与 Ctrl+E 导出。
    archive = createArchiveStore(userDataDir());
    // 关窗后托盘是唯一唤起入口；退出直接走 quitApp()——quitters/quitEmitted 是
    // 进程级永久闩（Task 6 交接裁决），托盘不做可取消退出，否则 before-quit +
    // preventDefault 会让应用活着但 close-to-tray 失效、quit 广播永不再发。
    tray = createTray({
      onToggle: toggleShell,
      onShow: showOrFocusShell,
      onSettings: () => { void shell.openPath(settings.path()); },
      onQuit: quitApp,
    });
    // M2 事件管线：preload observer 上报 → pageEvents 校验分发 → 节流通知。
    // notifier 的 show 是唯一接触 Electron Notification 的地方（Task 4 纯逻辑），
    // 点击通知唤起窗口；body 必经 safeNotifyBody 截断（交接 2，见上）。
    const notifier = createNotifier({
      settings: () => settings.get(),
      show: (title, body) => {
        const n = new Notification({ title, body: safeNotifyBody(body) });
        n.on('click', () => showOrFocusShell());
        n.show();
      },
      now: () => Date.now(),
      // spec §15.5：回答完成通知只在窗口未聚焦时弹——前台正在读无需打扰。
      // 无壳窗口（已销毁）按未聚焦处理，通知照常发出（点击再重建/唤起）。
      isFocused: () => getShellWindow()?.isFocused() ?? false,
    });
    // 交接 5：preload 降级闩锁后每个防抖 tick 都会重发 OBSERVER_DEGRADED，
    // 主进程必须幂等——托盘只在首次降级时翻牌一次，之后的重复上报直接吞掉。
    let degradedLatched = false;
    registerPageEvents({
      // 只认壳窗口当前 webContents 的上报；-1 让"无窗口"时全部拒收。
      expectedWebContentsId: () => getShellWindow()?.webContents.id ?? -1,
      onEvent: (e) => {
        notifier(e);
        // M3 归档接线（不重复注册 registerPageEvents，只在既有 onEvent 里加分支）：
        // 只有 conversation-updated 值得落盘，其余事件类型归通知管线。
        if (e.type === 'conversation-updated') archive?.upsert(e);
        if (process.env.DS_SHELL_TEST_HOOKS) {
          const g = globalThis as unknown as { __dsPageEventCount?: number; __dsPageEventTypes?: string[] };
          g.__dsPageEventCount = (g.__dsPageEventCount ?? 0) + 1;
          (g.__dsPageEventTypes ??= []).push(e.type);
        }
      },
      onDegraded: () => {
        if (degradedLatched) return;
        degradedLatched = true;
        tray?.set({ degraded: true, unread: 0 });
        if (process.env.DS_SHELL_TEST_HOOKS) {
          const g = globalThis as unknown as { __dsDegradedFlips?: number };
          g.__dsDegradedFlips = (g.__dsDegradedFlips ?? 0) + 1;
        }
      },
    });
    // 全局快捷键：跨应用唤起是常驻壳的核心价值。冲突走一条系统通知而不是弹窗，
    // 让用户知道"为什么按了没反应"，而不是静默失灵。
    const hotkeys = registerHotkeys({
      toggleHotkey: settings.get().toggleHotkey,
      quickAskHotkey: settings.get().quickAskHotkey,
      onToggle: toggleShell,
      // M2 划词提问（Task 5）：读剪贴板 → 校验 → 投递注入给远端 preload。
      // 空剪贴板/超限都走 notifyEmpty 一条轻通知（交接 6），不静默失灵；
      // 绝不把不合格的文本写进剪贴板或远端输入框。
      // 偏差（brief 原文 `readClipboardText: () => clipboard.readText()`）：Electron 44
      // 的 clipboard.readText() 返回 Promise<string>，而 performQuickAsk 是同步契约，
      // 故先 await 读取再以同步 getter 注入；读取失败按空剪贴板提示，绝不静默失灵。
      onQuickAsk: () => {
        // Finding I-3：先把窗口唤起再注入——隐藏到托盘时若只读剪贴板发注入，
        // 用户完全看不到反馈（Plan 1 占位实现调过 showOrFocusShell，接入真实
        // quickAsk 时漏掉了）。唤起必须在读剪贴板/发送注入之前。
        showOrFocusShell();
        void clipboard
          .readText()
          .then((text) =>
            performQuickAsk({
              readClipboardText: () => text,
              sendInject: (t) => { getShellWindow()?.webContents.send(IPC.INJECT_TEXT, { text: t }); },
              notifyEmpty: () => { new Notification({ title: '剪贴板为空', body: '请先选中要提问的文字' }).show(); },
            }),
          )
          .catch(() => {
            new Notification({ title: '剪贴板为空', body: '请先选中要提问的文字' }).show();
          });
      },
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
