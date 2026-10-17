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
