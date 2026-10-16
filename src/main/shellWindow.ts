import { app, BrowserWindow, screen, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { browserLikeUA } from './ua';
import { createSettingsStore, type SettingsStore } from './settings';
import { createWindowStateStore, sanitizeBounds, type Bounds } from './windowState';

export const REMOTE_URL = process.env.DS_SHELL_URL ?? 'https://chat.deepseek.com/';
export const DEEPSEEK_PARTITION = 'persist:deepseek';

const ALLOWED_HOSTS = new Set(['chat.deepseek.com', 'deepseek.com', 'www.deepseek.com', 'cdn.deepseek.com', 'ssl.cdn.one', 'accounts.google.com', 'github.com', 'appleid.apple.com']);

// resize/move 在拖拽期间每帧都触发，同步逐像素写盘不可接受；合并成一次落盘。
// 400ms 远低于 e2e 的 1200ms 等待，也不超过 900ms 的约束，且 hide/close/quit
// 走立即路径，不会因防抖丢状态。
const BOUNDS_SAVE_DEBOUNCE_MS = 400;
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;

let win: BrowserWindow | null = null;
let settings: SettingsStore | null = null;
let windowState: ReturnType<typeof createWindowStateStore> | null = null;
let quitters = false;
let saveTimer: NodeJS.Timeout | null = null;
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
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const b = currentBounds();
  if (b && windowState) windowState.save(b);
}

function schedulePersistBounds() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistBounds();
  }, BOUNDS_SAVE_DEBOUNCE_MS);
}

export function initShell(userDataDir: string): SettingsStore {
  settings = createSettingsStore(userDataDir);
  windowState = createWindowStateStore(userDataDir);
  return settings;
}

function restoredBounds(): Bounds | null {
  if (!windowState) return null;
  const raw = windowState.load();
  if (!raw) return null;
  const displays = screen.getAllDisplays().map(d => ({ workArea: d.workArea }));
  return sanitizeBounds(raw, displays);
}

// Windows 非整数 DPI（本机 150%）下，BrowserWindow 构造与 setBounds 的
// DIP→物理像素换算含 +1px 框边修正，getBounds 回读会比目标大 1-2 DIP
// （1200 → 1201/800 → 802）。该舍入映射是确定性的：按残差回补目标再设一次
// 即可精确落到请求的逻辑尺寸（1199 → 1200）。整数缩放下第一轮即命中，零成本。
// 循环上限 3 次，收敛失败时保留误差最小的一次，绝不无限抖动。
function applyExactBounds(target: { x: number; y: number; width: number; height: number }): void {
  if (!win || win.isDestroyed()) return;
  const errOf = (b: { width: number; height: number }) => Math.abs(b.width - target.width) + Math.abs(b.height - target.height);
  let best = win.getBounds();
  let bestErr = errOf(best);
  let next = target;
  for (let i = 0; i < 3 && bestErr > 0; i++) {
    win.setBounds(next);
    const got = win.getBounds();
    const err = errOf(got);
    if (err < bestErr) {
      best = got;
      bestErr = err;
    }
    if (err === 0) return;
    next = {
      x: target.x,
      y: target.y,
      width: target.width - (got.width - target.width),
      height: target.height - (got.height - target.height),
    };
  }
}

export function createShellWindow(): BrowserWindow {
  const preload = path.join(app.getAppPath(), 'out/preload/deepseek.js');
  const saved = restoredBounds();

  // shellWin 是"本次创建的那个窗口"，win 是"当前壳窗口"。
  // 只影响这一个窗口的 handler 必须绑定 shellWin：闭包读模块级 win 的话，
  // 一旦后来者覆盖了指针，前一个窗口会去 show/hide 别人、并把别人降级成"没有窗口"
  // （Task 1 遗留缺陷，三条 e2e 回归用例各盯一种表现）。
  // 名字不叫 shell：那会遮蔽 electron 导入的 shell 模块（openExternal 要用它）。
  const shellWin = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }),
    show: false, title: 'DeepSeek',
    icon: path.join(app.getAppPath(), 'out/resources/icon.png'),
    webPreferences: {
      partition: DEEPSEEK_PARTITION,
      // Electron 的 WebPreferences.preload 类型是 `preload?: string`（不含 undefined），
      // 在 exactOptionalPropertyTypes 下只能整体省略这个键。
      ...(existsSync(preload) ? { preload } : {}),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  win = shellWin;

  // 显示前归一化：恢复尺寸以 window.json 落盘值为准；默认尺寸以常量为准，
  // 位置保留构造函数的居中结果，只把 DPI 舍入多出的 1-2 DIP 裁掉。
  {
    const b = shellWin.getBounds();
    applyExactBounds({
      x: saved ? saved.x : b.x,
      y: saved ? saved.y : b.y,
      width: saved ? saved.width : DEFAULT_WIDTH,
      height: saved ? saved.height : DEFAULT_HEIGHT,
    });
  }

  if (saved?.maximized) shellWin.maximize();

  const ses = session.fromPartition(DEEPSEEK_PARTITION);
  ses.setUserAgent(browserLikeUA(ses.getUserAgent()));

  shellWin.once('ready-to-show', () => shellWin.show());
  shellWin.webContents.on('will-navigate', (e, url) => { if (!isAllowedUrl(url)) e.preventDefault(); });
  shellWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  shellWin.on('resize', schedulePersistBounds);
  shellWin.on('move', schedulePersistBounds);
  shellWin.on('maximize', persistBounds);
  shellWin.on('unmaximize', persistBounds);
  shellWin.on('show', () => emit('shown'));
  shellWin.on('hide', () => { persistBounds(); emit('hidden'); });

  shellWin.on('close', (e) => {
    if (quitters || !settings?.get().closeToTray) {
      persistBounds();
      return;
    }
    e.preventDefault();
    shellWin.hide();
  });
  // 只有当前指针仍指向自己时才降级：否则被销毁的那个窗口会把活着的窗口抹成"没有窗口"。
  shellWin.on('closed', () => { if (win === shellWin) win = null; });

  void shellWin.loadURL(REMOTE_URL, { userAgent: browserLikeUA(session.defaultSession.getUserAgent()) });
  return shellWin;
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
