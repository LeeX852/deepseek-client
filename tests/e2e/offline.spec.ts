import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
