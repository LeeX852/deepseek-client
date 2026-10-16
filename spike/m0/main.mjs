// M0 前置验证 spike 的主进程入口：单个 BrowserWindow 直接加载线上 deepseek，
// 挂上 probe.cjs 做 DOM 快照与注入自测。一次性代码，不进构建、不进 src。
//
// 运行（项目根为工作目录）：pnpm exec electron spike/m0/main.mjs
//
// 本文件是 ESM（package.json 有 "type": "module"），无法 import TS 源码，
// 故 browserLikeUA 的两条正则以 `src/main/ua.ts` 为准原样内联，保持同步。
import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// browserLikeUA 与 `src/main/ua.ts` 的两条正则保持一致。spike 要能独立运行，
// 不 import TS 源码，故在此内联同一逻辑（项目规则：spike 不得触碰 src）。
function browserLikeUA(defaultUA) {
  return defaultUA
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*ds-shell\/[\d.]+/g, '')
    .trim();
}

// 注意：不能在 ESM 入口用顶层 await app.whenReady()——Electron 要等主模块
// 求值完成才会派发 ready，顶层 await 会死锁（本机实测 ready 永不 resolve）。
// 与 src/main/index.ts 相同，改用 then 链。session.defaultSession
// 也必须等 ready 之后才可用，UA 读取放在 start() 内。
app.whenReady().then(() => start()).catch((err) => {
  console.error('[spike] fatal', err);
  process.exit(1);
});

async function start() {
  const ua = browserLikeUA(session.defaultSession.getUserAgent());

  // 探测产物落盘目录：给 probe.cjs 一个绝对路径，避免从不同 cwd 启动时
  // 把 auto-NNN.* 写散（probe.cjs 里的相对默认值仍保留，便于单独调试）。
  process.env.DS_SPIKE_OUT = process.env.DS_SPIKE_OUT || path.join(here, 'out');
  app.setPath('userData', path.join(process.env.DS_SPIKE_OUT, 'userdata'));

  const win = new BrowserWindow({
    width: 1280, height: 860, title: 'M0 spike',
    webPreferences: {
      preload: path.join(here, 'probe.cjs'),
      partition: 'persist:deepseek',
      contextIsolation: true, sandbox: false, nodeIntegration: false,
    },
  });

  // 风险 1 要在产品壳同款环境下取证：Task 1 的 shellWindow.ts:38-39 既在
  // persist:deepseek 分区 session 上 setUserAgent，又在 loadURL 时覆盖。
  // 此前 spike 只做了 loadURL 覆盖，页面内 navigator.userAgent 虽干净
  // （loadURL 覆盖），但后续 XHR/worker 请求的 User-Agent 头会回落到分区
  // session 的默认值，仍带 Electron/44.8.0。这里补上分区 session 这一行对齐。
  const ses = session.fromPartition('persist:deepseek');
  ses.setUserAgent(browserLikeUA(ses.getUserAgent()));

  // Electron 44 起 console-message 的 (level, message) 位置参数已标 deprecated，
  // 新形态是第二个参数 messageDetails 对象；两种形态都兼容，
  // 确保 preload 里的 [probe] 日志能上终端。
  const pickConsoleMessage = (a, b) => {
    if (typeof a === 'string') return a;                                  // (event, message)
    if (typeof a === 'number' && typeof b === 'string') return b;         // (event, level, message) 旧形态
    if (a && typeof a === 'object' && typeof a.message === 'string') return a.message; // 新形态 messageDetails
    return null;
  };
  win.webContents.on('console-message', (_e, arg1, arg2) => {
    const message = pickConsoleMessage(arg1, arg2);
    if (message) console.log(message);
  });
  win.webContents.on('did-navigate', (_e, url) => console.log('[spike] navigate -> ' + url));
  // 风险 5 的判据要求覆盖 SPA 路由跳转（pushState 不触发 did-navigate），
  // 所以补记 in-page 导航；probe 每 5 秒的 url 快照是第二道兜底证据。
  win.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) console.log('[spike] in-page -> ' + url);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[spike] did-fail-load code=${code} desc=${desc} url=${url}`));
  win.webContents.on('page-title-updated', (_e, t) => console.log('[spike] title -> ' + t));

  // 显式触发破坏性注入/paste 自测的通道：Ctrl+Shift+U。
  // 选它是因为 Electron 默认没把它绑到任何功能（浏览器里 view-source 是
  // Firefox 的习惯），且在主进程拦截可确保页面自己的快捷键不会吞掉它。
  // 自动循环永远不发 spike:insert——只有操作者按下这个键才会跑自测。
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && input.shift && input.key.toLowerCase() === 'u' && !input.alt && !input.meta) {
      _e.preventDefault();
      console.log('[spike] keystroke Ctrl+Shift+U -> spike:insert (destructive self-test)');
      win.webContents.send('spike:insert');
    }
  });

  // R10：首帧加载被拒（重定向/中断/429）不该让整个 spike 退出——probe 仍
  // 能在后续导航恢复时继续产出证据。给 loadURL 独立的 try/catch，保住窗口。
  try {
    await win.loadURL('https://chat.deepseek.com/', { userAgent: ua });
  } catch (err) {
    console.log('[spike] load rejected, window kept alive: ' + (err && err.message ? err.message : err));
  }

  // 30 秒起每 30 秒落一份 manual.json 快照，最多 40 次（约 20 分钟）。
  // 节拍只做快照，绝不再触发 spike:insert。
  setTimeout(() => {
    let beats = 0;
    const tick = () => {
      if (++beats > 40 || win.isDestroyed()) { clearInterval(timer); return; }
      win.webContents.send('spike:snapshot', 'manual');
    };
    const timer = setInterval(tick, 30_000);
    tick();
  }, 30_000);

  // R10：窗口关闭即退出。否则关窗后进程不结束，30 秒节拍会对着已销毁的
  // webContents 继续 send 抛异常。
  win.on('closed', () => app.quit());
}

app.on('window-all-closed', () => app.quit());
