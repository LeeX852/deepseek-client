// scripts/capture-fixture.mjs — 一次性 fixture 抓取工具（Plan 3 Task 7 Step 2）。
//
// 用途：把真实登录态的 DeepSeek DOM 快照成 tests/fixtures/logged-in.html，
// 供 observer / selectors 契约测试离线回归（selectors.ts 的抓取依据就是这类快照）。
// 思路复用 spike/m0 的 probe：独立 Electron 进程直接加载 persist:deepseek 分区，
// 与主应用共享登录态。sandbox:false 在这里是允许的——它不是产品代码路径，
// 是开发者本机跑的一次性脚本，需要的是 executeJavaScript 抓 outerHTML 的便利。
//
// 用法：
//   pnpm exec electron scripts/capture-fixture.mjs [--yes] [输出路径]
//     （--yes 与输出路径都放在脚本路径之后；Electron CLI 下
//      process.argv = [electron, 脚本, 用户参数...]，脚本内从 argv[2] 起解析）
//   1. 先退出正在运行的 ds-shell（persist:deepseek 目录同时只允许一个进程占用）；
//   2. 启动后在窗口里正常登录/进入任意会话；
//   3. 按 Ctrl+S 抓取当前 document.documentElement.outerHTML 写入输出路径；
//      可反复抓，每次都覆盖为最新快照；Ctrl+Q 或关窗退出。
//   默认输出 tests/fixtures/logged-in.html；文件已存在时交互式确认覆盖，
//   --yes 跳过确认（非交互/CI 场景）。
//
// 抓取后必做：跑 pnpm test（selectors-contract 单测会校验契约形状），
// 若选择器失效先在 tests/fixtures 里确认结构再改 src/preload/selectors.ts。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userArgs = process.argv.slice(2);
const forceOverwrite = userArgs.includes('--yes');
const target = path.resolve(userArgs.find((a) => !a.startsWith('-')) ?? path.join(repoRoot, 'tests/fixtures/logged-in.html'));

// 覆盖确认只在文件已存在且没给 --yes 时发生一次；拿不到交互终端就直接退出，
// 绝不静默覆盖开发者手工整理的 fixture。
async function confirmOverwrite() {
  if (!existsSync(target) || forceOverwrite) return true;
  if (!stdin.isTTY) {
    console.error(`[capture] ${target} 已存在且当前不是交互终端：加 --yes 明确覆盖。`);
    return false;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`[capture] 覆盖 ${target}？(y/N) `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function main() {
  await app.whenReady();
  if (!(await confirmOverwrite())) {
    app.exit(1);
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'DeepSeek fixture 抓取',
    webPreferences: { partition: 'persist:deepseek', contextIsolation: true, sandbox: false },
  });

  let snapshots = 0;
  async function snapshot(label) {
    try {
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
      if (typeof html !== 'string' || html.length === 0) {
        console.warn('[capture] 快照为空（页面还没渲染完？），本次跳过。');
        return;
      }
      writeFileSync(target, html, 'utf8');
      snapshots += 1;
      console.log(`[capture] ${label}：已写 ${target}（${html.length} 字符，第 ${snapshots} 次快照）。`);
    } catch (err) {
      console.error('[capture] 抓取失败：', err);
    }
  }

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      void snapshot('Ctrl+S');
    } else if (key === 'q') {
      e.preventDefault();
      app.quit();
    }
  });
  win.webContents.on('did-navigate', (_e, url) => console.log(`[capture] 已加载 ${url} —— 登录并进入会话后按 Ctrl+S 抓取。`));

  await win.loadURL('https://chat.deepseek.com/');
  console.log('[capture] 窗口就绪：登录 → 进入任意会话 → Ctrl+S 抓取 → Ctrl+Q 退出。');

  app.on('window-all-closed', () => {
    if (snapshots === 0) console.warn('[capture] 本次没有抓到任何快照。');
    app.quit();
  });
}

void main();
