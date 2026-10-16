import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, createSettingsStore, normalizeSettings } from '../../src/main/settings';

const dir = () => mkdtempSync(path.join(tmpdir(), 'ds-settings-'));
const fileIn = (d: string) => path.join(d, 'settings.json');
// 隔离出来的坏文件：settings.json.<唯一后缀>.corrupt。返回内容，便于同时断言"存在"和"字节未变"，
// 且不对后缀形状做额外假设——只断言"每次损坏各留一份"。
const quarantined = (d: string): string[] =>
  readdirSync(d)
    .filter(f => f !== 'settings.json' && f.startsWith('settings.json.') && f.includes('corrupt'))
    .map(f => readFileSync(path.join(d, f), 'utf8'));

describe('normalizeSettings', () => {
  it('非对象输入回落默认值', () => {
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('丢弃未知键与类型不符的值', () => {
    const r = normalizeSettings({ toggleHotkey: 42, notifyOnAnswer: 'yes', unknown: 1 });
    expect(r.toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
    expect(r.notifyOnAnswer).toBe(DEFAULT_SETTINGS.notifyOnAnswer);
    expect('unknown' in r).toBe(false);
  });

  it('接受合法的快捷键字符串并要求含修饰键', () => {
    expect(normalizeSettings({ toggleHotkey: 'CommandOrControl+Alt+D' }).toggleHotkey).toBe('CommandOrControl+Alt+D');
    expect(normalizeSettings({ toggleHotkey: 'D' }).toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
  });

  it('具名键与功能键 accelerator 原样保留（回归：旧 [\\w+] 字符类只匹配单个字符，把这些合法值误拒）', () => {
    const accepted = [
      'CommandOrControl+Shift+Enter',
      'CommandOrControl+Alt+Space',
      'CmdOrCtrl+Shift+PageUp',
      'Super+F1',
      'Alt+F24',
      'Control+Tab',
      'Shift+Alt+Backspace',
      'CommandOrControl+Alt+D',
      'Super+K',
    ];
    for (const key of accepted) {
      expect(normalizeSettings({ toggleHotkey: key }).toggleHotkey).toBe(key);
      expect(normalizeSettings({ quickAskHotkey: key }).quickAskHotkey).toBe(key);
    }
  });

  it('没有修饰键的 accelerator 仍然回落默认值，哪怕键位本身合法', () => {
    for (const key of ['Enter', 'Space', 'F1', 'D', 'Shift', 'CommandOrControl', 'PageUp']) {
      expect(normalizeSettings({ toggleHotkey: key }).toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
      expect(normalizeSettings({ quickAskHotkey: key }).quickAskHotkey).toBe(DEFAULT_SETTINGS.quickAskHotkey);
    }
  });

  it('拒绝语法外的键位与畸形分隔符', () => {
    for (const key of [
      'CommandOrControl+Shift+Bogus',
      'CommandOrControl+Shift+F0',
      'CommandOrControl+Shift+F25',
      'CommandOrControl++Enter',
      'CommandOrControl+Shift+Enter+',
      'CommandOrControl-Shift-Enter',
      '',
      '   ',
    ]) {
      expect(normalizeSettings({ toggleHotkey: key }).toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
    }
  });
});

describe('createSettingsStore', () => {
  let d = '';
  beforeEach(() => { d = dir(); });

  it('缺文件时创建并返回默认值', () => {
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(readFileSync(s.path(), 'utf8'))).toEqual(DEFAULT_SETTINGS);
  });

  it('set 做浅合并并落盘', () => {
    const s = createSettingsStore(d);
    expect(s.set({ closeToTray: false }).closeToTray).toBe(false);
    expect(JSON.parse(readFileSync(fileIn(d), 'utf8')).closeToTray).toBe(false);
    expect(s.get().toggleHotkey).toBe(DEFAULT_SETTINGS.toggleHotkey);
  });

  it('损坏 JSON 时备份坏文件并回到默认值', () => {
    writeFileSync(fileIn(d), '{ oops');
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    writeFileSync(fileIn(d), '{ oops');
    s.set({ notifyOnAnswer: false });
    expect(readFileSync(fileIn(d), 'utf8')).not.toBe('{ oops');
  });

  it('损坏文件确实被隔离到独立文件，且保留原始字节', () => {
    writeFileSync(fileIn(d), '{ oops');
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(quarantined(d)).toEqual(['{ oops']);
    // 原路径已被挪走，默认值不会被坏内容污染
    expect(existsSync(fileIn(d))).toBe(false);
    s.set({ notifyOnAnswer: false });
    expect(JSON.parse(readFileSync(fileIn(d), 'utf8')).notifyOnAnswer).toBe(false);
  });

  it('第二次损坏不会让构造器抛出，两份坏文件都保留', () => {
    writeFileSync(fileIn(d), '{ oops');
    expect(() => createSettingsStore(d)).not.toThrow();
    writeFileSync(fileIn(d), '{ broken again');
    expect(() => createSettingsStore(d)).not.toThrow();
    expect(quarantined(d)).toHaveLength(2);
    expect(quarantined(d)).toContain('{ oops');
    expect(quarantined(d)).toContain('{ broken again');

    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => s.set({ closeToTray: false })).not.toThrow();
    expect(JSON.parse(readFileSync(fileIn(d), 'utf8')).closeToTray).toBe(false);
  });

  it('隔离目标名已被占用时不覆盖、不抛出：预置的 .corrupt 内容保持原样', () => {
    // 直接播种一个"上一次损坏留下的" .corrupt，名字取当前毫秒——
    // 与本次隔离的首选后缀同名，用来验证重试路径既不动旧文件也不崩。
    const seeded = `${fileIn(d)}.${Date.now()}.corrupt`;
    writeFileSync(seeded, 'PREVIOUS-QUARANTINE');
    writeFileSync(fileIn(d), '{ oops');

    expect(() => createSettingsStore(d)).not.toThrow();
    // 坏文件已被挪走，不会再污染启动路径
    expect(existsSync(fileIn(d))).toBe(false);
    expect(createSettingsStore(d).get()).toEqual(DEFAULT_SETTINGS);
    expect(readFileSync(seeded, 'utf8')).toBe('PREVIOUS-QUARANTINE');
    expect(quarantined(d)).toContain('{ oops');
    expect(quarantined(d)).toContain('PREVIOUS-QUARANTINE');
  });

  it('版本升级：旧版本文件被迁移到当前结构', () => {
    writeFileSync(fileIn(d), JSON.stringify({ version: 0, toggleHotkey: 'Super+K' }));
    const s = createSettingsStore(d);
    expect(s.get().version).toBe(1);
    expect(s.get().toggleHotkey).toBe('Super+K');
  });
});
