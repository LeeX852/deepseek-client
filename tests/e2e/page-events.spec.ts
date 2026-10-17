import { test, expect, _electron as electron } from '@playwright/test';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type PageEventHooks = {
  __dsPageEventCount?: number;
  __dsPageEventTypes?: string[];
  __dsDegradedFlips?: number;
};

async function launchShell(url: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-pe-'));
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      // 测试钩子（brief Step 3）：只有置位时 onEvent/onDegraded 才写 globalThis。
      DS_SHELL_TEST_HOOKS: '1',
      DS_SHELL_USER_DATA: dir,
      DS_SHELL_URL: url,
    },
  });
  await app.firstWindow();
  return { app, dir };
}

// brief Step 2：真实登录态 fixture 经 file:// 打开，observer 上报 → 主进程
// registerPageEvents 收到并通过测试钩子记账。断言事件"类型"而不只是计数——
// 只有 auth-state-changed 也能把计数推过 0，钉死 session-list-changed 才算打通。
test('observer 从登录态 DOM 上报 session-list-changed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-pe-page-'));
  const page = path.join(dir, 'index.html');
  copyFileSync(path.join(repoRoot, 'tests/fixtures/logged-in.html'), page);
  const { app } = await launchShell('file://' + page.replace(/\\/g, '/'));
  await expect
    .poll(
      async () =>
        app.evaluate(
          () =>
            (globalThis as unknown as PageEventHooks).__dsPageEventTypes ?? [],
        ),
      { timeout: 20_000 },
    )
    .toContain('session-list-changed');
  const count = await app.evaluate(
    () => (globalThis as unknown as PageEventHooks).__dsPageEventCount ?? 0,
  );
  expect(count).toBeGreaterThan(0);
  await app.close();
});

// 降级链路：页面持续改版（永远等不到会话结构）→ preload 闩锁降级并发
// OBSERVER_DEGRADED → 主进程翻托盘。交接 5 的幂等在这里钉死：闩锁后 preload
// 每个防抖 tick 都会重发，degradedFlips 必须停在 1，绝不逐 tick 累加。
// 阈值缓解（20 轮 × 500ms 且首 tick 等 DOMContentLoaded）后 poll 超时留足 40s。
test('改版页自降级：托盘翻牌一次且对重复上报幂等', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-pe-deg-'));
  const page = path.join(dir, 'index.html');
  // 无会话结构、无 textarea，且每 100ms 改一次 DOM——保证防抖 tick 持续排下去，
  // 空轮计数能一路推到阈值（静态空白页没有后续 mutation，反而永远走不到降级）。
  writeFileSync(
    page,
    `<!doctype html><meta charset=utf-8><body>
    <script>let n=0;setInterval(()=>{const d=document.createElement('div');
    d.textContent=String(n++);document.body.appendChild(d);},100);</script>
    </body>`,
  );
  const { app } = await launchShell('file://' + page.replace(/\\/g, '/'));
  await expect
    .poll(
      async () =>
        app.evaluate(
          () => (globalThis as unknown as PageEventHooks).__dsDegradedFlips ?? 0,
        ),
      { timeout: 40_000 },
    )
    .toBeGreaterThan(0);
  // 再给闩锁后的重发留 ~3s（每 500ms 一次 OBSERVER_DEGRADED）：翻牌次数仍是 1，
  // 去重若失效这里会立刻变成 6+。
  await new Promise((r) => setTimeout(r, 3000));
  const flips = await app.evaluate(
    () => (globalThis as unknown as PageEventHooks).__dsDegradedFlips ?? 0,
  );
  expect(flips).toBe(1);
  await app.close();
});
