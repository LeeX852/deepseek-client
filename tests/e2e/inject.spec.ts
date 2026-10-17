import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('INJECT_TEXT 写入受控 textarea 且触发 input 事件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-inject-'));
  const page = path.join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><meta charset=utf-8><body>
    <textarea id="t"></textarea>
    <script>const t=document.getElementById('t');let state='';
    t.addEventListener('input',()=>{state=t.value;document.title='state:'+state;});</script>
    </body>`);
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/') },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }, text) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('shell:inject-text', { text });
  }, '注入的文本');
  await expect.poll(async () => {
    return win.title();
  }, { timeout: 5000 }).toContain('state:注入的文本');
  await app.close();
});

// Plan 4 Task 4：Ctrl+O 的两条方向都要钉在页面行为上，而不是"钩子被调用"。
// 原生打开框无法自动化——注入假 pickOpenPath（R-K 的 injectLocalFile 钩子）绕过它，
// 其余全走生产链：prepareFileInject → webContents.send(INJECT_TEXT) → preload
// injectText 写 textarea。超限文件必须让 textarea 原样不动、并记一条「文件过大」反馈。
test('Ctrl+O：小文件经真实注入链写进 textarea；超限文件不动 textarea 且反馈「文件过大」', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-inject-ctrlo-'));
  const page = path.join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><meta charset=utf-8><body>
    <textarea id="t"></textarea>
    <script>const t=document.getElementById('t');let state='';
    t.addEventListener('input',()=>{state=t.value;document.title='state:'+state;});</script>
    </body>`);
  const smallPath = path.join(dir, 'small.txt');
  writeFileSync(smallPath, 'hello ctrl-o');
  // 恰好 524288 字节 ASCII：readTextFileCapped 的 statSync().size 判不出超限，
  // 但加上引用块围栏与文件名后越过 injectTextSchema 上限——组合超限，prepareFileInject
  // 必须在出门前拒掉，别让不合格 payload 被 preload 静默丢弃。
  const bigPath = path.join(dir, 'big.txt');
  writeFileSync(bigPath, 'x'.repeat(524288));

  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_TEST_HOOKS: '1', DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/') },
  });
  const injectWith = (p: string) => app.evaluate(async (_e, filePath: string) => {
    const g = globalThis as unknown as {
      __dsShellTestHooks?: { injectLocalFile(o?: { pickOpenPath?: () => Promise<string | null> }): Promise<void> };
    };
    if (!g.__dsShellTestHooks) throw new Error('测试钩子未安装：主进程启动时缺少 DS_SHELL_TEST_HOOKS');
    await g.__dsShellTestHooks.injectLocalFile({ pickOpenPath: async () => filePath });
  }, p);
  const noticeTitles = () => app.evaluate(() => {
    const g = globalThis as unknown as { __dsInjectNotices?: Array<{ title: string }> };
    return (g.__dsInjectNotices ?? []).map((n) => n.title);
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const taValue = () => win.evaluate(() => (document.querySelector('textarea') as HTMLTextAreaElement).value);

    // 小文件：textarea 里真的出现围栏块（文件名在围栏信息串上、内容在三反引号之间）。
    await injectWith(smallPath);
    await expect.poll(taValue, { timeout: 5000 }).toContain('hello ctrl-o');
    const afterSmall = await taValue();
    expect(afterSmall).toContain('```small.txt');
    expect(afterSmall.endsWith('```\n')).toBe(true);

    // 超限：注入不发 → textarea 保持上一轮的内容不变；反馈记一条「文件过大」。
    await injectWith(bigPath);
    await expect.poll(noticeTitles, { timeout: 5000 }).toContain('文件过大');
    expect(await taValue()).toBe(afterSmall);
  } finally {
    await app.close();
  }
});
