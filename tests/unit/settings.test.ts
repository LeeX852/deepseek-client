import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, createSettingsStore, normalizeSettings } from '../../src/main/settings';

const dir = () => mkdtempSync(path.join(tmpdir(), 'ds-settings-'));
const fileIn = (d: string) => path.join(d, 'settings.json');

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

  it('版本升级：旧版本文件被迁移到当前结构', () => {
    writeFileSync(fileIn(d), JSON.stringify({ version: 0, toggleHotkey: 'Super+K' }));
    const s = createSettingsStore(d);
    expect(s.get().version).toBe(1);
    expect(s.get().toggleHotkey).toBe('Super+K');
  });
});
