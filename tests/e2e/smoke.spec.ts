import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('主窗口加载远端 URL 且 UA 不含自身标识', async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: mkdtempSync(path.join(tmpdir(), 'ds-shell-')) },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  expect(win.url()).toContain('deepseek.com');
  const ua = await win.evaluate(() => navigator.userAgent);
  expect(ua).not.toMatch(/Electron/i);
  expect(ua).not.toMatch(/ds-shell/i);
  await app.close();
});
