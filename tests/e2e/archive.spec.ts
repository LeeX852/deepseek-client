import { test, expect, _electron as electron } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ARCHIVED_TITLE = 'e2e-search-target';

type SearchItem = { id: string; title: string; updatedAt: number };

// 归档事件形状与 src/shared/pageEvent.ts 的 conversationUpdatedSchema 对齐。
type ArchiveEvent = {
  type: 'conversation-updated';
  sessionId?: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
};

// Task 5 评审交接 C：index.ts 在 Task 7 已是装配点，这里不再用 esbuild 现编
// 临时 CJS 钩子——改为驱动 DS_SHELL_TEST_HOOKS 露出的生产实例：真实 archive
// store（userData/archive）、真实 openSearchWindow + jumpToSession 回调。
// 断言与旧版逐条等价，未放宽。
type ShellHooks = {
  getArchive: () => { upsert(ev: ArchiveEvent): void } | null;
  openSearch: () => void;
};

// 壳指向本地服务而不是真站或坏站：坏站会弹离线覆盖层，第二个窗口和
// 搜索窗口在 waitForEvent('window') 上打架；本地闭合服务两者都不碰。
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

test('搜索窗口 SEARCH_QUERY 命中已归档标题，列表渲染且可直查', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'ds-search-user-'));
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
  try {
    // http fixture 就绪等待（Task 5 Step 1）：这页是闭合的 SHELL-OK（无会话锚点/
    // textarea），等它的 #served 出现再驱动钩子——与 search-jump/recovery 的等待同一
    // 意图（等 fixture 真加载完再取样），只是选择器随页面形状不同，故不走那个 helper。
    const shellWin = await app.firstWindow();
    await shellWin.waitForSelector('#served', { timeout: 20_000 });

    // 主进程内：取生产装配的 archive 句柄 → 归档一条会话 → 开真实搜索窗。
    // SEARCH_QUERY 的 ipcMain.handle 注册在 openSearchWindow 里完成（真实实例）。
    // 注意：app.evaluate 的函数体被序列化进主进程，闭包常量不可见，
    // 一切取值必须走 payload。窗口事件先挂监听再开窗，不赌时序。
    const windowWait = app.waitForEvent('window', { timeout: 30_000 });
    await app.evaluate((_electronModule, payload: { title: string }) => {
      const g = globalThis as unknown as { __dsShellTestHooks?: ShellHooks };
      const hooks = g.__dsShellTestHooks;
      if (!hooks) throw new Error('测试钩子未安装：主进程启动时缺少 DS_SHELL_TEST_HOOKS');
      const store = hooks.getArchive();
      if (!store) throw new Error('真实归档 store 未就绪（装配在 whenReady 里没跑到？）');
      store.upsert({
        type: 'conversation-updated',
        sessionId: payload.title,
        messages: [
          { role: 'user', text: 'e2e 归档搜索问题' },
          { role: 'assistant', text: 'e2e 归档搜索回答' },
        ],
      });
      hooks.openSearch();
    }, { title: ARCHIVED_TITLE });

    const searchWin = await windowWait;
    await searchWin.waitForLoadState('domcontentloaded');
    await expect(searchWin.title()).resolves.toContain('搜索会话');

    // 经真实渲染进程 → preload → ipcMain.handle 的往返：子串命中已归档标题。
    const items = await searchWin.evaluate(async (q: string) => {
      const api = (window as unknown as { searchApi?: { query: (s: string) => Promise<SearchItem[]> } }).searchApi;
      return api ? await api.query(q) : [];
    }, 'e2e-search');
    expect(items.map(i => i.title)).toContain(ARCHIVED_TITLE);

    // 界面路径：输入防抖 200ms 后列表出现 <li>（textContent 渲染标题）。
    await searchWin.fill('#query', 'e2e-search');
    await expect(searchWin.locator('#results li')).toHaveText([ARCHIVED_TITLE], { timeout: 10_000 });
  } finally {
    await app.close().catch(() => undefined);
    srv.close();
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时跳过 */ }
  }
});
