import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function launch(seed?: Record<string, unknown>, extraEnv?: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-shell-e2e-'));
  for (const [name, value] of Object.entries(seed ?? {})) {
    writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'https://chat.deepseek.com/', ...extraEnv },
  });
  return { app, dir };
}

// 轮询直到 predicate 成立或超时；返回最后一次观测值，
// 这样失败信息里带着"实际看到什么"，而不是只有一句超时。
async function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  let last = await read();
  const deadline = Date.now() + ms;
  while (!done(last) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    last = await read();
  }
  return last;
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

// 生命周期事件必须绑定在"创建它的那个窗口"上，而不是模块级的当前窗口指针：
// 指针一旦被后来者覆盖，前一个窗口的 ready-to-show 会去 show 别人、
// closed 会把后来者降级成"没有窗口"、close 会把后来者藏起来。
// getAllWindows() 的返回顺序不可依赖，用例一律按 win.id 定位。
// 钩子由 index.ts 在 DS_SHELL_TEST_HOOKS 置位时安装：正常启动路径无法在同一 tick 内
// 构造第二个壳窗口，没有钩子就无法回归这一缺陷。
type WinState = { id: number; visible: boolean };
type ShellHooks = { createShellWindow: () => void; showOrFocusShell: () => void };
// R20 回归需要：钩子多提供 quitApp 与 recordShellEvents（把每条壳事件按行追加到文件），
// 这样进程退出后仍能从磁盘数出 'quit' 的真实次数。
type QuitHooks = ShellHooks & { quitApp: () => void; recordShellEvents: (file: string) => void };

function windowStates(app: ElectronApplication): Promise<WinState[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(w => ({ id: w.id, visible: w.isVisible() })));
}

function windowIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.id));
}

function visibleOf(states: WinState[], id: number): boolean {
  return states.find(s => s.id === id)?.visible ?? false;
}

// 读 userData 里落盘的窗口位置；文件还没创建或正被 rename 替换时按"还没写"处理。
function readBoundsFile(file: string): { x: number; y: number } | null {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as { x?: unknown; y?: unknown };
    return typeof o.x === 'number' && typeof o.y === 'number' ? { x: o.x, y: o.y } : null;
  } catch {
    return null;
  }
}

// 同一 tick 内连续构造两个壳窗口：远端首帧的 ready-to-show 不可能插在两次构造之间，
// 因此"前一个窗口的 handler 读到后一个窗口"必然发生（红得确定，不靠时序运气）。
async function createTwoShellWindows(app: ElectronApplication): Promise<{ older: number; newer: number }> {
  const created = await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __dsShellTestHooks?: ShellHooks };
    if (!g.__dsShellTestHooks) throw new Error('测试钩子未安装：主进程启动时缺少 DS_SHELL_TEST_HOOKS');
    const before = new Set(BrowserWindow.getAllWindows().map(w => w.id));
    g.__dsShellTestHooks.createShellWindow();
    g.__dsShellTestHooks.createShellWindow();
    return BrowserWindow.getAllWindows().map(w => w.id).filter(id => !before.has(id));
  });
  expect(created).toHaveLength(2);
  const sorted = [...created].sort((a, b) => a - b);
  return { older: sorted[0]!, newer: sorted[1]! };
}

async function launchWithTwoExtraWindows(): Promise<{ app: ElectronApplication; older: number; newer: number; dir: string }> {
  const { app, dir } = await launch(undefined, { DS_SHELL_TEST_HOOKS: '1' });
  await app.firstWindow();
  const { older, newer } = await createTwoShellWindows(app);
  return { app, older, newer, dir };
}

test('ready-to-show 只显示自己：同一 tick 构造的第二个壳窗口不接管第一个的显示', async () => {
  const { app, older, newer } = await launchWithTwoExtraWindows();

  // 每个窗口的 ready-to-show 都得显示它自己：两个新窗口最终都必须可见。
  const states = await pollUntil(
    () => windowStates(app),
    v => visibleOf(v, older) && visibleOf(v, newer),
  );
  expect(visibleOf(states, older)).toBe(true);
  expect(visibleOf(states, newer)).toBe(true);
  await app.close();
});

