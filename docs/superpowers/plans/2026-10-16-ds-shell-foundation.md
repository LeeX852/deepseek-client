# ds-shell V1 Plan 1：前置验证与基础壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可日常使用的 Electron 桌面壳：登录 `chat.deepseek.com` 后长期保活、关闭窗口常驻托盘、全局快捷键随时唤起、窗口状态记忆、离线不卡在浏览器错误页，并产出一份决定后续功能可行性的 M0 验证报告。

**Architecture:** 三层上下文——主进程（Node）负责全部桌面能力；`persist:deepseek` 分区里的预加载脚本是唯一接触远端 DOM 的组件；本地窗口（覆盖层）用 `persist:shell` 分区，与登录态物理隔离。Plan 1 只实现壳与安全配置，远端 DOM 观察/归档/注入留给 Plan 2，但 Plan 1 的 spike 负责证明它们可行并交出真实选择器。

**Tech Stack:** Electron（`latest`，由 `pnpm add` 解析并锁进 lockfile）、TypeScript strict、esbuild（打包 main 与 preload 为 CJS；sandboxed preload 必须是 CJS）、Vitest（纯逻辑单测）、@playwright/test 的 `_electron`（集成测试）、zod（跨进程负载校验）、pngjs（生成托盘图标）、electron-builder（portable 产物）。

**Spec:** [docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md](file:///D:/Programs/ds-web-client/docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md)

## Global Constraints

以下每条来自 spec，每个任务都隐含遵守：

- 目标平台：Windows 10 及以上，x64。产物形态：portable exe，本机自用。不做安装包、不做自动更新、不做 macOS/Linux。
- 远端窗口 `webPreferences`：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`、`allowRunningInsecureContent: false`。spike 目录是唯一允许 `sandbox: false` 的地方，且标注为一次性代码。
- 分区：远端 `persist:deepseek`，本地窗口 `persist:shell`。不得注册任何把本地文件系统暴露给远端页的自定义协议。
- 红线：绝不以脚本方式向 DeepSeek 内部接口发请求；不做并发自动化；归档数据只落本地 `userData`，无遥测；剪贴板只在用户显式按下快捷键时读取。
- 远端页面文本一律视为不可信数据：不作为 HTML 渲染、不拼成命令、不作为文件路径。
- TypeScript：`strict: true`，`noUncheckedIndexedAccess: true`。测试文件与被测文件同目录树不同根（`tests/unit`、`tests/e2e`）。
- 提交频率：每个任务一次提交，提交信息说明"为什么"。
- 默认快捷键：唤起/隐藏 `CommandOrControl+Alt+D`；划词提问 `CommandOrControl+Alt+Q`（Plan 2 使用）。
- 远端 URL 常量：`https://chat.deepseek.com/`，测试可用环境变量 `DS_SHELL_URL` 覆盖。
- userData 目录：测试可用环境变量 `DS_SHELL_USER_DATA` 覆盖。

---

## File Structure（Plan 1 结束后项目应有形态）

```
package.json                      依赖与脚本
tsconfig.json                     strict 配置，typecheck 用
vitest.config.ts                  单测根
playwright.config.ts              集成测试根
scripts/build.mjs                 esbuild 打包 + 静态资源复制
scripts/make-icon.mjs              pngjs 生成 32x32 托盘图标
resources/icon.png                生成物，纳入版本库
src/main/index.ts                 入口：装配 app 生命周期与单实例锁
src/main/settings.ts              userData/settings.json 读写与迁移
src/main/windowState.ts           窗口 bounds 序列化与屏幕合法性校验
src/main/shellWindow.ts           主窗口：远端加载、安全配置、关闭即隐藏、显示/隐藏切换、真正退出
src/main/tray.ts                  托盘图标、菜单、tooltip、degraded 标记
src/main/hotkeys.ts               全局快捷键注册、冲突处理、重注册
src/main/overlay.ts               离线覆盖层窗口（persist:shell）
src/main/ua.ts                    从 Electron 默认 UA 去掉自身标识
src/shared/ipc.ts                 IPC 通道名常量
src/shared/pageEvent.ts           zod schema：页面事件与注入请求
src/preload/deepseek.ts           Plan 2 才有实质内容；Plan 1 只建立空壳并挂载
src/preload/selectors.ts          Task 2 由 M0 报告填写真实选择器
spike/m0/main.mjs                 一次性探针入口（不进版本库主代码）
spike/m0/probe.cjs                一次性探针 preload
spike/m0/REPORT.md                M0 结论，交付物
tests/unit/*.test.ts
tests/e2e/*.spec.ts
tests/fixtures/                   M0 抓下的 DOM 片段，Plan 2 契约测试用
```

---

## M0 里程碑：前置验证

### Task 1: 项目脚手架与可运行的远端窗口

**Files:**
- Create: `package.json`, `tsconfig.json`, `scripts/build.mjs`, `scripts/make-icon.mjs`, `src/main/index.ts`, `src/main/ua.ts`, `src/main/shellWindow.ts`, `vitest.config.ts`, `playwright.config.ts`, `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `createShellWindow(): BrowserWindow`（后续任务在此文件里扩展）；`browserLikeUA(defaultUA: string): string`；脚本 `pnpm build` / `pnpm dev` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`。

- [ ] **Step 1: 初始化依赖**

```bash
cd /d/Programs/ds-web-client
pnpm init
pnpm add -D electron typescript esbuild vitest @playwright/test @types/node pngjs electron-builder
pnpm add zod
```

Expected: `package.json` 出现 dependencies 与 devDependencies，`pnpm-lock.yaml` 生成。记录解析到的 electron 主版本号，Step 6 提交信息里引用。

- [ ] **Step 2: 写 `package.json` 的 scripts 与 main**

把 `pnpm init` 生成的 `package.json` 补成：

```json
{
  "name": "ds-shell",
  "version": "0.1.0",
  "private": true,
  "main": "out/main/index.js",
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "dev": "pnpm build && electron .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "pnpm build && playwright test",
    "icon": "node scripts/make-icon.mjs"
  }
}
```

`main` 指向 `out/` 而源码用 ESM 语法：esbuild 会把 main 打包成 CJS，`type: module` 只影响我们自己的 `.js` 脚本解析。

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: 写 `scripts/build.mjs`**

```js
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';

rmSync('out', { recursive: true, force: true });
mkdirSync('out/renderer', { recursive: true });

await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], outfile: 'out/main/index.js', sourcemap: true,
});

await build({
  entryPoints: ['src/preload/deepseek.ts'],
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  outfile: 'out/preload/deepseek.js', sourcemap: true,
});

if (existsSync('src/renderer')) cpSync('src/renderer', 'out/renderer', { recursive: true });
cpSync('resources', 'out/resources', { recursive: true });
console.log('[build] ok');
```

- [ ] **Step 5: 写 `scripts/make-icon.mjs`**

32x32 蓝色圆点，色值取自官方页面主强调色。M4 会用品牌图标替换，但托盘需要一个立即可用的可见图标。

```js
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 32;
const png = new PNG({ width: S, height: S });
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (S * y + x) << 2;
    const inside = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5) <= S / 2 - 2;
    png.data[i] = 0x4d; png.data[i + 1] = 0x6b; png.data[i + 2] = 0xfe;
    png.data[i + 3] = inside ? 0xff : 0x00;
  }
}
mkdirSync('resources', { recursive: true });
writeFileSync('resources/icon.png', PNG.sync.write(png));
console.log('[icon] resources/icon.png');
```

Run: `pnpm icon` → Expected: 文件存在且 `file resources/icon.png` 报 PNG image data 32 x 32。

- [ ] **Step 6: 写 `src/main/ua.ts`**

不硬编码 Chrome 版本号：把 Electron 默认 UA 里代表我们自己的 token 摘掉，剩下的就是bundled Chromium 的真实浏览器形态。

```ts
export function browserLikeUA(defaultUA: string): string {
  return defaultUA
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*ds-shell\/[\d.]+/g, '')
    .trim();
}
```

- [ ] **Step 7: 写 `src/main/shellWindow.ts`（本任务版本）**

```ts
import { app, BrowserWindow, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { browserLikeUA } from './ua';

export const REMOTE_URL = process.env.DS_SHELL_URL ?? 'https://chat.deepseek.com/';
export const DEEPSEEK_PARTITION = 'persist:deepseek';

const ALLOWED_HOSTS = new Set(['chat.deepseek.com', 'deepseek.com', 'www.deepseek.com', 'cdn.deepseek.com', 'ssl.cdn.one', 'accounts.google.com', 'github.com', 'appleid.apple.com']);

let win: BrowserWindow | null = null;

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && [...ALLOWED_HOSTS].some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

export function createShellWindow(): BrowserWindow {
  const preload = path.join(app.getAppPath(), 'out/preload/deepseek.js');
  win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    title: 'DeepSeek',
    icon: path.join(app.getAppPath(), 'out/resources/icon.png'),
    webPreferences: {
      partition: DEEPSEEK_PARTITION,
      preload: existsSync(preload) ? preload : undefined,
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });

  const ses = session.fromPartition(DEEPSEEK_PARTITION);
  ses.setUserAgent(browserLikeUA(ses.getUserAgent()));

  win.once('ready-to-show', () => win?.show());
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  void win.loadURL(REMOTE_URL, { userAgent: browserLikeUA(session.defaultSession.getUserAgent()) });
  return win;
}

export function getShellWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
```

- [ ] **Step 8: 写 `src/main/index.ts`（本任务版本）**

```ts
import { app, BrowserWindow } from 'electron';
import { createShellWindow } from './shellWindow';

if (process.env.DS_SHELL_USER_DATA) {
  app.setPath('userData', process.env.DS_SHELL_USER_DATA);
}

void app.whenReady().then(() => {
  createShellWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createShellWindow();
  });
});
```

- [ ] **Step 9: 写空的 `src/preload/deepseek.ts` 让构建通过**

```ts
export {};
```

- [ ] **Step 10: 写 `vitest.config.ts` 与 `playwright.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
```

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
});
```

- [ ] **Step 11: 写冒烟集成测试（先失败）**

`tests/e2e/smoke.spec.ts`：

```ts
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
```

Run: `pnpm test:e2e` → Expected: 通过（这是脚手架是否成立的判据）。若网络不可达导致 URL 停在 `about:blank`，先确认代理/网络，再改用 `DS_SHELL_URL` 指向一个本地 https 测试服务，不允许把断言放宽成"URL 是空也通过"。

- [ ] **Step 12: 手动跑一次确认可登录**

Run: `pnpm dev`。Expected: 窗口显示 DeepSeek 页面、能看到登录入口、登录成功、关掉终端再 `pnpm dev` 仍在登录态（分区持久化生效）。若页面拒绝或异常，立刻转 Task 2 记录结论，不要继续实现。

- [ ] **Step 13: 提交**

```bash
git add -A
git commit -m "feat: Electron 脚手架与远端窗口

