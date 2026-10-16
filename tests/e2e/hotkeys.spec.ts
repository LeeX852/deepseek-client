import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function launch(seed?: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-hotkeys-'));
  for (const [name, value] of Object.entries(seed ?? {})) {
    writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'https://chat.deepseek.com/' },
  });
  return { app, dir };
}

// 产品装配点验证：index.ts 用默认（非注入）路径向真实 globalShortcut 注册两把热键。
// isRegistered 是主进程内的真实查询——注册没发生就是 false，不存在永真路径。
test('默认两把全局热键在产品启动路径注册成功', async () => {
  const { app } = await launch();
  await app.firstWindow();

  const state = await app.evaluate(({ globalShortcut }) => ({
    toggle: globalShortcut.isRegistered('CommandOrControl+Alt+D'),
    quickAsk: globalShortcut.isRegistered('CommandOrControl+Alt+Q'),
  }));
  expect(state.toggle).toBe(true);
  expect(state.quickAsk).toBe(true);
  await app.close();
});

// 装配点读取路径：store.get() 的自定义值必须真的流进 globalShortcut。
// 若接线读错源（例如硬编码默认值），F16 不会在场而 D 会——断言双向钉死。
// 冲突通知路径（onConflict → Notification）在纯外部进程视角不可观测，
// 由单测（注入 fake）与 Electron 44 真机探针（isTaken→冲突、dispose→释放）覆盖，
// 视觉确认留在 README 手动清单。
test('settings.json 自定义的 toggleHotkey 决定真实注册结果', async () => {
  const { app } = await launch({
    'settings.json': { toggleHotkey: 'CommandOrControl+Alt+F16' },
  });
  await app.firstWindow();
  const state = await app.evaluate(({ globalShortcut }) => ({
    custom: globalShortcut.isRegistered('CommandOrControl+Alt+F16'),
    oldDefault: globalShortcut.isRegistered('CommandOrControl+Alt+D'),
    quickAsk: globalShortcut.isRegistered('CommandOrControl+Alt+Q'),
  }));
  expect(state.custom).toBe(true);
  expect(state.oldDefault).toBe(false);
  expect(state.quickAsk).toBe(true);
  await app.close();
});
