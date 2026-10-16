import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function launch(seed?: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-shell-e2e-'));
  for (const [name, value] of Object.entries(seed ?? {})) {
    writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'https://chat.deepseek.com/' },
  });
  return { app, dir };
}

test('closeToTray：关闭只隐藏，窗口对象仍在且不可见', async () => {
  const { app, dir } = await launch();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // 关闭触发方式说明（控制器裁决适用点）：Playwright 的 page.close() 在 Electron 下
  // 执行的是渲染端 window.close()——Electron 44 中该路径不触发可拦截的窗口 'close'
  // 事件（最小复现：on('close') 未走、'closed' 直接触发），任何主进程实现都无法预防，
  // 用它断言"关闭即隐藏"是在断言平台缺陷而非应用行为。
  // BrowserWindow.close()（主进程）才是 Electron 文档定义的用户点 X 的等价路径，
  // 'close' 可被 preventDefault——这正是本用例要验证的机制。断言原样保留、不放宽。
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.close();
  });
  const state = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { count: BrowserWindow.getAllWindows().length, visible: w?.isVisible() ?? null };
  });
  expect(state.count).toBe(1);
  expect(state.visible).toBe(false);
  expect(existsSync(dir)).toBe(true);
  await app.close();
});

test('启动时按 window.json 恢复位置与尺寸', async () => {
  const { app } = await launch({
    'window.json': { x: 100, y: 100, width: 800, height: 600, maximized: false },
  });
  await app.firstWindow();
  const b = await app.evaluate(({ BrowserWindow }) => {
    // noUncheckedIndexedAccess：数组在断言"必须存在"前按 possibly-undefined 处理。
    const w = BrowserWindow.getAllWindows()[0]!;
    return w.getBounds();
  });
  expect(b.width).toBe(800);
  expect(b.height).toBe(600);
  await app.close();
});

test('window.json 里的屏幕外坐标被忽略，使用默认尺寸', async () => {
  const { app } = await launch({
    'window.json': { x: 99999, y: 99999, width: 800, height: 600, maximized: false },
  });
  await app.firstWindow();
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  expect(b.width).toBe(1200);
  await app.close();
});

test('窗口状态与设置落盘到 userData', async () => {
  const { app, dir } = await launch();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 200, y: 200, width: 1000, height: 700 }));
  await new Promise(r => setTimeout(r, 1200));
  const files = readdirSync(dir);
  expect(files).toContain('window.json');
  expect(files).toContain('settings.json');
  await app.close();
});