用 persist:deepseek 分区承载 chat.deepseek.com，登录态得以跨重启保活；
UA 里摘掉 Electron/ds-shell 标识并把导航锁在 deepseek 域，
避免站点把我们识别成自动化工具、避免窗口被导航到钓鱼页。"
```

---

### Task 2: M0 前置验证 spike

**Files:**
- Create: `spike/m0/main.mjs`, `spike/m0/probe.cjs`, `spike/m0/REPORT.md`, `src/preload/selectors.ts`, `tests/fixtures/.gitkeep`

**Interfaces:**
- Consumes: Task 1 的 `browserLikeUA`（spike 里重复实现同一逻辑，因为 spike 要能独立运行）
- Produces: `src/preload/selectors.ts` 导出 `SELECTORS`（Plan 2 的 observer 与注入全部从这里取选择器）；`spike/m0/REPORT.md` 的五项结论；`tests/fixtures/*.html` DOM 快照。

- [ ] **Step 1: 写 `spike/m0/probe.cjs`（一次性代码，允许 `sandbox: false` 以便直接落盘）**

```cjs
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.env.DS_SPIKE_OUT || 'spike/m0/out';
fs.mkdirSync(OUT, { recursive: true });

function chain(el) {
  const parts = [];
  let n = el;
  for (let d = 0; d < 5 && n && n.nodeType === 1; d++, n = n.parentElement) {
    const cls = typeof n.className === 'string' && n.className.trim()
      ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + cls);
  }
  return parts.join(' > ');
}

function rows(sel, limit) {
  return [...document.querySelectorAll(sel)].slice(0, limit).map(el => ({
    tag: el.tagName, id: el.id || null,
    cls: typeof el.className === 'string' ? el.className : null,
    role: el.getAttribute('role'), testid: el.getAttribute('data-testid'),
    aria: el.getAttribute('aria-label'), chain: chain(el),
    text: (el.innerText || el.value || '').replace(/\s+/g, ' ').slice(0, 120),
  }));
}

function snapshot(tag) {
  const stamp = {
    at: new Date().toISOString(), url: location.href, title: document.title,
    ua: navigator.userAgent,
    editable: rows('textarea,[contenteditable="true"],[role="textbox"]', 20),
    sidebar: rows('aside,[class*="sidebar" i],[class*="list" i],[class*="history" i]', 40),
    itemish: rows('[data-testid],[class*="session" i],[class*="conversation" i],[class*="chat-item" i]', 120),
    messages: rows('[class*="markdown" i],[class*="message" i],[class*="answer" i]', 60),
  };
  fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify(stamp, null, 2));
  fs.writeFileSync(path.join(OUT, `${tag}.html`), document.documentElement.outerHTML);
  ipcRenderer.sendToHost?.('');
  console.log('[probe] snapshot ' + tag + ' url=' + location.href);
  return stamp;
}

// 注入自测：React 受控组件是否接受我们的写入。
// 判据：写入后 500ms 值仍在，说明组件内部状态被同步更新。
async function insertTest() {
  const ed = document.querySelector('textarea,[contenteditable="true"],[role="textbox"]');
  if (!ed) { console.log('[probe] insert=NO_EDITABLE'); return; }
  const token = 'DS_SHELL_SPIKE_' + Date.now();
  ed.focus();
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) {
    const proto = ed instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    setter.call(ed, token);
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: token }));
  } else {
    const sel = window.getSelection();
    if (sel) { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    document.execCommand('insertText', false, token);
  }
  const before = (ed.value || ed.innerText || '').includes(token);
  await new Promise(r => setTimeout(r, 500));
  const after = (ed.value || ed.innerText || '').includes(token);
  console.log(`[probe] insert dispatched=${before} persisted=${after} tag=${ed.tagName}`);

  // 合成 paste 带 File：截图注入路线的可行性判据。
  const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const dt = new DataTransfer();
  dt.items.add(new File([png], 'spike.png', { type: 'image/png' }));
  try {
    ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
    console.log('[probe] paste=DISPATCHED');
  } catch (e) { console.log('[probe] paste=ERROR ' + e.message); }
}

ipcRenderer.on('spike:snapshot', (_e, tag) => snapshot(tag));
ipcRenderer.on('spike:insert', () => void insertTest());

let rounds = 0;
const timer = setInterval(() => {
  if (++rounds > 240) { clearInterval(timer); return; }
  snapshot('auto-' + String(rounds).padStart(3, '0'));
  void insertTest();
}, 5000);
```

- [ ] **Step 2: 写 `spike/m0/main.mjs`**

```js
import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ua = session.defaultSession.getUserAgent()
  .replace(/\s*Electron\/[\d.]+/g, '')
  .replace(/\s*ds-shell\/[\d.]+/g, '')
  .trim();

await app.whenReady();
app.setPath('userData', path.join(here, 'out/userdata'));

const win = new BrowserWindow({
  width: 1280, height: 860, title: 'M0 spike',
  webPreferences: {
    preload: path.join(here, 'probe.cjs'),
    partition: 'persist:deepseek',
    contextIsolation: true, sandbox: false, nodeIntegration: false,
  },
});

win.webContents.on('console-message', (_e, _level, message) => console.log(message));
win.webContents.on('did-navigate', (_e, url) => console.log('[spike] navigate -> ' + url));
win.webContents.on('page-title-updated', (_e, t) => console.log('[spike] title -> ' + t));

await win.loadURL('https://chat.deepseek.com/', { userAgent: ua });

// 30 秒后触发一次注入自测（留出登录时间），再每隔 30 秒重复
setTimeout(() => {
  const beat = () => {
    win.webContents.send('spike:insert');
    win.webContents.send('spike:snapshot', 'manual');
  };
  beat();
  setInterval(beat, 30_000);
}, 30_000);
```

Expected: `spike/m0/out/state.json` 之类的产物随时间累积。UA 在 `app.ready` 之前不可读，所以必须先 `await app.whenReady()` 再取（脚本里已是这个顺序）。

- [ ] **Step 3: 跑 spike 并完成一轮真实使用**

Run: `pnpm exec electron spike/m0/main.mjs`（项目根为工作目录）。

按顺序做：登录 → 新建会话发一条消息 → 打开深度思考模式再发一条 → 上传一个小文件 → 切换两个历史会话 → 制造一次长回答 → `Ctrl+C` 结束。全程 `spike/m0/out/` 每 5 秒产出 `auto-NNN.json` 与 `.html`。

- [ ] **Step 4: 从产物中确定选择器**

打开最新的 `manual.json`，按下列要求各挑一条选择器，优先 `data-testid` > `role/aria-label` > 语义化 class，避免挑 hash 化的 class（形如 `css-1a2b3c`）：侧边栏会话条目、会话条目标题文本、消息列表容器、单条消息、输入框、发送按钮、登录入口标志（如登录按钮或用户头像）。

- [ ] **Step 5: 写 `src/preload/selectors.ts`**

把 Step 4 的结论落成代码。每个选择器必须同时能命中 Step 3 抓下的 fixture，Step 6 的测试会验证。字段名固定，Plan 2 全部依赖这些键：

```ts
export const SELECTORS = {
  sessionItem: 'TODO_FROM_M0',
  sessionItemTitle: 'TODO_FROM_M0',
  messageList: 'TODO_FROM_M0',
  messageItem: 'TODO_FROM_M0',
  inputBox: 'TODO_FROM_M0',
  sendButton: 'TODO_FROM_M0',
  signedInMarker: 'TODO_FROM_M0',
  capturedAt: 'TODO_ISO_TIMESTAMP',
} as const;
```

Expected: 文件内不得残留 `TODO`——用 Step 4 的真实字符串替换全部 8 个值，`capturedAt` 填抓取时间。

- [ ] **Step 6: 挑两份 fixture 入库并写契约基线测试**

从 `spike/m0/out/` 选"已登录且有会话"与"未登录"各一份 HTML，复制为 `tests/fixtures/logged-in.html`、`tests/fixtures/signed-out.html`。

`tests/unit/selectors-contract.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { SELECTORS } from '../../src/preload/selectors';

const load = (f: string) => new JSDOM(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures', f), 'utf8')).window.document;

describe('M0 选择器契约', () => {
  it('登录态 fixture 里每个选择器都能命中', () => {
    const doc = load('logged-in.html');
    for (const key of ['sessionItem', 'messageList', 'inputBox', 'signedInMarker'] as const) {
      expect(doc.querySelector(SELECTORS[key]), key).not.toBeNull();
    }
  });

  it('未登录 fixture 里不应命中登录标志', () => {
    const doc = load('signed-out.html');
    expect(doc.querySelector(SELECTORS.signedInMarker)).toBeNull();
  });
});
```

先 `pnpm add -D jsdom`（这是测试运行时依赖，允许）。

Run: `pnpm test` → Expected: FAIL 若选择器与 fixture 不符 → 回到 Step 4 修正选择器直到 PASS。这一步是整个项目最有价值的保险：官方改前端时，由它报警而不是靠用户发现。

- [ ] **Step 7: 写 `spike/m0/REPORT.md`**

必须逐项填写实际观察结果，不接受空白：

```markdown
# M0 前置验证报告

| # | 风险项 | 判据 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 站点是否拒绝本环境 | 页面正常渲染并可登录，无 bot 拦截 | 通过/不通过 | spike/m0/out/manual.json 的 url + 截图说明 |
| 2 | preload 的 DOM 可达性与 CSP | observer 能读到会话列表、消息节点、登录标志 | 通过/不通过 | SELECTORS 每项在 fixture 中的命中数 |
| 3 | 输入框注入是否被 React 接受 | 控制台 persisted=true | 通过/不通过 | `[probe] insert ...` 原始日志行 |
| 4 | 合成 paste 带 File 能否被页面接收 | 页面出现附件缩略图 | 通过/不通过 | 人工观察说明 |
| 5 | 登录是否在 deepseek 域内完成 | did-navigate 全程 hostname 属于白名单 | 通过/不通过 | `[spike] navigate ->` 全部日志行 |

## 对后续设计的影响
- 结论 2 不成立 → Plan 2 的归档/通知/划词全部取消，项目退化为 Task 1 的基础壳（仍然可用）。
- 结论 3 不成立 → 划词与文本注入改为"复制到剪贴板 + 提示用户粘贴"。
- 结论 4 不成立 → 截图注入取消，只保留划词与文本文件注入。
- 结论 5 不成立 → 放宽 ALLOWED_HOSTS 并把实际登录域加进白名单。
```

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "test: M0 前置验证与 DOM 选择器契约

把远端页面结构的不确定性压到开工之前：五项风险逐一实测并把结论
落成选择器契约测试，官方前端一旦改版，由测试报警而非用户发现。"
```

---

## M1 里程碑：可用的基础壳

### Task 3: 跨进程契约（IPC 通道与负载 schema）

**Files:**
- Create: `src/shared/ipc.ts`, `src/shared/pageEvent.ts`, `tests/unit/pageEvent.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `IPC` 常量对象（`PAGE_EVENT`、`INJECT_TEXT`、`STATE_SNAPSHOT`、`OBSERVER_DEGRADED`）；`pageEventSchema`（zod）与推导类型 `PageEvent`；`makeSenderGuard(expectedWebContentsId): (event) => boolean`。本 Plan 只用 `PAGE_EVENT` 通道名做冒烟校验，schema 与 guard 的实际消费者是 Plan 2 的 observer 与注入路径——契约先落地，才能在 M0 之后直接开工。

- [ ] **Step 1: 写失败测试**

`tests/unit/pageEvent.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pageEventSchema } from '../../src/shared/pageEvent';

describe('pageEventSchema', () => {
  it('接受会话列表事件', () => {
    const r = pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: 'a', title: '标题' }] });
    expect(r.success).toBe(true);
  });

  it('接受回答完成事件', () => {
    const r = pageEventSchema.safeParse({ type: 'answer-completed', preview: '结论是' });
    expect(r.success).toBe(true);
  });

  it('接受登录态事件', () => {
    expect(pageEventSchema.safeParse({ type: 'auth-state-changed', signedIn: true }).success).toBe(true);
  });

  it('拒绝未知 type', () => {
    expect(pageEventSchema.safeParse({ type: 'execute-js' }).success).toBe(false);
  });

  it('拒绝超长标题（不可信页面文本必须有上界）', () => {
    const r = pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: 'a', title: 'x'.repeat(201) }] });
    expect(r.success).toBe(false);
  });

  it('拒绝超长会话列表', () => {
    const sessions = Array.from({ length: 501 }, (_, i) => ({ id: String(i), title: 't' }));
    expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions }).success).toBe(false);
  });

  it('拒绝超长 id 以阻断路径注入', () => {
    expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: '../../x'.repeat(20), title: 't' }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test` → Expected: FAIL，`Cannot find module '../../src/shared/pageEvent'`。

- [ ] **Step 3: 写 `src/shared/pageEvent.ts`**

```ts
import { z } from 'zod';

export const sessionListItemSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200),
});

export const pageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session-list-changed'), sessions: z.array(sessionListItemSchema).max(500) }),
  z.object({ type: z.literal('answer-completed'), title: z.string().max(200).optional(), preview: z.string().max(300).optional() }),
  z.object({ type: z.literal('auth-state-changed'), signedIn: z.boolean() }),
]);

export type PageEvent = z.infer<typeof pageEventSchema>;
```

`id` 上界 64 是因为它后续会作为归档记录的键的一部分，必须与路径注入隔离。

- [ ] **Step 4: 写 `src/shared/ipc.ts`**

```ts
export const IPC = {
  PAGE_EVENT: 'shell:page-event',
  OBSERVER_DEGRADED: 'shell:observer-degraded',
  INJECT_TEXT: 'shell:inject-text',
  STATE_SNAPSHOT: 'shell:state-snapshot',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
```

- [ ] **Step 5: 在 `src/shared/ipc.ts` 追加发送方校验**

主进程只接受远端窗口发来的上报，其它 webContents 一律拒绝：

```ts
import type { IpcMainEvent } from 'electron';

export function makeSenderGuard(expectedWebContentsId: number) {
  return (event: IpcMainEvent): boolean => event.sender.id === expectedWebContentsId;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test` → Expected: 7 passed。

- [ ] **Step 7: 提交**

```bash
git add src/shared tests/unit/pageEvent.test.ts
git commit -m "feat: 跨进程 IPC 契约与负载校验

页面文本按不可信输入处理，全部事件带长度与条数上界；
发送方校验按 webContents id 绑定，防止别的窗口冒充上报源。"
```

---

### Task 4: 设置持久化

**Files:**
- Create: `src/main/settings.ts`, `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: 无（用注入的 `SettingsFs` 接口，便于测试且不依赖 Electron）
- Produces: `type Settings = { version: 1; toggleHotkey: string; quickAskHotkey: string; notifyOnAnswer: boolean; closeToTray: boolean; archiveEnabled: boolean }`；`DEFAULT_SETTINGS`；`createSettingsStore(dir: string): { get(): Settings; set(patch: Partial<Settings>): Settings; path(): string }`；`normalizeSettings(raw: unknown): Settings`。Task 6/7/8 依赖 `createSettingsStore`。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, createSettingsStore, normalizeSettings } from '../../src/main/settings';

const dir = () => mkdtempSync(path.join(tmpdir(), 'ds-settings-'));
const fileIn = (d: string) => path.join(d, 'settings.json');

describe('normalizeSettings', () => {
  it('非对象输入回落默认值', () => {
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('丢弃未知键与类型不符的值', () => {
    const r = normalizeSettings({ toggleHotkey: 42, notifyOnAnswer: 'yes', unknown: 1 });
    expect(r.toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
    expect(r.notifyOnAnswer).toBe(DEFAULT_SETTINGS.notifyOnAnswer);
    expect('unknown' in r).toBe(false);
  });

  it('接受合法的快捷键字符串并要求含修饰键', () => {
    expect(normalizeSettings({ toggleHotkey: 'CommandOrControl+Alt+D' }).toggleHotkey).toBe('CommandOrControl+Alt+D');
    expect(normalizeSettings({ toggleHotkey: 'D' }).toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
  });
});

describe('createSettingsStore', () => {
  let d = '';
  beforeEach(() => { d = dir(); });

  it('缺文件时创建并返回默认值', () => {
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(readFileSync(s.path(), 'utf8'))).toEqual(DEFAULT_SETTINGS);
  });

  it('set 做浅合并并落盘', () => {
    const s = createSettingsStore(d);
    expect(s.set({ closeToTray: false }).closeToTray).toBe(false);
    expect(JSON.parse(readFileSync(fileIn(d), 'utf8')).closeToTray).toBe(false);
    expect(s.get().toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
  });

  it('损坏 JSON 时备份坏文件并回到默认值', () => {
    writeFileSync(fileIn(d), '{ oops');
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    writeFileSync(fileIn(d), '{ oops');
    s.set({ notifyOnAnswer: false });
    expect(readFileSync(fileIn(d), 'utf8')).not.toBe('{ oops');
  });

  it('版本升级：旧版本文件被迁移到当前结构', () => {
    writeFileSync(fileIn(d), JSON.stringify({ version: 0, toggleHotkey: 'Super+K' }));
    const s = createSettingsStore(d);
    expect(s.get().version).toBe(1);
    expect(s.get().toggleHotkey).toBe('Super+K');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 写 `src/main/settings.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Settings = {
  version: 1;
  toggleHotkey: string;
  quickAskHotkey: string;
  notifyOnAnswer: boolean;
  closeToTray: boolean;
  archiveEnabled: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  toggleHotkey: 'CommandOrControl+Alt+D',
  quickAskHotkey: 'CommandOrControl+Alt+Q',
  notifyOnAnswer: true,
  closeToTray: true,
  archiveEnabled: true,
};

const HOTKEY_RE = /^(CommandOrControl|CmdOrCtrl|Alt|Super|Control|Shift)(\+(CommandOrControl|CmdOrCtrl|Alt|Super|Control|Shift))*\+[\w+]$/;

export function normalizeSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.toggleHotkey === 'string' && HOTKEY_RE.test(r.toggleHotkey)) out.toggleHotkey = r.toggleHotkey;
  if (typeof r.quickAskHotkey === 'string' && HOTKEY_RE.test(r.quickAskHotkey)) out.quickAskHotkey = r.quickAskHotkey;
  for (const k of ['notifyOnAnswer', 'closeToTray', 'archiveEnabled'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k];
  }
  return out;
}

export function createSettingsStore(dir: string) {
  const file = path.join(dir, 'settings.json');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let current = DEFAULT_SETTINGS;
  if (existsSync(file)) {
    try {
      current = normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      renameSync(file, file + '.corrupt');
    }
  } else {
    writeFileSync(file, JSON.stringify(current, null, 2));
  }

  const persist = () => {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(current, null, 2));
    renameSync(tmp, file);
  };

  return {
    get: () => current,
    set(patch: Partial<Settings>): Settings {
      current = normalizeSettings({ ...current, ...patch, version: 1 });
      persist();
      return current;
    },
    path: () => file,
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test` → Expected: 全部 passed（Task 3 的 7 个 + 本任务 7 个）。若 `版本升级` 用例失败，检查 `normalizeSettings` 是否用 `toggleHotkey` 的合法值覆盖了旧文件里的 `Super+K`——`Super+K` 匹配 `HOTKEY_RE`，应保留。

- [ ] **Step 5: 提交**

```bash
git add src/main/settings.ts tests/unit/settings.test.ts
git commit -m "feat: 设置持久化与坏文件自愈

用户可改键但必须含修饰键，避免抢走系统级单键快捷键；
坏配置改名保留而非静默覆盖，用户仍能找回自己写过的值。"
```

---

### Task 5: 窗口状态记忆

**Files:**
- Create: `src/main/windowState.ts`, `tests/unit/windowState.test.ts`

**Interfaces:**
- Consumes: `SettingsStore`（同目录存放 `window.json`，由 Task 6 传入 `userData` 目录字符串）
- Produces: `type Bounds = { x: number; y: number; width: number; height: number; maximized: boolean }`；`sanitizeBounds(raw: unknown, displays: Array<{ workArea: {x:number;y:number;width:number;height:number} }>): Bounds | null`；`createWindowStateStore(dir: string): { load(): Bounds | null; save(b: Bounds): void }`。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWindowStateStore, sanitizeBounds } from '../../src/main/windowState';

const one = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
const two = [...one, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];

describe('sanitizeBounds', () => {
  it('接受完全落在屏幕内的窗口', () => {
    expect(sanitizeBounds({ x: 100, y: 100, width: 800, height: 600, maximized: false }, one))
      .toEqual({ x: 100, y: 100, width: 800, height: 600, maximized: false });
  });

  it('宽度或高度低于最小值时判为无效', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 200, height: 600, maximized: false }, one)).toBeNull();
  });

  it('位置为负或非数字时判为无效', () => {
    expect(sanitizeBounds({ x: '0', y: 0, width: 800, height: 600, maximized: false }, one)).toBeNull();
    expect(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600, maximized: false }, one)).toBeNull();
  });

  it('跨到已断开外接屏的坐标被拒绝，避免窗口开到看不见的地方', () => {
    expect(sanitizeBounds({ x: 4000, y: 0, width: 800, height: 600, maximized: false }, one)).toBeNull();
    expect(sanitizeBounds({ x: 4000, y: 0, width: 800, height: 600, maximized: false }, two)).not.toBeNull();
  });

  it('只要标题栏区域落在某屏工作区内即可通过', () => {
    const b = sanitizeBounds({ x: 1880, y: 0, width: 800, height: 600, maximized: false }, two);
    expect(b).not.toBeNull();
  });
});

describe('createWindowStateStore', () => {
  it('无文件时返回 null，save 后原样读回', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    const s = createWindowStateStore(d);
    expect(s.load()).toBeNull();
    s.save({ x: 10, y: 20, width: 1000, height: 700, maximized: true });
    expect(s.load()).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: true });
    expect(JSON.parse(readFileSync(path.join(d, 'window.json'), 'utf8'))).toBeTypeOf('object');
  });

  it('文件损坏时返回 null 而不是抛出', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    const s = createWindowStateStore(d);
    s.save({ x: 10, y: 20, width: 1000, height: 700, maximized: false });
    writeFileSync(path.join(d, 'window.json'), 'nope');
    expect(s.load()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 写 `src/main/windowState.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Bounds = { x: number; y: number; width: number; height: number; maximized: boolean };

type DisplayLike = { workArea: { x: number; y: number; width: number; height: number } };

const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;
const TITLEBAR_GRACE = 80;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function sanitizeBounds(raw: unknown, displays: DisplayLike[]): Bounds | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return null;
  if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return null;
  const b: Bounds = { x: r.x, y: r.y, width: r.width, height: r.height, maximized: r.maximized === true };

  const probeRight = b.x + Math.min(TITLEBAR_GRACE, b.width);
  const onScreen = displays.some(d =>
    b.y >= d.workArea.y && b.y <= d.workArea.y + d.workArea.height - 1 &&
    b.x >= d.workArea.x - b.width + TITLEBAR_GRACE && probeRight >= d.workArea.x);
  return onScreen ? b : null;
}

export function createWindowStateStore(dir: string) {
  const file = path.join(dir, 'window.json');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return {
    load(): Bounds | null {
      if (!existsSync(file)) return null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const r = parsed as Record<string, unknown>;
        if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return null;
        if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height, maximized: r.maximized === true };
      } catch {
        renameSync(file, file + '.corrupt');
        return null;
      }
    },
    save(b: Bounds): void {
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(b));
      renameSync(tmp, file);
    },
  };
}
```

`load` 只做类型与下限校验，不做屏幕校验——校验需要 `screen`，交给调用方（Task 6）传入真实显示器。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test` → Expected: 全部 passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/windowState.ts tests/unit/windowState.test.ts
git commit -m "feat: 窗口位置尺寸记忆与离屏校验

拔掉外接显示器后旧坐标会落在屏幕外，窗口"看不见但存在"最劝退；
恢复前用标题栏命中区校验，不合法就用默认尺寸。"
```

---

### Task 6: 主窗口生命周期与关闭即隐藏

**Files:**
- Modify: `src/main/shellWindow.ts`（全文替换，保留 Task 1 的安全配置）
- Create: `tests/e2e/shell-window.spec.ts`, `src/main/paths.ts`

**Interfaces:**
- Consumes: `SettingsStore`（Task 4）、`createWindowStateStore` + `sanitizeBounds`（Task 5）
- Produces: `initShell(userDataDir: string): SettingsStore`（返回 store 供 Task 7/8 复用，全进程只创建一次）；`showOrFocusShell(): void`；`toggleShell(): void`；`quitApp(): void`；`isShellVisible(): boolean`；`onShellEvent(cb: (e: 'shown'|'hidden'|'quit') => void): () => void`。Task 7/8 依赖这些名字。

- [ ] **Step 1: 写 `src/main/paths.ts`**

```ts
import { app } from 'electron';

export function userDataDir(): string {
  return process.env.DS_SHELL_USER_DATA ?? app.getPath('userData');
}
```

- [ ] **Step 2: 写失败的 e2e 测试**

`tests/e2e/shell-window.spec.ts`：

```ts
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

  await win.close().catch(() => undefined);
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
    const w = BrowserWindow.getAllWindows()[0];
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
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  expect(b.width).toBe(1200);
  await app.close();
});

test('窗口状态与设置落盘到 userData', async () => {
  const { app, dir } = await launch();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 200, y: 200, width: 1000, height: 700 }));
  await new Promise(r => setTimeout(r, 1200));
  const files = readdirSync(dir);
  expect(files).toContain('window.json');
  expect(files).toContain('settings.json');
  await app.close();
});
```

Run: `pnpm test:e2e` → Expected: FAIL（关闭即隐藏未实现、`window.json`/`settings.json` 未创建、恢复逻辑不存在）。

- [ ] **Step 3: 重写 `src/main/shellWindow.ts`**

保留 Task 1 的 `REMOTE_URL`、`DEEPSEEK_PARTITION`、`isAllowedUrl`、`createShellWindow` 安全配置，加上生命周期：

```ts
import { app, BrowserWindow, screen, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { browserLikeUA } from './ua';
import { createSettingsStore, type SettingsStore } from './settings';
import { createWindowStateStore, sanitizeBounds, type Bounds } from './windowState';

export const REMOTE_URL = process.env.DS_SHELL_URL ?? 'https://chat.deepseek.com/';
export const DEEPSEEK_PARTITION = 'persist:deepseek';

const ALLOWED_HOSTS = new Set(['chat.deepseek.com', 'deepseek.com', 'www.deepseek.com', 'cdn.deepseek.com', 'ssl.cdn.one', 'accounts.google.com', 'github.com', 'appleid.apple.com']);

let win: BrowserWindow | null = null;
let settings: SettingsStore | null = null;
let windowState: ReturnType<typeof createWindowStateStore> | null = null;
let quitters = false;
const listeners = new Set<(e: 'shown' | 'hidden' | 'quit') => void>();

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && [...ALLOWED_HOSTS].some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function currentBounds(): Bounds | null {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
}

function persistBounds() {
  const b = win && !win.isDestroyed() ? currentBounds() : null;
  if (b && windowState) windowState.save(b);
}

export function initShell(userDataDir: string): SettingsStore {
  settings = createSettingsStore(userDataDir);
  windowState = createWindowStateStore(userDataDir);
  return settings;
}

function restoredBounds(): Electron.Rectangle | null {
  if (!windowState) return null;
  const raw = windowState.load();
  if (!raw) return null;
  const displays = screen.getAllDisplays().map(d => ({ workArea: d.workArea }));
  return sanitizeBounds(raw, displays);
}

export function createShellWindow(): BrowserWindow {
  const preload = path.join(app.getAppPath(), 'out/preload/deepseek.js');
  const saved = restoredBounds();

  win = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: 1200, height: 800 }),
    show: false, title: 'DeepSeek',
    icon: path.join(app.getAppPath(), 'out/resources/icon.png'),
    webPreferences: {
      partition: DEEPSEEK_PARTITION,
      preload: existsSync(preload) ? preload : undefined,
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });

  if (saved?.maximized) win.maximize();

  const ses = session.fromPartition(DEEPSEEK_PARTITION);
  ses.setUserAgent(browserLikeUA(ses.getUserAgent()));

  win.once('ready-to-show', () => win?.show());
  win.webContents.on('will-navigate', (e, url) => { if (!isAllowedUrl(url)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('maximize', persistBounds);
  win.on('unmaximize', persistBounds);
  win.on('show', () => emit('shown'));
  win.on('hide', () => { persistBounds(); emit('hidden'); });

  win.on('close', (e) => {
    if (quitters || !settings?.get().closeToTray) {
      persistBounds();
      return;
    }
    e.preventDefault();
    win?.hide();
  });
  win.on('closed', () => { win = null; });

  void win.loadURL(REMOTE_URL);
  return win;
}

function emit(e: 'shown' | 'hidden' | 'quit') {
  for (const cb of listeners) cb(e);
}

export function onShellEvent(cb: (e: 'shown' | 'hidden' | 'quit') => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getShellWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function isShellVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible();
}

export function showOrFocusShell(): void {
  if (!win || win.isDestroyed()) { createShellWindow(); return; }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

export function toggleShell(): void {
  if (isShellVisible() && win && win.isFocused()) win.hide();
  else showOrFocusShell();
}

export function quitApp(): void {
  quitters = true;
  persistBounds();
  emit('quit');
  app.quit();
}
```

- [ ] **Step 4: 在 `src/main/index.ts` 装配并暴露测试钩子**

```ts
import { app, BrowserWindow } from 'electron';
import { createShellWindow, initShell, quitApp, toggleShell } from './shellWindow';
import { userDataDir } from './paths';

if (process.env.DS_SHELL_USER_DATA) {
  app.setPath('userData', process.env.DS_SHELL_USER_DATA);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggleShell());

  void app.whenReady().then(() => {
    initShell(userDataDir());
    createShellWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createShellWindow();
    });
  });

  app.on('before-quit', () => { quitApp(); });
}
```

`before-quit` 里调 `quitApp()` 会再次 `app.quit()`；`quitters` 标志使第二次成为空转，这是刻意的幂等设计。

- [ ] **Step 5: 跑 e2e 确认通过**

Run: `pnpm test:e2e` → Expected: 4 passed。若"落盘到 userData"用例失败，检查 `initShell` 是否在 `createShellWindow` 之前调用（窗口状态 store 未初始化则不会落盘）。

- [ ] **Step 6: 手动确认关闭即隐藏体验**

Run: `pnpm dev` → 按窗口 X → Expected: 窗口消失但 `pnpm dev` 进程不退出，`userData` 目录出现 `window.json`。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 关闭即隐藏、窗口状态恢复与单实例锁

按 X 不再退出进程而是收进托盘，符合常驻工具的心智；
恢复窗口前用真实显示器列表校验旧坐标，防止外接屏拔掉后窗口丢失；
单实例锁让重复启动变成唤起已有窗口而不是开出第二个登录态。"
```

---

### Task 7: 托盘

**Files:**
- Create: `src/main/tray.ts`, `tests/unit/tray.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `toggleShell`/`showOrFocusShell`/`quitApp`（Task 6）、`SettingsStore.path()`（Task 4）
- Produces: `type TrayState = { unread: number; degraded: boolean }`；`buildTooltip(state: TrayState): string`；`buildMenuActions(): Array<{ id: 'show'|'settings'|'quit'; label: string }>`；`createTray(deps: { onToggle(): void; onShow(): void; onSettings(): void; onQuit(): void }): { set(state: TrayState): void; destroy(): void }`。Task 8 用 `set()` 更新状态。

- [ ] **Step 1: 写失败单测**

```ts
import { describe, expect, it } from 'vitest';
import { buildMenuActions, buildTooltip } from '../../src/main/tray';

describe('buildTooltip', () => {
  it('空闲态', () => {
    expect(buildTooltip({ unread: 0, degraded: false })).toBe('DeepSeek');
  });

  it('有未读时带上条数', () => {
    expect(buildTooltip({ unread: 3, degraded: false })).toBe('DeepSeek · 3 条新回复');
  });

  it('降级态必须可见地告知增强功能失效，而不是静默失灵', () => {
    expect(buildTooltip({ unread: 0, degraded: true })).toBe('DeepSeek · 页面已改版，增强功能暂停');
  });

  it('未读上限截断到 99+', () => {
    expect(buildTooltip({ unread: 140, degraded: false })).toBe('DeepSeek · 99+ 条新回复');
  });
});

describe('buildMenuActions', () => {
  it('三个动作且顺序固定', () => {
    expect(buildMenuActions().map(a => a.id)).toEqual(['show', 'settings', 'quit']);
  });

  it('退出项明确区别于关窗', () => {
    expect(buildMenuActions().find(a => a.id === 'quit')?.label).toContain('退出');
    expect(buildMenuActions().find(a => a.id === 'quit')?.label).toContain('进程');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 写 `src/main/tray.ts`**

```ts
import { Menu, Tray, app, nativeImage, shell } from 'electron';
import path from 'node:path';

export type TrayState = { unread: number; degraded: boolean };

export function buildTooltip(state: TrayState): string {
  if (state.degraded) return 'DeepSeek · 页面已改版，增强功能暂停';
  if (state.unread <= 0) return 'DeepSeek';
  return `DeepSeek · ${Math.min(state.unread, 99)}${state.unread > 99 ? '+' : ''} 条新回复`;
}

export type TrayActionId = 'show' | 'settings' | 'quit';

export function buildMenuActions(): Array<{ id: TrayActionId; label: string }> {
  return [
    { id: 'show', label: '显示 / 隐藏窗口' },
    { id: 'settings', label: '打开设置文件' },
    { id: 'quit', label: '退出（结束进程）' },
  ];
}

export function createTray(deps: { onToggle(): void; onShow(): void; onSettings(): void; onQuit(): void }) {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'out/resources/icon.png'));
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(buildTooltip({ unread: 0, degraded: false }));

  const template = buildMenuActions().map(a => ({
    label: a.label,
    click: () => (a.id === 'show' ? deps.onShow() : a.id === 'settings' ? deps.onSettings() : deps.onQuit()),
  }));
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('click', () => deps.onToggle());

  return {
    set(state: TrayState) { tray.setToolTip(buildTooltip(state)); },
    destroy() { tray.destroy(); },
  };
}

export type TrayHandle = ReturnType<typeof createTray>;
```

`nativeImage.createEmpty()` 兜底：Windows 上图标文件缺失时 tray 仍要能创建，否则用户失去唯一的唤起入口。

- [ ] **Step 4: 跑单测确认通过**

Run: `pnpm test` → Expected: 全部 passed。

- [ ] **Step 5: 在 `src/main/index.ts` 接上托盘**

在 `app.whenReady()` 回调里追加，并让 `initShell` 的返回值成为全进程唯一的 store 句柄：

```ts
import { app, BrowserWindow, shell } from 'electron';
import { createTray } from './tray';
import { initShell, createShellWindow, quitApp, showOrFocusShell, toggleShell } from './shellWindow';
import { userDataDir } from './paths';

let tray: ReturnType<typeof createTray> | null = null;
let settingsStore: ReturnType<typeof initShell> | null = null;

// whenReady 内，替换原来的 initShell/createShellWindow 两行：
settingsStore = initShell(userDataDir());
createShellWindow();
tray = createTray({
  onToggle: toggleShell,
  onShow: showOrFocusShell,
  onSettings: () => void shell.openPath(settingsStore!.path()),
  onQuit: quitApp,
});
app.on('window-all-closed', () => { /* 空实现：托盘常驻，故意不因窗口关闭而退出 */ });
```

`settingsStore.path()` 直接给出 settings.json 的完整路径，所以托盘不必拼文件名，也不会随文件名变化而失效。全进程只创建一次 store，Task 8 复用同一句柄。

- [ ] **Step 6: 加 e2e 用例**

`tests/e2e/tray.spec.ts`：

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('托盘存在且 tooltip 反映状态', async () => {
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: mkdtempSync(path.join(tmpdir(), 'ds-tray-')) },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const info = await app.evaluate(({ Tray }) => {
    const t = Tray.getAllTrays ? Tray.getAllTrays()[0] : undefined;
    return t ? { tooltip: t.getToolTip(), menu: t.getContextMenu()?.items.length ?? 0 } : null;
  }).catch(() => null);

  expect(info, 'Windows 上 Tray.getAllTrays 可能不可用，需人工验收').not.toBeNull();
  expect(info!.tooltip).toBe('DeepSeek');
  expect(info!.menu).toBe(3);
  await app.close();
});
```

