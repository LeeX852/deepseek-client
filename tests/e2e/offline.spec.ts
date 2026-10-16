import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  let last = await read();
  const deadline = Date.now() + ms;
  while (!done(last) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    last = await read();
  }
  return last;
}

// 本地端口：先用 net 随机占一个再立刻释放，得到"当前无人监听"的地址。
// 用本地闭合端口而不是 chat.deepseek.invalid 做失败源：DNS 失败要等解析超时，
// ERR_CONNECTION_REFUSED 是毫秒级的，且用例完全不触碰 DeepSeek 端点。
async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('拿不到本地探测端口');
  const port = addr.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function servingServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><body><h1 id="served">OFFLINE-CLEARED</h1></body></html>');
  });
}

// 主进程侧窗口清点：窗口对象与它的 webContents 是分别销毁的，
// 中间那个 tick 上 isDestroyed() 还是 false 而 getURL() 已经抛
// "Object has been destroyed"——轮询里的读函数绝不能自己先崩。
function liveUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const urls: string[] = [];
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
        urls.push(w.webContents.getURL());
      } catch {
        // 正在这一次清点的中途消失：当作不在位
      }
    }
    return urls;
  });
}

test('加载失败时出现本地覆盖层而不是浏览器错误页', async () => {
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      DS_SHELL_USER_DATA: mkdtempSync(path.join(tmpdir(), 'ds-offline-')),
      DS_SHELL_URL: 'https://chat.deepseek.invalid/',
    },
  });
  await app.firstWindow();
  const overlay = await app.waitForEvent('window', { timeout: 30_000 })
    .then(w => w.waitForLoadState('domcontentloaded').then(() => w));
  await expect(overlay.title()).resolves.toContain('无法连接');
  const body = await overlay.locator('#reason').innerText();
  expect(body.length).toBeGreaterThan(0);
  expect(await overlay.locator('#retry').count()).toBe(1);
  await app.close();
});

test('覆盖层窗口不带 deepseek 登录分区', async () => {
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: mkdtempSync(path.join(tmpdir(), 'ds-offline2-')), DS_SHELL_URL: 'https://chat.deepseek.invalid/' },
  });
  await app.firstWindow();
  const overlay = await app.waitForEvent('window', { timeout: 30_000 });
  const part = await overlay.evaluate(() => navigator.userAgent);
  expect(part).toContain('Electron');
  await app.close();
});

// R28（Deviation B 的在库回归网）：本轮实现覆盖了 brief 的「did-finish-load 即 hide」语义，
// 但两条 brief 用例只证明"覆盖层会出现"和分区/UA 隔离；重试 IPC 往返、成功后自动关闭
// 只在那次性脚本里验证过、脚本已删。这里把它钉成在库用例：
// 失败 URL → 覆盖层（并断言它一直留在位）→ 同一地址变为可服务 → 点 #retry →
// 覆盖层消失、窗口数回到 1、页面真的是服务端内容。
// 诚实标注：这一条对 shipped 代码首次运行即绿，它是回归网而不是 RED；
// 它守护的语义被去掉时的失败形态记录在 task-9-report.md 的 Deviation B
// （覆盖层弹出即被自己关掉，两条 brief 用例死于 Target page closed）。
test('重试往返：服务恢复后点重新加载，覆盖层关闭且窗口数回到 1', async () => {
  const port = await closedPort();
  const srv = servingServer();
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-offline-retry-'));
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: `http://127.0.0.1:${port}/` },
  });
  try {
    const shell = await app.firstWindow();
    const overlay = await app.waitForEvent('window', { timeout: 30_000 });
    await overlay.waitForLoadState('domcontentloaded');
    await expect(overlay.title()).resolves.toContain('无法连接');
    // 覆盖层在位且没有第二条本地窗口
    expect((await liveUrls(app)).length).toBe(2);

    // "切换到一个可服务的 URL"：同一个地址从 ECONNREFUSED 变成 200，产品路径不变。
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve());
    });

    // 用 DOM click 而不是 Playwright 的真实鼠标：覆盖层是无障碍可点按钮，
    // 需要验证的是 preload→ipcMain→reload 这条 IPC 往返，不是命中测试。
    await overlay.evaluate(() => document.getElementById('retry')?.click());

    const gone = await pollUntil(() => Promise.resolve(overlay.isClosed()), v => v, 30_000);
    expect(gone).toBe(true);
    const count = await pollUntil(() => liveUrls(app).then(u => u.length), n => n === 1, 30_000);
    expect(count).toBe(1);
    // 页面对象的 url() 比主进程慢一拍（错误页的 chrome-error:// 还会残留一个 tick），
    // 按轮询取值，避免把平台时序当成产品缺陷。
    const landed = await pollUntil(() => Promise.resolve(shell.url()), u => u === `http://127.0.0.1:${port}/`, 30_000);
    expect(landed).toBe(`http://127.0.0.1:${port}/`);
    await expect(shell.locator('#served')).toHaveText('OFFLINE-CLEARED');
  } finally {
    await app.close().catch(() => undefined);
    srv.close();
  }
});

