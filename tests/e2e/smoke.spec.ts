import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { minimalLocalPageUrl } from './helpers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 默认套件不许依赖网络：本用例只用壳窗口的 URL 与 UA 断言，挂本地页即可——
// 线上站一次加载慢/失败就会 flake。别担心测不到 UA：@live 用例同样断言这一点。
test('主窗口加载指定 URL 且 UA 不含自身标识', async () => {
  const localUrl = minimalLocalPageUrl();
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: mkdtempSync(path.join(tmpdir(), 'ds-shell-')), DS_SHELL_URL: localUrl },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // win.url() 是 Chromium 归一化后的值（file://C:/… → file:///C:/…），比较归一化结果。
  expect(win.url()).toBe(new URL(localUrl).href);
  const ua = await win.evaluate(() => navigator.userAgent);
  expect(ua).not.toMatch(/Electron/i);
  expect(ua).not.toMatch(/ds-shell/i);
  await app.close();
});

// @live：需要真实网络——不覆盖 DS_SHELL_URL 即产品的默认远端 URL。因此被
// playwright.config 的 grepInvert 排除在默认套件之外，用 pnpm test:e2e:live 显式跑。
// 仍然保留：本地页替不了「产品默认 URL 指向真实站」这条验收意图。
test('@live 主窗口加载远端 URL 且 UA 不含自身标识', async () => {
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
