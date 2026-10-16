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

// F4 裁决 + T3-5 deferred：键位判定必须是导出表，供 Task 8 的 parseAccelerator 复用。
// F1–F24 区间与单字母数字规则此前只活在 HOTKEY_RE 的内联字面量里；若 Task 8 只遍历
// HOTKEY_NAMED_KEYS 就会静默拒绝功能键——settings 放行、注册期误报冲突，两处真相源。
// 导出这一个已编译谓词，全项目就只有这一份键位语法。
export const HOTKEY_KEY_RE = new RegExp(`^(?:${HOTKEY_KEY_ALT})$`);

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
  }
  const persist = () => {
    const tmp = file + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(current, null, 2));
    } catch {
      return;
    }
    // R18.2：Windows 上目标被编辑器/杀软瞬时占用时 renameSync 抛 EPERM——
    // 内存态仍是对的，吞掉这次失败等下一次 set() 重试即可，绝不上抛。
    try {
      renameSync(tmp, file);
    } catch {
      // 瞬时锁：保留 tmp 与旧文件，下次 persist 覆盖重试。
    }
  };

  // R18.1：文件缺席就补写默认值——既覆盖首启，也覆盖"坏文件刚被成功隔离"之后。
  // 否则 store.path() 指向不存在的文件，Task 7 托盘菜单的"打开设置文件"会静默失败。
  // 隔离整体失败时坏文件仍在（existsSync 为真），不覆盖用户字节，内存态用默认值。
  // R21：这条首写必须走与 set() 完全相同的 tmp+rename 原子路径。原来的裸
  // writeFileSync(file, …) 若崩在中途会留下截断的 settings.json，下次启动把
  // "自己刚写的半截文件"连同用户原设置一起隔离丢弃——正是 R18.2 要避免的事故。
  // persist() 自带守卫：目录不可写时保持内存默认值，绝不在构造期把应用拖崩。
  if (!existsSync(file)) persist();

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
