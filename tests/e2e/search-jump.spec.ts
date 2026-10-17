import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 页内记录器（brief Step 3）：捕获阶段监听 click——点击发生在 preload 的
// a.click() 那一刻，默认导航（file:///a/chat/s/...）随后被壳的 will-navigate
// 白名单拦下，页面活着、document.title 留得住。标题归一化与
// clickSessionByTitle 同口径（折叠空白+trim），比对才不因空白差异出假阴性。
// 追加在 </html> 之后：Chromium 解析器会把它归回 body 执行（dump 页无 </body>
// 改写需求，脚本本身零依赖）。
const RECORDER = `<script>
document.addEventListener('click', function (e) {
  var el = e.target;
  var a = el && el.closest ? el.closest('a[href*="/a/chat/s/"]') : null;
  if (!a) return;
  var t = ((a.querySelector('.ds-focus-ring + div') || a).textContent || '').replace(/\\s+/g, ' ').trim();
  document.title = 'CLICKED::' + t;
}, true);
</script>`;

// 归档事件形状与 src/shared/pageEvent.ts 的 conversationUpdatedSchema 对齐。
type ArchiveEvent = {
  type: 'conversation-updated';
  sessionId?: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
};

// 钩子在主进程侧的真实形状是 Partial<ExportActionDeps>（src/main/archive/exportAction.ts）；
// 这里只声明测试注入用到的那一项。app.evaluate 的函数体经编译后类型标注即被剥离，
// 该类型只约束测试文件内的调用点。
type ShellHooks = {
  openSearch: () => void;
  getArchive: () => { upsert(ev: ArchiveEvent): void } | null;
  exportRecentSession: (overrides?: {
    pickSavePath?: (defaultPath: string) => Promise<string | null>;
  }) => Promise<void>;
};

// 本地闭合服务页（同 archive.spec）：无会话 <a>、无 .ds-message——observer
// 零上报，归档保持真空，Ctrl+E 的空归档分支与注入写盘都不与 fixture 流量打架。
function servingServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><body><h1 id="served">SHELL-OK</h1></body></html>');
  });
}

async function listenOnFreePort(srv: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = srv.address();
  if (addr === null || typeof addr === 'string') throw new Error('拿不到本地服务端口');
  return `http://127.0.0.1:${addr.port}/`;
}

// 搜索窗计数：按 renderer/search URL 判定（标题断言之外再加一道 URL 钉）。
const searchWindowCount = (app: ElectronApplication): Promise<unknown> =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('renderer/search')).length);

// 真实按键驱动：向目标窗口的 webContents 发浏览器进程级输入事件。
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
async function sendCtrlKeyPress(app: ElectronApplication, target: KeyTarget, keyCode: 'K' | 'E'): Promise<void> {
  await app.evaluate(({ BrowserWindow, session }, p: { target: KeyTarget; keyCode: 'K' | 'E' }) => {
    const windows = BrowserWindow.getAllWindows();
    const wc = p.target === 'login'
      ? windows.find(w => w.webContents.session === session.fromPartition('persist:deepseek'))?.webContents
      : windows.find(w => w.webContents.getURL().includes('renderer/search'))?.webContents;
    if (!wc) throw new Error(`找不到 ${p.target} 目标窗口`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: p.keyCode, modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: p.keyCode, modifiers: ['control'] });
  }, { target, keyCode });
}

