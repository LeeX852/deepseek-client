import type { ElectronApplication, Page } from '@playwright/test';

// 真实按键驱动：向目标窗口的 webContents 发浏览器进程级输入事件。Task 6 从
// search-jump.spec 并入此处（单一事实源，Ctrl+K/Ctrl+E/Ctrl+O 三处共用）。
// 为什么不用 Playwright 的 keyboard.press（CDP Input.dispatchKeyEvent）：
// 本机 spike 实证 CDP 注入的按键不经过浏览器进程输入管线，
// before-input-event 一次都收不到（监听器空日志）；sendInputEvent 则以
// {type:'keyDown', key:'k', control:true} 真实命中 before-input-event，并驱动
// 生产处理链开出搜索窗/落导出通知——和物理键盘走进来的是同一条拦截链。
// 按同一性定位窗口而不是 getAllWindows 下标（实测搜索窗可能排在壳窗之前）：
// login = persist:deepseek 分区（与 index.ts 生产过滤同一判据）、
// search = renderer/search 页。成对发 keyDown+keyUp：谓词只认 keyDown，
// 补 keyUp 收尾不悬修饰键。
type KeyTarget = 'login' | 'search';
export async function sendCtrlKeyPress(app: ElectronApplication, target: KeyTarget, keyCode: 'K' | 'E' | 'O'): Promise<void> {
  await app.evaluate(({ BrowserWindow, session }, p: { target: KeyTarget; keyCode: 'K' | 'E' | 'O' }) => {
    const windows = BrowserWindow.getAllWindows();
    const wc = p.target === 'login'
      ? windows.find(w => w.webContents.session === session.fromPartition('persist:deepseek'))?.webContents
      : windows.find(w => w.webContents.getURL().includes('renderer/search'))?.webContents;
    if (!wc) throw new Error(`找不到 ${p.target} 目标窗口`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: p.keyCode, modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: p.keyCode, modifiers: ['control'] });
  }, { target, keyCode });
}

// file:// / http fixture 就绪等待（Task 5 Step 1）。裸轮询「锚点数 > 0」有两个问题：
// 只数锚点，不看 textarea（observer 与注入要的登录标记）；且 fixture（尤其带 CDN
// <script> 的 logged-in.html）在慢机器上会先失败、后恢复——裸计数可能恰好提前为真，
// 断言取在错误的时刻。这里改成 waitForFunction 同时要求会话锚点与 textarea 就绪，
// 并把每次壳加载的 did-fail-load 收进主进程 globalThis：超时时把真实失败原因写进
// 错误信息，而不是只报「超时」让人瞎猜。fail 事件只在主进程可达（webContents.on），
// 格式与 overlay.ts 的既有日志同口径。
export async function waitForFixtureReady(app: ElectronApplication, win: Page): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { __dsFixtureLoadFailures?: string[] };
    if (g.__dsFixtureLoadFailures) return; // 每个 app 只挂一次，避免重复监听
    g.__dsFixtureLoadFailures = [];
    for (const wc of webContents.getAllWebContents()) {
      wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        if (!isMainFrame) return;
        g.__dsFixtureLoadFailures!.push(`code=${code} desc=${desc} url=${url}`);
      });
    }
  });
  try {
    await win.waitForFunction(
      () => document.querySelector('a[href*="/a/chat/s/"]') !== null && document.querySelector('textarea') !== null,
      undefined,
      { timeout: 20_000 },
    );
  } catch (cause) {
    const failures = await app.evaluate(
      () => (globalThis as unknown as { __dsFixtureLoadFailures?: string[] }).__dsFixtureLoadFailures ?? [],
    );
    const detail = failures.length
      ? `did-fail-load: ${failures.join(' | ')}`
      : '(无 did-fail-load 记录：页面可能根本没开始加载)';
    throw new Error(`fixture 20s 内未就绪（需 a[href*="/a/chat/s/"] 且 textarea）；${detail}`, { cause });
  }
}
