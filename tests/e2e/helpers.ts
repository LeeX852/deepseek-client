import type { ElectronApplication, Page } from '@playwright/test';

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
