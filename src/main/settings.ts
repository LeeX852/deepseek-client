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
