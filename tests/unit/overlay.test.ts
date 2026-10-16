import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { BrowserWindow } from 'electron';

// Task 9 修复轮的常驻单测（R27 / R29）。写法沿用 tray.test.ts 的 R23 先例：
// 用 vi.mock('electron') 把只在真实主进程里才可观测的分支钉成可复跑的用例。
// shellWindow 也被整体 mock 掉：R27 的修复要在壳窗口已销毁时调用 showOrFocusShell，
// 而那个模块真跑起来需要 screen/session；overlay 与它的循环依赖只在运行期发生。
type Handler = (...args: unknown[]) => void;

type FakeWebContents = {
  id: number;
  on: (event: string, cb: Handler) => void;
  emit: (event: string, ...args: unknown[]) => void;
  executeJavaScript: Mock<(code: string) => Promise<void>>;
  loadFile: Mock<(file: string) => Promise<void>>;
  reload: Mock<() => void>;
  getURL: Mock<() => string>;
};

type FakeWindow = {
  id: number;
  options: { title?: string; webPreferences?: Record<string, unknown> };
  webContents: FakeWebContents;
  isDestroyed: () => boolean;
  destroyWindow: () => void;
  show: Mock<() => void>;
  focus: Mock<() => void>;
  close: Mock<() => void>;
  loadFile: Mock<(file: string) => Promise<void>>;
};

const FAIL_URL = 'http://127.0.0.1:58017/';

const mocks = vi.hoisted(() => ({
  windows: [] as Array<Record<string, unknown>>,
  ipc: new Map<string, Array<(event: { sender: { id: number } }) => void>>(),
  showOrFocus: [] as string[],
  seq: 0,
}));

vi.mock('../../src/main/shellWindow', () => ({
  REMOTE_URL: 'http://127.0.0.1:58017/',
  DEEPSEEK_PARTITION: 'persist:deepseek',
  showOrFocusShell: () => { mocks.showOrFocus.push('showOrFocusShell'); },
}));

