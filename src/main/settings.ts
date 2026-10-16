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

// 修饰键表与具名键表：Task 8 的 parseAccelerator 必须复用同一份语法（此处导出对齐）。
export const HOTKEY_MODIFIERS = ['CommandOrControl', 'CmdOrCtrl', 'Alt', 'Super', 'Control', 'Shift'] as const;
export const HOTKEY_NAMED_KEYS = [
  'Enter',
  'Space',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Up',
  'Down',
  'Left',
  'Right',
] as const;

// 语法：修饰键 ( + 修饰键 )* + 键位，且修饰键至少一个（避免抢走系统级单键快捷键）。
// 键位 = 单个字母或数字 | F1..F24 | HOTKEY_NAMED_KEYS 里的具名键。
// 原稿的 \+[\w+] 是个字符类，只匹配“一个字母数字或加号”，
// 于是 CommandOrControl+Shift+Enter / Space / F1 这类合法 Electron accelerator 被误拒。
const HOTKEY_MOD_ALT = HOTKEY_MODIFIERS.join('|');
const HOTKEY_KEY_ALT = [...HOTKEY_NAMED_KEYS, 'F(?:[1-9]|1[0-9]|2[0-4])', '[A-Za-z0-9]'].join('|');
const HOTKEY_RE = new RegExp(`^(?:${HOTKEY_MOD_ALT})(?:\\+(?:${HOTKEY_MOD_ALT}))*\\+(?:${HOTKEY_KEY_ALT})$`);

function quarantine(file: string): void {
  // 后缀必须唯一：固定用 file + '.corrupt' 时第二次损坏会撞上上次留下的文件——
  // Windows 上那个文件只读或被占用时 renameSync 直接抛 EPERM，构造器就在启动时崩掉；
  // 目标可写时则会静默覆盖，把上一次的坏配置弄丢。
  // 隔离只是尽力保留用户数据——任何失败都退化为忽略，绝不上抛。
  const stamp = Date.now();
  for (let attempt = 0; attempt < 8; attempt++) {
    const dest = attempt === 0 ? `${file}.${stamp}.corrupt` : `${file}.${stamp}-${attempt}.corrupt`;
    if (existsSync(dest)) continue;
    try {
      renameSync(file, dest);
      return;
    } catch {
      // 换下一个后缀重试；全部失败则忽略坏文件。
    }
  }
}

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
      quarantine(file);
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
