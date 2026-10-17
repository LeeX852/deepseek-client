import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Plan 4 Task 2：降级必须可双向恢复。Task 1 让 observer 在好轮复位 degraded，
// 但主进程 degradedLatched 只置位从不复位——托盘会永远停在「页面已改版」。
// 本用例走真实 IPC 把整条链钉死：登录态上报不降级 → 持续改版降级 → 会话 DOM
// 回来（新的 PAGE_EVENT）即清闩。isDegraded 挂在 __dsShellTestHooks 上（顶层
// 构造的测试钩子），不是直接挂 globalThis，取值必须经这一层。
test('降级可恢复：改版页降级后，会话 DOM 回来即清主进程降级态', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-rec-'));
  const page = path.join(dir, 'index.html');
  // 用登录态 fixture 的真实 DOM（textarea + 侧边栏会话锚点），但剥掉它自带的
  // CDN <script>/<link>：脚本加载失败时 fixture 的 _sriCk onerror 处理器会
  // replaceChildren 清空 body，与 observer 抢 DOM、把用例变成网络竞态。
  // observer 只关心 DOM 结构，去掉外链后行为确定。
  const raw = readFileSync(path.join(repoRoot, 'tests/fixtures/logged-in.html'), 'utf8');
  writeFileSync(page, raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      DS_SHELL_TEST_HOOKS: '1',
      DS_SHELL_USER_DATA: dir,
      DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/'),
    },
  });
  const shell = await app.firstWindow();
  const degraded = () =>
    app.evaluate(() =>
      (globalThis as unknown as { __dsShellTestHooks: { isDegraded(): boolean } })
        .__dsShellTestHooks.isDegraded(),
    );
  const pageEventCount = () =>
    app.evaluate(() => (globalThis as unknown as { __dsPageEventCount?: number }).__dsPageEventCount ?? 0);

  // 阶段一：登录态 fixture 有会话与 textarea → observer 正常上报、不降级。
  // 先等真实事件到账再断言未降级：否则「observer 根本没跑」也会是未降级，断言空洞。
  await expect.poll(pageEventCount, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await degraded()).toBe(false);

  // 阶段二：清空页面（无会话、无 textarea）并每 100ms 改 DOM——空轮计数才能一路
  // 推到阈值 20（静态空页没有后续 mutation，反而不排 tick）。阈值 20×500ms≈10s。
  await shell.evaluate(() => {
    document.body.replaceChildren();
    setInterval(() => {
      const d = document.createElement('div');
      d.textContent = 'mutating';
      document.body.appendChild(d);
    }, 100);
  });
  await expect.poll(degraded, { timeout: 40_000 }).toBe(true);

  // 阶段三：会话 DOM 回来 → 下一轮 tick 发 session-list-changed → 主进程 onEvent
  // 复位 degradedLatched。没有这一步，闩锁永不释放，托盘停在降级文案。
  await shell.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'https://chat.deepseek.com/a/chat/s/recovered1';
    a.textContent = '恢复的会话';
    document.body.appendChild(a);
    document.body.appendChild(document.createElement('textarea'));
  });
  await expect.poll(degraded, { timeout: 20_000 }).toBe(false);

  await app.close();
});