test('M3 装配端到端：真实 store 归档 fixture 对话，搜索窗发起跳转，壳内按标题点击', async () => {
  const pageDir = mkdtempSync(path.join(tmpdir(), 'ds-jump-page-'));
  const userData = mkdtempSync(path.join(tmpdir(), 'ds-jump-user-'));
  const page = path.join(pageDir, 'logged-in.html');
  copyFileSync(path.join(repoRoot, 'tests/fixtures/logged-in.html'), page);
  appendFileSync(page, RECORDER, 'utf8');

  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      DS_SHELL_TEST_HOOKS: '1',
      DS_SHELL_USER_DATA: userData,
      DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/'),
    },
  });
  try {
    const shellWin = await app.firstWindow();
    await shellWin.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => shellWin.evaluate(() => document.querySelectorAll('a[href*="/a/chat/s/"]').length), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // 跳转目标从真实 fixture DOM 现场取第一条会话标题——与 preload 的取法一致，
    // 不把 fixture 内容硬编码进测试（fixture 换版不假失败）。
    const title = await shellWin.evaluate(() => {
      const a = document.querySelector('a[href*="/a/chat/s/"]');
      if (!a) return '';
      return ((a.querySelector('.ds-focus-ring + div') || a).textContent || '').replace(/\s+/g, ' ').trim();
    });
    expect(title).toBeTruthy();

    // 归档接线（M3 的另一半，Task 7 装配的核心断言）：fixture 里的 .ds-message
    // → preload observer conversation-updated → 真实 registerPageEvents.onEvent
    // → 真实 createArchiveStore 落盘 userData/archive/*.json。
    const archiveDir = path.join(userData, 'archive');
    await expect
      .poll(() => (readdirSync(archiveDir).filter(f => f.endsWith('.json')).length), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // 用生产装配实例开真实搜索窗（index.ts 的 Ctrl+K 走的是同一个 openSearch）。
    const searchWinReady = app.waitForEvent('window', { timeout: 30_000 });
    await app.evaluate(() => {
      const g = globalThis as unknown as { __dsShellTestHooks?: ShellHooks };
      if (!g.__dsShellTestHooks) throw new Error('测试钩子未安装：主进程启动时缺少 DS_SHELL_TEST_HOOKS');
      g.__dsShellTestHooks.openSearch();
    });
    const searchWin = await searchWinReady;
    await searchWin.waitForLoadState('domcontentloaded');

    // 从搜索页 preload 发起跳转：searchApi.jump → IPC.SEARCH_JUMP → 主进程
    // jumpToSession（唤起壳 + IPC.JUMP_TO_SESSION + 关搜索窗）→ 壳 preload
    // clickSessionByTitle → 真实 <a>.click()。
    await searchWin.evaluate((t: string) => {
      (window as unknown as { searchApi: { jump(title: string): void } }).searchApi.jump(t);
    }, title);

    // 壳页记录器必须看到匹配标题的 <a> 被点击（跳转真的落在页面里，不是空发 IPC）。
    await expect
      .poll(() => shellWin.evaluate(() => document.title), { timeout: 20_000 })
      .toBe('CLICKED::' + title);

    // 交接 D：jumpToSession 必须关掉搜索窗，不留悬空面板。
    await expect
      .poll(
        () => app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('renderer/search')).length),
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    await app.close().catch(() => undefined);
    for (const dir of [pageDir, userData]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时跳过 */ }
    }
  }
});

// I-3 修复（其一）：真实按键路径。上面测试 1 走的是钩子 openSearch()——它证明
// 装配正确但绕过了 before-input-event。这里向壳窗口 webContents 发浏览器进程级
// keyDown（sendCtrlKeyPress，见其注释），钉死 index.ts 按键谓词 + persist:deepseek
// 会话过滤这两段生产代码——Ctrl+K 打开搜索窗（窗口数 +1、标题/URL 双钉），
// 在搜索窗（persist:shell）内再按 Ctrl+K 既不拦截该键（页内 keydown 照常到达，
// 证明过滤把非登录分区窗口排除在外）也不产生新搜索窗。
test('Ctrl/Cmd+K 真实按键路径：壳窗口 keydown 开出搜索窗；搜索窗内再按不拦截不再开', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'ds-keyk-user-'));
  const fixture = path.join(repoRoot, 'tests/fixtures/logged-in.html');
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      DS_SHELL_TEST_HOOKS: '1',
      DS_SHELL_USER_DATA: userData,
      DS_SHELL_URL: 'file://' + fixture.replace(/\\/g, '/'),
    },
  });
  try {
    const shellWin = await app.firstWindow();
    await shellWin.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => shellWin.evaluate(() => document.querySelectorAll('a[href*="/a/chat/s/"]').length), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await searchWindowCount(app)).toBe(0);

    const winReady = app.waitForEvent('window', { timeout: 30_000 });
    await sendCtrlKeyPress(app, 'login', 'K');
    const searchWin = await winReady;
    await searchWin.waitForLoadState('domcontentloaded');
    await expect(searchWin.title()).resolves.toContain('搜索会话');
    expect(searchWin.url()).toContain('renderer/search');
    expect(await searchWindowCount(app)).toBe(1);

    // 搜索窗在 persist:shell——index.ts 的会话同一性过滤必须把它排除在外。
    // 计数断言单独不够（openSearchWindow 是单例，即便误命中也只是复用聚焦），
    // 所以再加一道拦截反证：before-input-event 里 preventDefault 会吞掉页内
    // keydown（Electron 文档语义）。过滤正确 → 该窗不挂监听、不拦截 →
    // 页内 keydown 照常到达；过滤失效 → 页内收不到且窗口被重新聚焦。
    await searchWin.bringToFront();
    await searchWin.evaluate(() => {
      const w = window as unknown as { __ctrlKSeen?: boolean };
      w.__ctrlKSeen = false;
      window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) w.__ctrlKSeen = true;
      });
    });
    await sendCtrlKeyPress(app, 'search', 'K');
    await searchWin.waitForTimeout(2_000);
    expect(await searchWin.evaluate(() => (window as unknown as { __ctrlKSeen?: boolean }).__ctrlKSeen === true)).toBe(true);
    expect(await searchWindowCount(app)).toBe(1);
    const pages = await (await app.context()).pages();
    expect(pages.length).toBe(2);
  } finally {
    await app.close().catch(() => undefined);
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时跳过 */ }
  }
});