// R27：closeToTray=false 时用户关窗，shellWindow 的 close 处理器放行、
// window-all-closed 故意空转 → 覆盖层成为唯一窗口。此时点重试，缺陷版对已销毁的
// win.webContents 调 reload()，未捕获异常落在 ipcMain handler 里。
// 实测缺陷形态（本机、HEAD c879667）：点重试后 20s 内没有任何壳窗口被重建，
// 主进程随后连窗口清点都不再应答（evaluate 挂住），托盘销毁记账为空，进程一直是活的
// 躯壳直到被测试杀掉。无论"非零退出绕过 will-quit"还是"挂着不动"，R25/R22
// 存在的幽灵托盘缺陷都会复活。
// 修复语义：壳没了就 showOrFocusShell() 重建，绝不碰那个已销毁的实例。
test('壳被销毁后点重试：不崩主进程，重建壳并干净退出（托盘照常回收）', async () => {
  const port = await closedPort();
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-offline-destroyed-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, closeToTray: false }));
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: `http://127.0.0.1:${port}/` },
  });
  const proc = app.process();
  try {
    await app.firstWindow();
    const overlay = await app.waitForEvent('window', { timeout: 30_000 });
    await overlay.waitForLoadState('domcontentloaded');
    await expect(overlay.title()).resolves.toContain('无法连接');

    // 托盘销毁记账（沿用 tray-quit.spec.ts 的 prototype 包裹探针）
    const file = path.join(dir, 'tray-destroy.log');
    await app.evaluate(({ Tray }, logFile: string) => {
      const { appendFileSync } = process.getBuiltinModule('node:fs');
      const original = Tray.prototype.destroy;
      Tray.prototype.destroy = function (this: { destroy(): void }) {
        appendFileSync(logFile, 'destroy\n');
        original.call(this);
      };
    }, file);

    // 关掉壳窗口（覆盖层是 loadFile 出来的 file:// 页面，按 URL 区分）
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          if (!w.isDestroyed() && !w.webContents.isDestroyed() && !w.webContents.getURL().startsWith('file://')) w.close();
        } catch {
          // 已经在销毁途中：不关第二次
        }
      }
    });
    const alone = await pollUntil(
      () => liveUrls(app),
      urls => urls.length === 1 && (urls[0] ?? '').startsWith('file://'),
      30_000,
    );
    expect(alone).toHaveLength(1);

    await overlay.evaluate(() => document.getElementById('retry')?.click());

    // 缺陷版走不到这里之后：进程要么已经非零退出，要么挂着未捕获异常弹窗；
    // 无论哪种，"壳被重建"这条断言都先变红。
    const revived = await pollUntil(() => liveUrls(app), urls => urls.some(u => !u.startsWith('file://')), 20_000)
      .catch(() => [] as string[]);
    expect(revived.some(u => !u.startsWith('file://'))).toBe(true);

    if (proc.exitCode === null) {
      await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
    }
    const exitCode = await pollUntil(() => Promise.resolve(proc.exitCode), c => c !== null, 30_000);
    expect(exitCode).toBe(0);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    expect(lines).toContain('destroy');
  } finally {
    await app.close().catch(() => undefined);
    if (proc.exitCode === null) proc.kill();
  }
});
