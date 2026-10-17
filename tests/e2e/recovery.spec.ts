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

  // 阶段三：会话 DOM 回来（带 textarea，signedIn 由 false 跃迁到 true）→ 下一个防抖
  // tick 里 observer 先发 auth-state-changed(true)（R-J：清闩的第一个事件是它，不是
  // session-list-changed——observer 先发 auth 再走会话键分支），主进程 onEvent 收到即
  // clearDegraded；同一轮若会话内容键也变了还会补发 session-list-changed，两条路径都
  // 能把闩放掉。没有这一步闩锁永不释放，托盘停在降级文案。
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

// Plan 4 Task 3（R-F）：退出前统一回收 pageEvents。dispose 的「幂等不抛」是空断言——
// 真正要钉的是「监听器确实摘掉了」：页面持续 mutation、observer 每轮都产
// session-list-changed。dispose 前计数一路涨；dispose 后计数必须冻住。若 dispose 从未
// 接上（监听器还在），计数会继续增长，这里的 toBe(frozen) 就会红——这正是红灯要证的事。
// 页面用最小合成 DOM 而非 fixture：只追加唯一 id 的会话锚点，保证每轮防抖 tick 的内容键
// 都在变、必发事件（静态页没有后续 mutation，反而发不出第二个事件）。
test('退出前回收 pageEvents：dispose 后页面再 mutation 不再进主进程', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-rec-dispose-'));
  const page = path.join(dir, 'index.html');
  // textarea = 登录态；每 100ms 追加一个唯一 id 的会话 <a>，驱动 observer 每轮内容键
  // 都变 → 持续发 session-list-changed（防抖 tick 500ms 一次）。
  writeFileSync(
    page,
    `<!doctype html><meta charset=utf-8><body><textarea></textarea>
    <script>let n=0;setInterval(()=>{n++;const a=document.createElement('a');
    a.href='/a/chat/s/dispose'+n;
    a.innerHTML='<div class="ds-focus-ring"></div><div>会话'+n+'</div>';
    document.body.appendChild(a);},100);</script></body>`,
  );
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...process.env,
      DS_SHELL_TEST_HOOKS: '1',
      DS_SHELL_USER_DATA: dir,
      DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/'),
    },
  });
  await app.firstWindow();
  const count = () =>
    app.evaluate(() => (globalThis as unknown as { __dsPageEventCount?: number }).__dsPageEventCount ?? 0);
  const dispose = () =>
    app.evaluate(() =>
      (globalThis as unknown as { __dsShellTestHooks: { disposePageEvents(): void } })
        .__dsShellTestHooks.disposePageEvents(),
    );

  // 先等真实事件到账：证明监听器在工作、计数是活的（否则「不增长」也可能是 observer 根本没跑）。
  await expect.poll(count, { timeout: 20_000 }).toBeGreaterThan(0);
  await dispose();
  // 留一个防抖周期让 dispose 前已排队的事件落定，再取基线——避免把在途事件算成"增长"。
  await new Promise((r) => setTimeout(r, 800));
  const frozen = await count();
  // 页面继续 mutation 3s（≈6 个防抖 tick）：监听器已摘，计数必须一动不动。
  await new Promise((r) => setTimeout(r, 3000));
  expect(await count()).toBe(frozen);
  // dispose 幂等：再来一次不抛、计数仍旧（生产 will-quit 只调一次，这里顺带钉幂等）。
  await dispose();
  expect(await count()).toBe(frozen);

  await app.close();
});