// I-3 修复（其二）：Ctrl/Cmd+E 按键分支 + 导出写路径。分两段：
// (1) 空归档按下真实 Ctrl+E——exportAction 在 pickSavePath 之前就 notify 返回，
//     不会弹原生对话框，自动化环境安全；钩子置位时 notify 胶水在主进程
//     __dsExportNotices 记一笔，证明按键真的走进了导出 action。
// (2) 真实 store upsert 一条 → 调生产装配的 exportRecentSession，只注入假
//     pickSavePath（返回临时路径），其余依赖（list/get/writeMarkdown/notify）
//     全是 index.ts 的真实胶水——落盘文件读回来含标题行与角色标签，
//     §15.7 的装配线就此钉死，不需要真对话框。
test('Ctrl/Cmd+E 按键分支与导出写路径：真实胶水落盘 Markdown（注入假保存路径）', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'ds-keye-user-'));
  const outDir = mkdtempSync(path.join(tmpdir(), 'ds-keye-out-'));
  const outPath = path.join(outDir, 'exported.md');
  const srv = servingServer();
  const shellUrl = await listenOnFreePort(srv);
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      DS_SHELL_TEST_HOOKS: '1',
      DS_SHELL_USER_DATA: userData,
      DS_SHELL_URL: shellUrl,
    },
  });
  const exportNoticeTitles = () => app.evaluate(() => {
    const g = globalThis as unknown as { __dsExportNotices?: Array<{ title: string }> };
    return (g.__dsExportNotices ?? []).map((n) => n.title);
  });
  try {
    const shellWin = await app.firstWindow();
    await shellWin.waitForLoadState('domcontentloaded');

    // 空归档按下真实 Ctrl+E（浏览器进程输入 → before-input-event → 生产 action）。
    await sendCtrlKeyPress(app, 'login', 'E');
    await expect
      .poll(exportNoticeTitles, { timeout: 15_000 })
      .toEqual(['没有可导出的会话']);

    const EXPORT_TITLE = 'e2e导出会话标题';
    const EXPORT_ANSWER = 'e2e导出回答正文';
    const seenDefaultPath = await app.evaluate(async (_electronModule, p: { outPath: string; title: string; answer: string }) => {
      const g = globalThis as unknown as { __dsShellTestHooks?: ShellHooks };
      const hooks = g.__dsShellTestHooks;
      if (!hooks) throw new Error('测试钩子未安装：主进程启动时缺少 DS_SHELL_TEST_HOOKS');
      const store = hooks.getArchive();
      if (!store) throw new Error('真实归档 store 未就绪（装配在 whenReady 里没跑到？）');
      store.upsert({
        type: 'conversation-updated',
        messages: [
          { role: 'user', text: p.title },
          { role: 'assistant', text: p.answer },
        ],
      });
      let seen = '';
      await hooks.exportRecentSession({
        pickSavePath: async (defaultPath) => { seen = defaultPath; return p.outPath; },
      });
      return seen;
    }, { outPath, title: EXPORT_TITLE, answer: EXPORT_ANSWER });

    // 建议名由归档标题 sanitize 后 + .md（不是硬编码）；写入落在注入路径。
    expect(seenDefaultPath).toBe(EXPORT_TITLE + '.md');
    const md = readFileSync(outPath, 'utf8');
    expect(md.split('\n')[0]).toBe('# ' + EXPORT_TITLE);
    expect(md).toContain('**你**');
    expect(md).toContain('**DeepSeek**');
    expect(md).toContain(EXPORT_ANSWER);
    // 成功路径不追加通知：记录里仍只有空归档那一条。
    expect(await exportNoticeTitles()).toEqual(['没有可导出的会话']);
  } finally {
    await app.close().catch(() => undefined);
    srv.close();
    for (const dir of [userData, outDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时跳过 */ }
    }
  }
});