test('closed 只降级指向自己的指针：销毁非当前窗口后仍能复用当前窗口', async () => {
  // closeToTray=false 让 close 走真销毁路径，才能触发 closed。
  const { app } = await launch({ 'settings.json': { closeToTray: false } }, { DS_SHELL_TEST_HOOKS: '1' });
  await app.firstWindow();
  // 当前指针指向 newer；older 是被后来者覆盖掉的那个窗口。
  const { older, newer } = await createTwoShellWindows(app);

  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows().find(w => w.id === id)?.close();
  }, older);
  const afterClose = await pollUntil(() => windowIds(app), ids => !ids.includes(older));
  expect(afterClose).not.toContain(older);
  expect(afterClose).toContain(newer);

  // 唤起必须复用还活着的 newer，窗口表不能因为指针被误清而多出一个。
  await app.evaluate(() => {
    const g = globalThis as unknown as { __dsShellTestHooks?: ShellHooks };
    g.__dsShellTestHooks?.showOrFocusShell();
  });
  await new Promise(r => setTimeout(r, 500));
  const afterFocus = await windowIds(app);
  expect(afterFocus).toContain(newer);
  expect(afterFocus).toHaveLength(2);
  await app.close();
});

test('close 只隐藏自己：关闭非当前窗口不该把当前窗口藏起来，且落盘的是它自己的几何', async () => {
  // closeToTray 默认为 true：close 必须被拦截并隐藏"被关的那个"窗口。
  const { app, older, newer, dir } = await launchWithTwoExtraWindows();
  const file = path.join(dir, 'window.json');

  // 先显式 show()，把本用例与 ready-to-show 的缺陷隔离开。
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });
  const shown = await pollUntil(() => windowStates(app), v => visibleOf(v, older) && visibleOf(v, newer));
  expect(visibleOf(shown, older)).toBe(true);
  expect(visibleOf(shown, newer)).toBe(true);

  // Important 1 回归（落盘写错窗口）：给 older/newer 各设一个可区分的位置，
  // 先等各自的防抖落盘收尾——关 older 之前，文件里已经是"某个窗口自己的几何"，
  // 之后唯一还能改写文件的就只剩 older 的 hide。
  await app.evaluate(({ BrowserWindow }, ids) => {
    BrowserWindow.getAllWindows().find(w => w.id === ids.older)?.setBounds({ x: 210, y: 230, width: 900, height: 640 });
    BrowserWindow.getAllWindows().find(w => w.id === ids.newer)?.setBounds({ x: 610, y: 630, width: 900, height: 640 });
  }, { older, newer });
  const sameXY = (a: { x: number; y: number } | null, b: { x: number; y: number }) =>
    a !== null && a.x === b.x && a.y === b.y;
  const geom = await pollUntil(
    () => app.evaluate(({ BrowserWindow }, ids) => {
      const xy = (id: number) => {
        const b = BrowserWindow.getAllWindows().find(w => w.id === id)!.getBounds();
        return { x: b.x, y: b.y };
      };
      return { older: xy(ids.older), newer: xy(ids.newer) };
    }, { older, newer }),
    // 以"回读到的真实几何"为准而非 setBounds 的入参，DPI 偏移不敏感；
    // 等文件落到两者之一的坐标（防抖尾写已完成、无挂起定时器）再继续。
    g => g.older.x !== g.newer.x && (sameXY(readBoundsFile(file), g.older) || sameXY(readBoundsFile(file), g.newer)),
  );

  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows().find(w => w.id === id)?.close();
  }, older);

  // older 被隐藏而不是销毁；newer 作为当前窗口必须不受牵连。
  const after = await pollUntil(() => windowStates(app), v => !visibleOf(v, older) && visibleOf(v, newer), 8_000);
  expect(visibleOf(after, older)).toBe(false);
  expect(visibleOf(after, newer)).toBe(true);
  expect(after.some(s => s.id === older)).toBe(true);

  // older 的 hide 必须把它自己的几何写进 window.json。
  // 缺陷版（persistBounds 读模块级 win）在这里写的是 newer 的坐标，
  // 轮询到超时后 landed 仍是 newer 的 x/y → 本断言变红。
  const landed = await pollUntil(
    () => Promise.resolve(readBoundsFile(file)),
    v => sameXY(v, geom.older),
    8_000,
  );
  expect(landed).toEqual(geom.older);
  await app.close();
});