Run: `pnpm test:e2e` → Expected: 若 `Tray.getAllTrays` 在该 Electron 版本不存在导致此用例无法成立，删除该 e2e 文件并在 README 的手动验收清单里保留"托盘 tooltip 与三项菜单"条目——**不许把断言改成永真**。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 系统托盘与降级状态提示

关窗后托盘是唯一唤起入口，因此图标缺失也要保证托盘可建；
未读与改版降级都收进 tooltip，避免用弹窗骚扰用户。"
```

---

### Task 8: 全局快捷键

**Files:**
- Create: `src/main/hotkeys.ts`, `tests/unit/hotkeys.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `SettingsStore`（Task 4）、`toggleShell`（Task 6）、`TrayHandle.set`（Task 7）
- Produces: `registerHotkeys(deps: { toggleHotkey: string; quickAskHotkey: string; onToggle(): void; onQuickAsk(): void; onConflict(which: 'toggle'|'quickAsk', key: string): void }): { registered: Record<'toggle'|'quickAsk', string | null>; dispose(): void }`；`parseAccelerator(accel: string): { ok: boolean; reason?: string }`。

- [ ] **Step 1: 写失败单测**

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseAccelerator, registerHotkeys } from '../../src/main/hotkeys';

describe('parseAccelerator', () => {
  it('接受带修饰键的组合', () => {
    expect(parseAccelerator('CommandOrControl+Alt+D').ok).toBe(true);
  });

  it('拒绝无修饰键（会抢走系统单键）', () => {
    expect(parseAccelerator('D')).toEqual({ ok: false, reason: 'needs-modifier' });
  });

  it('拒绝未知修饰键', () => {
    expect(parseAccelerator('Hyperspace+D').ok).toBe(false);
  });
});

