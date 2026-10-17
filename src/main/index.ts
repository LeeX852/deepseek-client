import { app, BrowserWindow, Notification, clipboard, dialog, session, shell } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createShellWindow, DEEPSEEK_PARTITION, getShellWindow, initShell, onShellEvent, quitApp, showOrFocusShell, toggleShell } from './shellWindow';
import { createTray } from './tray';
import { registerHotkeys } from './hotkeys';
import { registerPageEvents } from './pageEvents';
import { createNotifier } from './notifications';
import { performQuickAsk } from './quickAsk';
import { createArchiveStore, type ArchiveStore } from './archive/store';
import { createExportAction, type ExportActionDeps } from './archive/exportAction';
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

// 模块级只留托盘句柄、M3 装配句柄与降级闩：settings 由 whenReady 里的局部 const 持有
// （whenReady 全进程只跑一次，它就是那个唯一句柄，托盘与快捷键共用，绝不再建第二个
// store）。R24：此前的模块级 settingsStore 自 Task 8 起只写不读（读路径全走局部
// settings），死代码删除；现在 tray 在 will-quit 里被读取（destroy），不再是只写变量。
// 降级闩（Plan 4 Task 2）必须在模块级：测试钩子在顶层构造，拿不到 whenReady 闭包里的
// 局部变量；onEvent 与壳窗口 did-navigate 都要复位它，恢复路径才走得到托盘。
let tray: ReturnType<typeof createTray> | null = null;
// Plan 4 Task 3：registerPageEvents 的 dispose 句柄也必须模块级。调用点在 whenReady 闭包
// 内，而测试钩子对象在模块顶层构造——只有把句柄提到顶层，钩子才够得着它（R-E）。
// 退出路径 will-quit 也要读它做统一回收。
let pageEvents: ReturnType<typeof registerPageEvents> | null = null;
let degradedLatched = false;
// Plan 4 Task 2：observer 侧好轮已能复位 degraded（Task 1），主进程这半必须配套——
// 收到任何新的 PAGE_EVENT（说明 observer 又在真实 DOM 上工作）或壳窗口重新导航时
// 放开闩锁，否则托盘永远停在「页面已改版」。expectedWebContentsId 过滤保证 onEvent
// 只可能是壳窗口的上报，故到达这里的上报一定可信。tray 在 ready 后才赋值，故可选调用。
//
// R-I（注释诚实化）：真实不变量是「恢复的那一轮必须产生一次上报」，而非「有上报＝
// 已恢复」无条件成立。observer 在好轮复位 degraded，但 session-list-changed 只在
// 内容键变化时发（observer.ts:97-100）；若键没变且 auth 没跃迁（页面有会话却无
// textarea），整轮没有任何 PAGE_EVENT，主进程闩锁永不释放，且此时 preload 也不再发
// OBSERVER_DEGRADED——托盘会永久停在「页面已改版」。现状下这条路径几乎不可达：会话
// 侧边栏只在登录态出现、登录态必有 textarea（SELECTORS.signedInMarker），故降级途中
// lastSignedIn 必为 false，恢复轮一旦有 textarea 就是 false→true 的 auth 跃迁、必发
// 事件。留此说明：若日后放宽登录态判定或让侧边栏可在未登录态出现，需回头复核该边界。
const clearDegraded = (): void => {
  if (!degradedLatched) return;
  degradedLatched = false;
  tray?.set({ degraded: false, unread: 0 });
};

// Plan 3 Task 7：归档句柄在 whenReady 里赋值（createArchiveStore 依赖
// userDataDir()，ready 之前 app.getPath 不可靠）。模块级接线函数全部惰性取用：
// ready 之前 archive 为 null，跳转/导出/搜索各自降级为"发送失败即无操作/空提示"，
// 绝不空引用。
let archive: ArchiveStore | null = null;

// 交接 D：搜索选中 → 唤起壳窗口 → 把标题投递给壳 preload（clickSessionByTitle 在
// 页面里按标题点真实 <a>，绝不猜造会话 URL）→ 关掉搜索窗，不留悬空面板。
// Plan 4 Task 3：壳窗口可能是刚被 showOrFocusShell 重建的——此刻 webContents 还没跑
// 起 preload，立即 send 会发给一个没有监听 IPC.JUMP_TO_SESSION 的帧，点击静默失效。
// wc.isLoading() 为真时把注入延到 did-finish-load 一次，等 preload 装好再发。
const jumpToSession = (title: string): void => {
  showOrFocusShell();
  const wc = getShellWindow()?.webContents;
  if (!wc) return;
  const send = () => wc.send(IPC.JUMP_TO_SESSION, { title });
  if (wc.isLoading()) wc.once('did-finish-load', send); else send();
  closeSearchWindow();
};

// Ctrl/Cmd+K 的真实入口：搜索窗与归档 store 共用装配点实例（生产路径唯一句柄）。
const openSearch = (): void => {
  if (archive) openSearchWindow(archive, jumpToSession);
};

