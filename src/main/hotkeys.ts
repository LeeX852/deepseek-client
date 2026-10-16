import { createRequire } from 'node:module';
import { HOTKEY_KEY_RE, HOTKEY_MODIFIERS } from './settings';

type GlobalShortcutLike = {
  register(key: string, cb: () => void): boolean;
  isRegistered(key: string): boolean;
  unregister(key: string): void;
};

// electron 包在纯 Node 下的主导出是二进制路径字符串，命名 ESM 绑定拿不到 globalShortcut
// （F5 裁决：默认兜底路径里惰性取，注入 setAccelerator/isTaken 的单测完全绕开 Electron）。
// createRequire 而非顶层 import：本文件同时被 vitest（node 环境）与 Electron 主进程加载，
// 只有后者会走到这里；在错误的进程里调用会立即抛出明确错误，绝不静默返回假成功。
function getGlobalShortcut(): GlobalShortcutLike {
  const mod = createRequire(import.meta.url)('electron') as { globalShortcut?: GlobalShortcutLike };
  if (!mod.globalShortcut) {
    throw new Error('globalShortcut 不可用：hotkeys 默认路径只能在 Electron 主进程内运行');
  }
  return mod.globalShortcut;
}

// 语法唯一真相源 = settings.ts（F4 裁决）：修饰键查 HOTKEY_MODIFIERS 表，
// 键位查导出的 HOTKEY_KEY_RE（单字母数字 | F1–F24 | 具名键）。此处不再字面化第二份语法。
export function parseAccelerator(accel: string): { ok: boolean; reason?: string } {
  const parts = accel.split('+').filter(Boolean);
  if (parts.length < 2) return { ok: false, reason: 'needs-modifier' };
  const mods = parts.slice(0, -1);
  const key = parts.at(-1) as string;
  if (!mods.every(m => (HOTKEY_MODIFIERS as readonly string[]).includes(m))) {
    return { ok: false, reason: 'unknown-modifier' };
  }
  if (!HOTKEY_KEY_RE.test(key)) return { ok: false, reason: 'bad-key' };
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

// 记录每把成功注册的键归谁释放：走注入 fake 的注册不碰 Electron（dispose 在纯 Node 下
// 也必须安全）；走默认路径的才由 globalShortcut.unregister 回收。
type Binding = { key: string; ownedByElectron: boolean };

export function registerHotkeys(deps: Deps) {
  const set = deps.setAccelerator ?? ((k: string, cb: () => void) => getGlobalShortcut().register(k, cb));
  const taken = deps.isTaken ?? ((k: string) => getGlobalShortcut().isRegistered(k));
  const registered: Record<'toggle' | 'quickAsk', string | null> = { toggle: null, quickAsk: null };
  const bindings: Binding[] = [];

  const bind = (which: 'toggle' | 'quickAsk', key: string, cb: () => void) => {
    if (!parseAccelerator(key).ok) return deps.onConflict(which, key);
    if (taken(key)) return deps.onConflict(which, key);
    if (!set(key, cb)) return deps.onConflict(which, key);
    registered[which] = key;
    bindings.push({ key, ownedByElectron: deps.setAccelerator === undefined });
  };

  bind('toggle', deps.toggleHotkey, deps.onToggle);
  bind('quickAsk', deps.quickAskHotkey, deps.onQuickAsk);

  return {
    registered,
    dispose() {
      for (const b of bindings.splice(0)) {
        if (b.ownedByElectron) getGlobalShortcut().unregister(b.key);
      }
    },
  };
}

export type HotkeysHandle = ReturnType<typeof registerHotkeys>;
