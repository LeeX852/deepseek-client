import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { minimalLocalPageUrl } from './helpers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function launch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-tray-quit-'));
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: minimalLocalPageUrl() },
  });
  return { app, dir };
}

async function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  let last = await read();
  const deadline = Date.now() + ms;
  while (!done(last) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    last = await read();
  }
  return last;
}

// R22 回归：Windows 上退出前不显式销毁 Tray，通知区域会残留幽灵图标（悬停才消失）——
// 而托盘正是规格里"唯一唤起入口"，残留一个还能点的图标是明确缺陷。
// 探针做法：在真实 Tray.prototype.destroy 上包一层同步 appendFileSync 记账
// （prototype 方法在调用时才解析，包在托盘创建之后依然生效），然后驱动生产退出路径
// app.quit() → before-quit → will-quit，进程消失后从磁盘判定装配点是否真的调用了
// tray.destroy()。缺陷版（will-quit 只 dispose 快捷键）里文件根本不会被创建。
test('退出时销毁托盘：will-quit 处理器调用 tray.destroy()', async () => {
  const { app, dir } = await launch();
  await app.firstWindow();
  const file = path.join(dir, 'tray-destroy.log');

  await app.evaluate(({ Tray }, logFile: string) => {
    // 同步取 fs：Playwright 的 evaluate 上下文没有动态 import 回调，
    // process.getBuiltinModule 是主进程里可用的同步路径（写法沿用 recordShellEvents
    // 的磁盘日志先例——退出流程会掐断调试连接，断言必须能从磁盘判定）。
    const { appendFileSync } = process.getBuiltinModule('node:fs');
    const original = Tray.prototype.destroy;
    Tray.prototype.destroy = function (this: { destroy(): void }) {
      appendFileSync(logFile, 'destroy\n');
      original.call(this);
    };
  }, file);

  // 先取住子进程句柄：quit 可能先于 evaluate 回包掐断调试连接，断言全部基于磁盘。
  const proc = app.process();
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);

  const exitCode = await pollUntil(() => Promise.resolve(proc.exitCode), c => c !== null, 30_000);
  expect(exitCode).toBe(0);
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  expect(lines).toContain('destroy'); // 缺陷版这里是空数组
  await app.close().catch(() => undefined);
});
