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

  // R24：parser 与 store 必须同一门语法。此前的 split('+').filter(Boolean) 会吞掉
  // 空片段，让 "CommandOrControl+Alt++D" 在 parseAccelerator 放行、却被 store 的
  // HOTKEY_RE 拒绝——两处真相源。去掉宽容后空片段落在修饰键/键位表之外，直接拒绝。
  it('拒绝空片段（连续/行首/行尾的 +），与 store 的 HOTKEY_RE 判定一致', () => {
    expect(parseAccelerator('CommandOrControl+Alt++D')).toEqual({ ok: false, reason: 'unknown-modifier' });
    expect(parseAccelerator('+CommandOrControl+D')).toEqual({ ok: false, reason: 'unknown-modifier' });
    expect(parseAccelerator('CommandOrControl+Alt+')).toEqual({ ok: false, reason: 'bad-key' });
  });

  it('双向一致：含空片段的加速器，parser 放行与否必须与 normalizeSettings 相同', async () => {
    const { normalizeSettings } = await import('../../src/main/settings');
    for (const accel of ['CommandOrControl+Alt++D', '+CommandOrControl+D', 'CommandOrControl+Alt+', 'Alt++', '++']) {
      const storeAccepts = normalizeSettings({ toggleHotkey: accel }).toggleHotkey === accel;
      expect(parseAccelerator(accel).ok).toBe(storeAccepts);
    }
  });

  // F4/T3-5 deferred 裁决：parseAccelerator 与 normalizeSettings 必须共用同一份语法。
  // HOTKEY_RE 允许 F1–F24 与具名键；若 parseAccelerator 只遍历具名表而漏掉功能键区间，
  // settings 里合法的 CommandOrControl+Alt+F12 会在注册期被误报冲突。
  it('功能键 F1–F24 与设置层语法对齐，不被误拒', () => {
    expect(parseAccelerator('CommandOrControl+Alt+F12').ok).toBe(true);
    expect(parseAccelerator('CmdOrCtrl+Shift+F24').ok).toBe(true);
    expect(parseAccelerator('CommandOrControl+Alt+F25').ok).toBe(false);
  });

  it('具名键（Enter/Space 等）与设置层语法对齐', () => {
    expect(parseAccelerator('CommandOrControl+Shift+Enter').ok).toBe(true);
    expect(parseAccelerator('CommandOrControl+Space').ok).toBe(true);
  });

  it('与 normalizeSettings 同一份语法：store 放行的加速器注册期必放行', async () => {
    const { DEFAULT_SETTINGS, normalizeSettings } = await import('../../src/main/settings');
    // store 层通过的全部加速器（默认值 + grammar 合法自定义）在注册期也必须 ok，
    // 否则 onConflict 会在用户毫无做错时弹出"快捷键不可用"通知。
    const accepted = [
      DEFAULT_SETTINGS.toggleHotkey,
      DEFAULT_SETTINGS.quickAskHotkey,
      normalizeSettings({ toggleHotkey: 'CommandOrControl+Alt+F2' }).toggleHotkey,
    ];
    for (const accel of accepted) expect(parseAccelerator(accel).ok).toBe(true);
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