test('拖拽窗口的连续 resize/move 合并成一次落盘', async () => {
  // R18.3：逐事件同步写盘在 Windows 上等于"每拖一个像素一次磁盘 IO"。
  // 尾沿防抖的可观测特征：突发刚过时磁盘仍是旧值，到点后才出现新值。
  // 把 resize/move 直接挂到 persistBounds（逐事件写）的用例就会在这里变红。
  const { app, dir } = await launch();
  await app.firstWindow();
  const file = path.join(dir, 'window.json');

  // Important 2：burst 前文件必须已存在的这一前提，现在由产品保证——
  // createShellWindow 创建窗口时即同步落一次自己的几何（不再依赖系统首显自发 move）。
  const before = await pollUntil(() => Promise.resolve(readBoundsFile(file)), v => v !== null);
  expect(before).not.toBeNull();

  // 同一个同步 tick 内连改 20 次位置，等价于拖拽时一帧帧的 resize/move 事件。
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    for (let i = 0; i < 20; i++) w.setBounds({ x: 300 + i, y: 320 + i, width: 1000, height: 700 });
  });

  await new Promise(r => setTimeout(r, 100));
  const early = readBoundsFile(file);
  expect(early?.x).toBe(before?.x);
  expect(early?.y).toBe(before?.y);

  const settled = await pollUntil(() => Promise.resolve(readBoundsFile(file)), v => v !== null && v.x !== before?.x);
  expect(settled).not.toBeNull();
  expect(settled!.x).toBeGreaterThanOrEqual(300);
  expect(settled!.y).toBeGreaterThanOrEqual(320);
  await app.close();
});

// R19 裁决：规格要求"重复启动唤起已有窗口"，second-instance 处理器必须是
// showOrFocusShell 而不是 toggleShell——toggle 在"可见且聚焦"时反而把窗口藏了。
test('second-instance 唤起而非切换：重复启动后，可见且聚焦的窗口仍然可见', async () => {
  const { app, dir } = await launch(undefined, { DS_SHELL_TEST_HOOKS: '1' });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // 构造 toggleShell 会"藏窗口"的那个前提状态：可见 + 聚焦。
  const ready = await pollUntil(
    () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.focus();
      return { visible: w.isVisible(), focused: w.isFocused() };
    }),
    s => s.visible && s.focused,
    15_000,
  );
  expect(ready).toEqual({ visible: true, focused: true });

  // 真实第二次启动：另一个 electron 进程、同一个 userData——单实例锁失败方很快自行退出，
  // 同时把 'second-instance' 事件送进第一实例。不模拟 emit，走生产同一条事件路径。
  const exeName = readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  const second = spawn(path.join(repoRoot, 'node_modules', 'electron', 'dist', exeName), ['.'], {
    cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'https://chat.deepseek.com/' },
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error('第二个实例 20s 未退出：单实例锁可能没有生效'));
    }, 20_000);
    second.once('exit', () => { clearTimeout(timer); resolve(); });
    second.once('error', (err) => { clearTimeout(timer); reject(err); });
  });

  // 给第一实例处理 second-instance 的时间。缺陷版（toggleShell：可见+聚焦→hide）在这里变红。
  await new Promise(r => setTimeout(r, 1_500));
  const state = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    return { count: BrowserWindow.getAllWindows().length, visible: w.isVisible() };
  });
  expect(state.count).toBe(1);      // 没有开出第二个登录态
  expect(state.visible).toBe(true); // 也没有顺手把已可见的窗口藏起来
  await app.close();
});

// R20 裁决：quit 必须恰好广播一次。index.ts 的 before-quit → quitApp() 会重入
// app.quit()，缺陷实现每轮退出广播两次 quit，把幂等负担转嫁给 Task 7/8 的监听者。
test('quit 事件恰好一次：退出流程重入不再二次广播', async () => {
  const { app, dir } = await launch(undefined, { DS_SHELL_TEST_HOOKS: '1' });
  await app.firstWindow();
  const file = path.join(dir, 'shell-events.log');

  // 注意：ElectronApplication.evaluate 的 pageFunction 第一个形参是 electron 模块，
  // 用户参数是第二个（与本文件其它用例 ({BrowserWindow}, id) 一致）。
  await app.evaluate((_electron, logFile: string) => {
    const g = globalThis as unknown as { __dsShellTestHooks?: QuitHooks };
    if (!g.__dsShellTestHooks) throw new Error('测试钩子未安装：主进程启动时缺少 DS_SHELL_TEST_HOOKS');
    g.__dsShellTestHooks.recordShellEvents(logFile);
  }, file);
  // app.close() 后 Playwright 会清空内部引用，先取住 ChildProcess 句柄再退出。
  const proc = app.process();
  // quit 流程可能先于 evaluate 回包掐断调试连接，容错处理；断言全部基于磁盘日志。
  await app.evaluate(() => {
    const g = globalThis as unknown as { __dsShellTestHooks?: QuitHooks };
    g.__dsShellTestHooks!.quitApp();
  }).catch(() => undefined);

  // 等进程真正退出后再读日志文件——记录器是同步 appendFileSync，退出前已全部落盘。
  const exitCode = await pollUntil(() => Promise.resolve(proc.exitCode), c => c !== null, 30_000);
  expect(exitCode).toBe(0);
  const quitLines = readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('quit'));
  expect(quitLines).toHaveLength(1); // 缺陷版这里是 2
  await app.close().catch(() => undefined);
});
