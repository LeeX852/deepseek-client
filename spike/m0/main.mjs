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

// 注意：不能在 ESM 入口用顶层 await app.whenReady()——Electron 要等主模块
// 求值完成才会派发 ready，顶层 await 会死锁（本机实测 ready 永不 resolve）。
// 与 src/main/index.ts 相同，改用 then 链。session.defaultSession
// 也必须等 ready 之后才可用，UA 读取放在 start() 内。
app.whenReady().then(() => start()).catch((err) => {
  console.error('[spike] fatal', err);
  process.exit(1);
});

async function start() {
  const ua = session.defaultSession.getUserAgent()
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*ds-shell\/[\d.]+/g, '')
    .trim();

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
}
