import { test, expect, _electron as electron } from '@playwright/test';
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

type ShellHooks = { openSearch: () => void };

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