describe('registerHotkeys', () => {
  it('某一项注册失败时仍注册另一项，并回报冲突', () => {
    const onConflict = vi.fn();
    const setAccelerator = vi.fn((key: string) => key !== 'CommandOrControl+Alt+Q');
    const h = registerHotkeys({
      toggleHotkey: 'CommandOrControl+Alt+D',
      quickAskHotkey: 'CommandOrControl+Alt+Q',
      onToggle: () => {},
      onQuickAsk: () => {},
      onConflict,
      setAccelerator,
      isTaken: () => false,
    });

    expect(h.registered.toggle).toBe('CommandOrControl+Alt+D');
    expect(h.registered.quickAsk).toBeNull();
    expect(onConflict).toHaveBeenCalledWith('quickAsk', 'CommandOrControl+Alt+Q');
    h.dispose();
  });

  it('键已被本应用占用时不重复注册', () => {
    const onConflict = vi.fn();
    const setAccelerator = vi.fn(() => true);
    const h = registerHotkeys({
      toggleHotkey: 'CommandOrControl+Alt+D',
      quickAskHotkey: 'CommandOrControl+Alt+Q',
      onToggle: () => {}, onQuickAsk: () => {}, onConflict,
      setAccelerator, isTaken: () => true,
    });
    expect(h.registered.toggle).toBeNull();
    expect(setAccelerator).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 写 `src/main/hotkeys.ts`**

```ts
import { globalShortcut } from 'electron';

const MODIFIERS = new Set(['CommandOrControl', 'CmdOrCtrl', 'Alt', 'Super', 'Control', 'Shift', 'Cmd', 'Command', 'Option']);

export function parseAccelerator(accel: string): { ok: boolean; reason?: string } {
  const parts = accel.split('+').filter(Boolean);
  if (parts.length < 2) return { ok: false, reason: 'needs-modifier' };
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1] as string;
  if (!mods.every(m => MODIFIERS.has(m))) return { ok: false, reason: 'unknown-modifier' };
  if (!/^[A-Za-z0-9]$/.test(key)) return { ok: false, reason: 'bad-key' };
  return { ok: true };
}

type Deps = {
  toggleHotkey: string;
  quickAskHotkey: string;
  onToggle(): void;
  onQuickAsk(): void;
  onConflict(which: 'toggle' | 'quickAsk', key: string): void;
  setAccelerator?: (key: string, cb: () => void) => boolean;
  isTaken?: (key: string) => boolean;
};

export function registerHotkeys(deps: Deps) {
  const set = deps.setAccelerator ?? ((k, cb) => globalShortcut.register(k, cb));
  const taken = deps.isTaken ?? (k => globalShortcut.isRegistered(k));
  const registered: Record<'toggle' | 'quickAsk', string | null> = { toggle: null, quickAsk: null };

  const bind = (which: 'toggle' | 'quickAsk', key: string, cb: () => void) => {
    if (!parseAccelerator(key).ok) return deps.onConflict(which, key);
    if (taken(key)) return deps.onConflict(which, key);
    if (!set(key, cb)) return deps.onConflict(which, key);
    registered[which] = key;
  };

  bind('toggle', deps.toggleHotkey, deps.onToggle);
  bind('quickAsk', deps.quickAskHotkey, deps.onQuickAsk);

  return {
    registered,
    dispose() {
      for (const key of [registered.toggle, registered.quickAsk]) {
        if (key) globalShortcut.unregister(key);
      }
    },
  };
}

export type HotkeysHandle = ReturnType<typeof registerHotkeys>;
```

`isTaken` 默认走 `globalShortcut.isRegistered`：系统里已被别的应用占用的键，`register` 有时仍返回 true 但事件不会送达，先查一次比事后困惑更好。`setAccelerator`/`isTaken` 注入点让这段代码能脱离 Electron 单测。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test` → Expected: 全部 passed。

- [ ] **Step 5: 在 `src/main/index.ts` 接入**

`whenReady` 内追加；冲突处理用一条系统通知而不是弹窗，`settingsStore` 复用 Task 7 建立的句柄：

```ts
import { Notification } from 'electron';
import { registerHotkeys } from './hotkeys';

const hotkeys = registerHotkeys({
  toggleHotkey: settingsStore!.get().toggleHotkey,
  quickAskHotkey: settingsStore!.get().quickAskHotkey,
  onToggle: toggleShell,
  onQuickAsk: () => { /* Plan 2 的划词注入接管此处；当前仅唤起窗口 */ showOrFocusShell(); },
  onConflict: (which, key) => {
    new Notification({
      title: '快捷键不可用',
      body: `${which === 'toggle' ? '唤起' : '划词'}快捷键 ${key} 注册失败，请修改 ${settingsStore!.path()} 后重启应用`,
    }).show();
  },
});
app.on('will-quit', () => hotkeys.dispose());
```

- [ ] **Step 6: 手动验收**

Run: `pnpm dev`，然后在别的应用（记事本）里按 `Ctrl+Alt+D`。Expected: DeepSeek 窗口唤起；再按一次隐藏。

临时把 `settings.json` 的 `toggleHotkey` 改成 `"D"`，重启。Expected: 收到"快捷键不可用"通知而不是静默失灵。改回默认值。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 全局唤起快捷键与冲突可见化

跨应用唤起是常驻壳的核心价值，因此键被占用时必须通知而不是静默失败；
无修饰键的组合直接拒绝，避免注册后抢走系统单键输入。"
```

---

### Task 9: 离线与崩溃覆盖层

**Files:**
- Create: `src/main/overlay.ts`, `src/renderer/offline/index.html`, `src/renderer/offline/offline.css`, `src/renderer/offline/offline.js`, `tests/e2e/offline.spec.ts`

**Interfaces:**
- Consumes: `getShellWindow`/`showOrFocusShell`（Task 6）、分区 `persist:shell`
- Produces: `attachLoadGuards(win: BrowserWindow): void`；`showOfflineOverlay(reason: 'load-failed' | 'render-gone'): void`；`hideOfflineOverlay(): void`。本地覆盖层窗口用 `persist:shell`，与远端登录态隔离。

- [ ] **Step 1: 写失败的 e2e**

```ts
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
```

第二条用例的判据：本地窗口不覆写 UA，因此 UA 里仍带 `Electron`——用它证明"覆盖层走的是另一个分区与另一套 webPreferences"，而不是复制远端配置。

Run: `pnpm test:e2e` → Expected: FAIL，覆盖层未实现。

- [ ] **Step 2: 写 `src/renderer/offline/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'" />
  <title>无法连接</title>
  <link rel="stylesheet" href="./offline.css" />
</head>
<body>
  <main>
    <h1>连不上 DeepSeek</h1>
    <p id="reason">正在重试…</p>
    <button id="retry" type="button">重新加载</button>
    <p class="hint">窗口会停在这一层，恢复网络后点重试即可回到对话。</p>
  </main>
  <script src="./offline.js"></script>
</body>
</html>
```

- [ ] **Step 3: 写 `src/renderer/offline/offline.css`**

沿用官方中性浅灰底与单一强调色，无装饰投影。色值来自 Task 2 期间从官方页面记录的中性阶；本文件是外壳自己的视觉，不影响远端页面。

```css
:root {
  --bg: #f7f7f8;
  --fg: #1f2328;
  --muted: #6b7280;
  --accent: #4d6bfe;
  --border: #e3e5e8;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 "Segoe UI", system-ui, sans-serif; }
main { max-width: 420px; margin: 0 auto; padding: 48px 24px; text-align: center; }
h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
#reason { color: var(--muted); margin: 0 0 24px; }
button { font: inherit; color: #fff; background: var(--accent); border: 0; border-radius: 8px; padding: 10px 20px; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.hint { color: var(--muted); font-size: 12px; margin-top: 20px; }
```

- [ ] **Step 4: 写 `src/renderer/offline/offline.js`**

```js
document.getElementById('retry').addEventListener('click', () => {
  window.ipcRenderer?.send?.('overlay:retry');
});
```

覆盖层 preload 只暴露 `overlay:retry` 一条通道，不给本地窗口任何其它能力。

- [ ] **Step 5: 写 `src/preload/overlay.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ipcRenderer', {
  send: (channel: string) => {
    if (channel === 'overlay:retry') ipcRenderer.send(channel);
  },
});
```

- [ ] **Step 6: 写 `src/main/overlay.ts`**

```ts
import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';

const SHELL_PARTITION = 'persist:shell';
let overlay: BrowserWindow | null = null;

export function showOfflineOverlay(reason: 'load-failed' | 'render-gone'): void {
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      width: 420, height: 260,
      title: '无法连接', autoHideMenuBar: true, resizable: false,
      webPreferences: {
        partition: SHELL_PARTITION,
        preload: path.join(app.getAppPath(), 'out/preload/overlay.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    overlay.on('closed', () => { overlay = null; });
    overlay.webContents.on('did-finish-load', () => {
      const text = reason === 'render-gone' ? '窗口进程意外退出，已重新加载。' : '网络不可达或站点无响应。';
      void overlay?.webContents.executeJavaScript(
        `document.getElementById('reason').textContent = ${JSON.stringify(text)}`);
    });
    void overlay.loadFile(path.join(app.getAppPath(), 'out/renderer/offline/index.html'));
  }
  overlay.show();
  overlay.focus();
}

export function hideOfflineOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

export function attachLoadGuards(win: BrowserWindow): void {
  // 窗口可能因 activate 或重载而重建，先摘掉旧监听避免 retry 被处理多次
  ipcMain.removeAllListeners('overlay:retry');
  ipcMain.on('overlay:retry', (e) => {
    if (e.sender.id !== overlay?.webContents.id) return;
    hideOfflineOverlay();
    void win.webContents.reload();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    showOfflineOverlay('load-failed');
    console.warn(`[shell] load failed code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('did-finish-load', () => hideOfflineOverlay());
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[shell] renderer gone ' + details.reason);
    showOfflineOverlay('render-gone');
    void win.webContents.reload();
  });
}
```

`code === -3`（ABORTED）过滤掉用户主动跳转导致的失败，否则每次点外链都会弹一次覆盖层。

- [ ] **Step 7: 在 `scripts/build.mjs` 增加 overlay preload 入口，在 `shellWindow.ts` 挂载守卫**

`build.mjs` 追加：

```js
await build({
  entryPoints: ['src/preload/overlay.ts'],
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  outfile: 'out/preload/overlay.js',
});
```

`shellWindow.ts` 的 `createShellWindow` 里 `win.loadURL(REMOTE_URL)` 之前加：

```ts
import { attachLoadGuards } from './overlay';
attachLoadGuards(win);
```

- [ ] **Step 8: 跑 e2e 与单测确认通过**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e` → Expected: 全绿。

- [ ] **Step 9: 手动验证真实离线**

`pnpm dev` 起来后断网（拔网线或禁用网卡），在页面里点进任意链接触发加载失败。Expected: 覆盖层出现；恢复网络点"重新加载"回到对话，登录态仍在。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat: 离线与渲染崩溃覆盖层

断网时把用户停在 Chrome 错误页等于把壳变成坏掉的浏览器，
改成自有覆盖层并给一条明确的恢复路径；覆盖层走 persist:shell，
与登录态分区隔离，只暴露一条重试通道。"
```

---

### Task 10: portable 产物与 README

**Files:**
- Create: `electron-builder.yml`, `README.md`

**Interfaces:**
- Consumes: `pnpm build` 产物 `out/`
- Produces: `dist/DeepSeek Shell <version>-portable-win-x64.exe`；README 的手动验收清单章节。

- [ ] **Step 1: 写 `electron-builder.yml`**

```yaml
appId: dev.dsshell.app
productName: DeepSeek Shell
directories:
  output: dist
  buildResources: resources
files:
  - out/**
  - package.json
win:
  target:
    - portable
  icon: resources/icon.png
portable:
  artifactName: "${productName} ${version}-portable-win-x64.exe"
```

- [ ] **Step 2: 打包并验证**

Run: `pnpm add -D electron-builder && pnpm exec electron-builder --win portable`

Expected: `dist/` 出现 exe。双击运行，确认登录、唤起、关闭常驻托盘三项基本行为与 `pnpm dev` 一致。portable exe 会把 `userData` 放在解压临时目录，若发现重启后登录态丢失，改用 `"portable": { "requestExecutionLevel": "user" }` 并在 `src/main/paths.ts` 里把 `userData` 指到 `path.join(app.getPath('appData'), 'ds-shell')`——这一步必须实测后按实际结果处理，不许假定默认配置就好。

- [ ] **Step 3: 写 `README.md`**

必须包含这些章节，内容从本仓库现状如实描述：

```markdown
# ds-shell

chat.deepseek.com 的 Electron 桌面壳。登录一次长期保活、托盘常驻、全局快捷键唤起。

## 运行
pnpm install && pnpm dev

## 打包
pnpm exec electron-builder --win portable

## 配置
%APPDATA%/ds-shell/settings.json：toggleHotkey、notifyOnAnswer、closeToTray、archiveEnabled。
改键必须含修饰键；键被占用时应用会通知而不是静默失效。

## 设计边界
本项目只在用户真实操作的页面窗口内读写 DOM，绝不以脚本方式向 DeepSeek 内部接口发请求，
也不做并发自动化。社区反代项目记录的封号风险正是来自这类调用。
归档数据只写本地、无遥测；剪贴板只在按下划词快捷键时读取。

## M0 验证结论
见 spike/m0/REPORT.md。远端页面结构变化时先跑 pnpm test 的选择器契约测试。

## 手动验收清单
- [ ] 登录后重启应用仍在登录态
- [ ] 按 X 收进托盘，Ctrl+Alt+D 可从任意应用唤起，再按隐藏
- [ ] 窗口位置尺寸重启后恢复
- [ ] 断网时出现覆盖层且无 Chrome 错误页，恢复后可回到对话
- [ ] 托盘 tooltip 三项菜单齐全，"退出（结束进程）"确实结束进程
- [ ] settings.json 里改成无修饰键的快捷键后收到冲突通知
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "build: portable 产物与 README

本机自用不需要安装包与更新渠道，一个免安装 exe 足够；
README 把红线和手动验收清单写进仓库，
避免后来者把"只做 UI 增强"的边界误读成可以调用内部接口。"
```

---

## Plan 1 结束后的自检

- [ ] `pnpm typecheck && pnpm test && pnpm test:e2e` 全绿
- [ ] `spike/m0/REPORT.md` 五项结论全部填写，且第 2–5 项的结论已写进 README 的"M0 验证结论"
- [ ] `src/preload/selectors.ts` 无 `TODO` 残留，契约测试跑的是真实 fixture 而不是构造的理想 DOM
- [ ] spec 第 15 节验收标准第 1、2、3、9 条已逐条手动验证
- [ ] 若 M0 第 1 或第 2 项结论为"不通过"，停止：不进入 Plan 2，回到 spec 重新讨论路线

## Plan 2 范围（本计划不实现）

前置条件：Task 2 的 M0 报告落地。内容为 spec 的 M2–M4：observer 与自禁用、页面事件分发、通知节流、划词注入、截图粘贴注入、文本文件注入、归档 store、Markdown 导出、搜索面板与 DOM 跳转、降级可视化。Plan 2 的每个远端相关任务都以 `SELECTORS` 与 fixture 为契约基础；M0 结论为"不通过"的项直接从 Plan 2 中删除。