vi.mock('electron', () => {
  class FakeWindowShape {
    id: number;
    options: { title?: string; webPreferences?: Record<string, unknown> };
    webContents: FakeWebContents;
    destroyed = false;
    url = 'about:blank';
    winHandlers = new Map<string, Handler[]>();
    show: Mock<() => void>;
    focus: Mock<() => void>;
    close: Mock<() => void>;
    // BrowserWindow.loadFile 在真实 Electron 上是 webContents.loadFile 的委托
    loadFile: Mock<(file: string) => Promise<void>>;

    constructor(options: { title?: string; webPreferences?: Record<string, unknown> } = {}) {
      this.id = ++mocks.seq;
      this.options = options;
      this.webContents = new FakeWebContents(this);
      this.show = vi.fn();
      this.focus = vi.fn();
      this.close = vi.fn(() => this.destroyAndNotify());
      this.loadFile = vi.fn(async () => undefined);
      mocks.windows.push(this as unknown as Record<string, unknown>);
    }

    isDestroyed() { return this.destroyed; }

    on(event: string, cb: Handler) {
      const list = this.winHandlers.get(event) ?? [];
      list.push(cb);
      this.winHandlers.set(event, list);
    }

    emitWin(event: string) {
      for (const cb of this.winHandlers.get(event) ?? []) cb();
    }

    // 真实销毁（closeToTray=false 的 close / render-process-gone 之后的窗口消失）：
    // Electron 一样会发 'closed'，模块级指针必须降级成 null。
    destroyWindow() { this.destroyAndNotify(); }

    private destroyAndNotify() {
      this.destroyed = true;
      this.emitWin('closed');
    }
  }

  class FakeWebContents {
    id: number;
    owner: FakeWindowShape;
    handlers = new Map<string, Handler[]>();
    executeJavaScript: Mock<(code: string) => Promise<void>>;
    loadFile: Mock<(file: string) => Promise<void>>;
    reload: Mock<() => void>;
    getURL: Mock<() => string>;

    constructor(owner: FakeWindowShape) {
      this.id = ++mocks.seq;
      this.owner = owner;
      this.executeJavaScript = vi.fn(async () => undefined);
      this.loadFile = vi.fn(async () => undefined);
      // 真实 Electron 对已销毁窗口的 webContents 调用一律抛这一句。
      // 复刻它，R27 的崩溃路径才能在单测里真实发生而不是被断言"没调用过"。
      this.reload = vi.fn(() => {
        if (this.owner.destroyed) throw new Error('Object has been destroyed');
      });
      this.getURL = vi.fn(() => this.owner.url);
    }

    on(event: string, cb: Handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }

    emit(event: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
  }

  return {
    BrowserWindow: FakeWindowShape,
    app: { getAppPath: () => 'C:\\fake\\app' },
    ipcMain: {
      on: (channel: string, cb: (event: { sender: { id: number } }) => void) => {
        const list = mocks.ipc.get(channel) ?? [];
        list.push(cb);
        mocks.ipc.set(channel, list);
      },
      removeAllListeners: (channel: string) => { mocks.ipc.delete(channel); },
    },
  };
});

function lastWindow(): FakeWindow {
  const w = mocks.windows.at(-1);
  if (!w) throw new Error('没有创建任何窗口');
  return w as unknown as FakeWindow;
}

// 壳窗口：URL 是远端 http://，与覆盖层的 file:// 区分开。
function makeShellWindow(): FakeWindow {
  const w = new BrowserWindow({ title: 'DeepSeek' }) as unknown as FakeWindow;
  (w as unknown as { url: string }).url = FAIL_URL;
  return w;
}

function fireIpc(channel: string, sender: { id: number }) {
  const list = mocks.ipc.get(channel) ?? [];
  expect(list.length).toBeGreaterThan(0);
  for (const cb of list) cb({ sender });
}

async function loadOverlayModule() {
  const mod = await import('../../src/main/overlay');
  // 模块级单例：每个用例都从"没有覆盖层"的状态开始
  mod.hideOfflineOverlay();
  return mod;
}

function fireFailLoad(shell: FakeWindow) {
  shell.webContents.emit('did-fail-load', {}, -105, 'ERR_CONNECTION_REFUSED', FAIL_URL, true);
}

beforeEach(() => {
  mocks.windows.length = 0;
  mocks.ipc.clear();
  mocks.showOrFocus.length = 0;
});

describe('attachLoadGuards 的 overlay:retry 处理器', () => {
  // R27：closeToTray=false 时用户关窗 → 壳被真销毁，覆盖层成为唯一窗口 → 点重试。
  // 缺陷版对已销毁的 win.webContents 调 reload()，未捕获异常在 ipcMain handler 里抛出：
  // 主进程要么非零退出（绕过 will-quit 的托盘回收 = R25/R22 的幽灵图标缺陷复活），
  // 要么带着 0 窗口的躯壳继续跑。两条都是这个用例要挡住的。
  it('壳窗口已销毁时不触碰它的 webContents，改为唤起新壳（R27）', async () => {
    const { attachLoadGuards } = await loadOverlayModule();
    const shell = makeShellWindow();
    attachLoadGuards(shell as unknown as BrowserWindow);
    fireFailLoad(shell);
    const overlay = lastWindow();
    expect(overlay).not.toBe(shell);

    shell.destroyWindow();
    expect(() => fireIpc('overlay:retry', overlay.webContents)).not.toThrow();
    expect(shell.webContents.reload).not.toHaveBeenCalled();
    expect(mocks.showOrFocus).toEqual(['showOrFocusShell']);
  });

  it('壳窗口仍存活时重试照旧走 reload 并关掉覆盖层', async () => {
    const { attachLoadGuards } = await loadOverlayModule();
    const shell = makeShellWindow();
    attachLoadGuards(shell as unknown as BrowserWindow);
    fireFailLoad(shell);
    const overlay = lastWindow();
    fireIpc('overlay:retry', overlay.webContents);
    expect(shell.webContents.reload).toHaveBeenCalledTimes(1);
    expect(overlay.close).toHaveBeenCalledTimes(1);
    expect(mocks.showOrFocus).toEqual([]);
  });

  it('非覆盖层发来的 overlay:retry 被丢弃（sender 归属校验）', async () => {
    const { attachLoadGuards } = await loadOverlayModule();
    const shell = makeShellWindow();
    attachLoadGuards(shell as unknown as BrowserWindow);
    fireIpc('overlay:retry', shell.webContents);
    expect(shell.webContents.reload).not.toHaveBeenCalled();
    expect(mocks.showOrFocus).toEqual([]);
  });

  it('did-fail-load 忽略非主框架与 -3（用户主动跳转不弹层）', async () => {
    const { attachLoadGuards } = await loadOverlayModule();
    const shell = makeShellWindow();
    attachLoadGuards(shell as unknown as BrowserWindow);
    shell.webContents.emit('did-fail-load', {}, -105, 'ERR', 'http://x/sub', false);
    shell.webContents.emit('did-fail-load', {}, -3, 'ABORTED', FAIL_URL, true);
    expect(mocks.windows).toHaveLength(1); // 只有壳自己
  });

  // Deviation B 的钉：紧随主框架失败之后那条 did-finish-load 是 Chromium 错误页自己的
  // commit，覆盖层必须留在原位；再往后的成功 finish 才是真恢复。
  it('错误页 commit 的 did-finish-load 不关掉在位的覆盖层', async () => {
    const { attachLoadGuards } = await loadOverlayModule();
    const shell = makeShellWindow();
    attachLoadGuards(shell as unknown as BrowserWindow);
    fireFailLoad(shell);
    const overlay = lastWindow();
    shell.webContents.emit('did-finish-load');
    expect(overlay.close).not.toHaveBeenCalled();
    shell.webContents.emit('did-finish-load');
    expect(overlay.close).toHaveBeenCalledTimes(1);
  });

  // R29 第一条：吞只用于保护"覆盖层在位时的那次错误页 commit"。覆盖层不在位，吞就
  // 保护不了任何东西，还会把标志带进下一次真正的加载之后。
  // 诚实说明：这一条在修复前后都绿（覆盖层缺席时"吞"与"hide 一个 null"在外部接口上
  // 不可区分），它是行为钉桩，不是 RED。
  it('覆盖层被关掉后到达的 did-finish-load 不把标志留在挂起状态：下一次失败仍能弹层', async () => {
    const { attachLoadGuards } = await loadOverlayModule();
    const shell = makeShellWindow();
    attachLoadGuards(shell as unknown as BrowserWindow);
    fireFailLoad(shell);
    const overlay = lastWindow();
    overlay.destroyWindow();                 // 用户直接关掉覆盖层，'closed' 清空模块指针
    shell.webContents.emit('did-finish-load'); // 错误页 commit：此时没有覆盖层可保护
    const before = mocks.windows.length;
    fireFailLoad(shell);
    expect(mocks.windows).toHaveLength(before + 1);
    expect(lastWindow()).not.toBe(overlay);
  });
});

describe('showOfflineOverlay', () => {
  // R29 第二条：规格降级表给两个 reason 各自不同的文案。缺陷版首个 did-finish-load
  // 设置器闭包捕获创建当时的 reason，load-failed → render-gone 序列会一直显示网络措辞。
  it('覆盖层存活期间以不同 reason 再次调用会刷新文案', async () => {
    const { showOfflineOverlay } = await loadOverlayModule();
    showOfflineOverlay('load-failed');
    const overlay = lastWindow();
    overlay.webContents.emit('did-finish-load');
    expect(overlay.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('网络不可达或站点无响应。');

    overlay.webContents.executeJavaScript.mockClear();
    showOfflineOverlay('render-gone');
    expect(overlay.webContents.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('窗口进程意外退出');
    // 复用同一个覆盖层，不叠加第二个
    expect(mocks.windows).toHaveLength(1);
  });

  it('同 reason 重复调用不重复写文案，只 show+focus', async () => {
    const { showOfflineOverlay } = await loadOverlayModule();
    showOfflineOverlay('load-failed');
    const overlay = lastWindow();
    overlay.webContents.emit('did-finish-load');
    overlay.webContents.executeJavaScript.mockClear();
    showOfflineOverlay('load-failed');
    expect(overlay.webContents.executeJavaScript).not.toHaveBeenCalled();
    // 两次调用都只做唤起，不重建窗口
    expect(overlay.show).toHaveBeenCalledTimes(2);
    expect(overlay.focus).toHaveBeenCalledTimes(2);
    expect(mocks.windows).toHaveLength(1);
  });

  it('覆盖层窗口留在 persist:shell 且只挂 overlay preload', async () => {
    const { showOfflineOverlay } = await loadOverlayModule();
    showOfflineOverlay('load-failed');
    const wp = lastWindow().options.webPreferences ?? {};
    expect(wp.partition).toBe('persist:shell');
    expect(String(wp.preload)).toContain('overlay.js');
    expect(wp.contextIsolation).toBe(true);
    expect(wp.sandbox).toBe(true);
    expect(wp.nodeIntegration).toBe(false);
  });
});