// 交接 A（spec §15.7）：Ctrl/Cmd+E 导出最近更新的归档会话。纯转换与全部决策分支
// 在 exportAction（有单测）；这里只做 Electron 胶水。
// I-3 修复：胶水声明成 exportDeps 对象、exportRecentSession 收可选 overrides——
// 生产按键路径不带 overrides，走的仍是真实 dialog+writeFileSync，行为逐字不变；
// e2e 可注入假 pickSavePath 覆盖真实落盘线（否则原生保存框在主进程里永远不可
// 自动化，导出写路径只剩纯决策单测）。createExportAction 是纯工厂，每次触发
// 新建一层包装，与原先的常驻 action 等价。
const exportDeps: ExportActionDeps = {
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
  notify: (title, body) => {
    // 与 __dsPageEventCount 同一纪律：钩子置位时先在主进程记一笔，e2e 才能
    // 观测到「Ctrl+E 按键真的走到了导出 action」（空归档提示分支不开原生对话框）。
    if (process.env.DS_SHELL_TEST_HOOKS) {
      const g = globalThis as unknown as { __dsExportNotices?: Array<{ title: string; body: string }> };
      (g.__dsExportNotices ??= []).push({ title, body });
    }
    new Notification({ title, body }).show();
  },
};
const exportRecentSession = (overrides?: Partial<ExportActionDeps>): Promise<void> =>
  createExportAction({ ...exportDeps, ...overrides })();

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
    // openSearchWindow 入口、可注入的导出 action），e2e 驱动的就是用户按
    // Ctrl+K/Ctrl+E 会走到的那条线。I-3 修复：jumpToSession 条目删除——搜索页
    // searchApi.jump → SEARCH_JUMP → 生产 onJump 才是它的真实路径，
    // search-jump.spec 已把那条线钉死，直调钩子是无人使用的死表面。
    getArchive: () => archive,
    openSearch,
    exportRecentSession,
    // Plan 4 Task 2：e2e 从主进程读降级闩的真实状态，断言「改版降级 → 恢复」两端。
    isDegraded: () => degradedLatched,
    // Plan 4 Task 3：唯一新增的钩子面。退出路径的 pageEvents.dispose 在生产里由
    // will-quit 调用；e2e 要能单独触发它、再观测「摘掉监听器后 PAGE_EVENT 不再进主进程」，
    // 故把同一句柄的 dispose 露出来（R-E）。
    disposePageEvents: () => pageEvents?.dispose(),
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
    // Plan 4 Task 2：导航即清降级（计划原意）。绑在同一分区过滤的逐窗口位置，
    // 而非 whenReady 里对当时那个窗口绑一次——壳窗口被销毁后经 activate/托盘重建时
    // 新窗口才有人清降级。
    created.webContents.on('did-navigate', clearDegraded);
  });

  // 顶层 `await app.whenReady()` 在 ESM 入口会死锁（Task 2 踩过），只能用 then。
  void app.whenReady().then(() => {
    // initShell 的返回值是全进程唯一的 store 句柄；局部 const 收窄非 null，
    // 托盘与快捷键共用同一句柄，绝不再建第二个 store。
    const settings = initShell(userDataDir());
    createShellWindow();
    // M3 归档落盘：userData/archive/<key>.json，供 Ctrl+K 搜索与 Ctrl+E 导出。
    // I-1：构造（内含 mkdirSync）失败绝不能让 whenReady 抛出——那会跳过后面的 tray/
    // hotkeys/pageEvents 装配，留下一个"无托盘、无快捷键、消息管线全断"的残壳。降级为
    // 无归档即可：搜索/导出/落盘各自走 archive=null 的空转分支，聊天主体照常可用。
    try {
      archive = createArchiveStore(userDataDir());
    } catch (err) {
      archive = null;
      console.error('[ds-shell] 归档 store 初始化失败，已降级为无归档模式（搜索/导出空转，不影响聊天）:', err);
    }
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
    // Plan 4 Task 3：返回句柄存到模块级，will-quit 才能统一 dispose（页面上报监听器回收）。
    pageEvents = registerPageEvents({
      // 只认壳窗口当前 webContents 的上报；-1 让"无窗口"时全部拒收。
      expectedWebContentsId: () => getShellWindow()?.webContents.id ?? -1,
      onEvent: (e) => {
        // 有任何上报即视为 observer 已恢复（见 clearDegraded）：先清降级闩再走原分支。
        clearDegraded();
        notifier(e);
        // M3 归档接线（不重复注册 registerPageEvents，只在既有 onEvent 里加分支）：
        // 只有 conversation-updated 值得落盘，其余事件类型归通知管线。
        // I-1：store 自身已把每次写包在 try/catch 里（RW-2），这里再兜一层是纵深防御
        // （spec §8）——归档绝不能让异常冒到 ipcMain 监听器把主进程打死。
        if (e.type === 'conversation-updated' && archive) {
          try {
            archive.upsert(e);
          } catch (err) {
            console.error('[ds-shell] 归档写入失败（已忽略，不影响消息管线）:', err);
          }
        }
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
      // 往这个 handler 里追加清理，隔离必须现在就好。Plan 4 Task 3 把 pageEvents.dispose/
      // closeSearchWindow 也并进这条统一回收：不摘 IPC 监听器、不关残留搜索窗，进程退出
      // 就不算收尾。R-G：新加的任一清理若抛错都绝不能跳过 tray?.destroy()，故用嵌套
      // try/finally，把 tray?.destroy() 压在最内层 finally，任何一环失败它都必达。
      try {
        hotkeys.dispose();
      } finally {
        try {
          pageEvents?.dispose();
          closeSearchWindow();
        } finally {
          // R22：Windows 上退出前不显式销毁 Tray，通知区域会残留幽灵图标（悬停才消失）。
          // 托盘是唯一唤起入口，退出后一个"还能点"的残留图标是明确缺陷，必须在此回收；
          // tray.destroy() 幂等性由 null 守卫兜住（whenReady 未跑完就退出时 tray 仍是 null）。
          tray?.destroy();
        }
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
