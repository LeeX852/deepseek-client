import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
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

// index.ts 不许动（Task 7 才接触发线），所以 openSearchWindow 不在主入口的
// 测试钩子里。这里用仓库既有依赖 esbuild 现编一个 CJS 钩子模块，测试内
// app.evaluate 在主进程 require 它：建 store → upsert 一条归档 → 开搜索窗。
async function buildSearchHook(outDir: string): Promise<string> {
  const outfile = path.join(outDir, 'search-hook.cjs');
  await build({
    stdin: {
      contents: [
        `export { openSearchWindow, closeSearchWindow } from './src/main/search';`,
        `export { createArchiveStore } from './src/main/archive/store';`,
      ].join('\n'),
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['electron'], outfile,
  });
  return outfile;
}

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
  const archiveDir = mkdtempSync(path.join(tmpdir(), 'ds-search-archive-'));
  const hookDir = mkdtempSync(path.join(tmpdir(), 'ds-search-hook-'));
  const hookPath = await buildSearchHook(hookDir);
  const srv = servingServer();
  const shellUrl = await listenOnFreePort(srv);
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: userData, DS_SHELL_URL: shellUrl },
  });
  try {
    await app.firstWindow();

    // 主进程内：require 钩子 → 建 store → 归档一条会话 → 开搜索窗口。
    // SEARCH_QUERY 的 ipcMain.handle 注册也在 openSearchWindow 里完成。
    // 注意：app.evaluate 的函数体被序列化进主进程，闭包常量不可见，
    // 一切取值必须走 payload。
    await app.evaluate((_modules, payload: { hookPath: string; archiveDir: string; title: string }) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const req = createRequire(payload.hookPath);
      type ArchiveHook = {
        createArchiveStore: (dir: string) => { upsert: (ev: ArchiveEvent) => void };
        openSearchWindow: (store: unknown, onJump: (title: string) => void) => void;
      };
      const hook = req(payload.hookPath) as ArchiveHook;
      const store = hook.createArchiveStore(payload.archiveDir);
      store.upsert({
        type: 'conversation-updated',
        sessionId: payload.title,
        messages: [
          { role: 'user', text: 'e2e 归档搜索问题' },
          { role: 'assistant', text: 'e2e 归档搜索回答' },
        ],
      });
      hook.openSearchWindow(store, () => { /* Task 6 才接跳转，这里只需开窗注册 handler */ });
    }, { hookPath, archiveDir, title: ARCHIVED_TITLE });

    const searchWin = await app.waitForEvent('window', { timeout: 30_000 });
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
    for (const dir of [hookDir, archiveDir, userData]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时跳过 */ }
    }
  }
});
