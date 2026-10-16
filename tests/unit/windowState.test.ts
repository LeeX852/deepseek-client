import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWindowStateStore, sanitizeBounds } from '../../src/main/windowState';

const one = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
const two = [...one, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];

const fileIn = (d: string) => path.join(d, 'window.json');
// 隔离出来的坏文件：window.json.<唯一后缀>.corrupt。返回内容，便于同时断言"存在"和"字节未变"，
// 且不对后缀形状做额外假设——只断言"每次损坏各留一份"。
const quarantined = (d: string): string[] =>
  readdirSync(d)
    .filter(f => f !== 'window.json' && f.startsWith('window.json.') && f.includes('corrupt'))
    .map(f => readFileSync(path.join(d, f), 'utf8'));

describe('sanitizeBounds', () => {
  it('接受完全落在屏幕内的窗口', () => {
    expect(sanitizeBounds({ x: 100, y: 100, width: 800, height: 600, maximized: false }, one))
      .toEqual({ x: 100, y: 100, width: 800, height: 600, maximized: false });
  });

  it('宽度或高度低于最小值时判为无效', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 200, height: 600, maximized: false }, one)).toBeNull();
  });

  it('位置为负或非数字时判为无效', () => {
    expect(sanitizeBounds({ x: '0', y: 0, width: 800, height: 600, maximized: false }, one)).toBeNull();
    expect(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600, maximized: false }, one)).toBeNull();
  });

  it('跨到已断开外接屏的坐标被拒绝，避免窗口开到看不见的地方', () => {
    expect(sanitizeBounds({ x: 3000, y: 0, width: 800, height: 600, maximized: false }, one)).toBeNull();
    expect(sanitizeBounds({ x: 3000, y: 0, width: 800, height: 600, maximized: false }, two)).not.toBeNull();
  });

  it('只要标题栏区域落在某屏工作区内即可通过', () => {
    const b = sanitizeBounds({ x: 1880, y: 0, width: 800, height: 600, maximized: false }, two);
    expect(b).not.toBeNull();
  });
});

describe('createWindowStateStore', () => {
  it('无文件时返回 null，save 后原样读回', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    const s = createWindowStateStore(d);
    expect(s.load()).toBeNull();
    s.save({ x: 10, y: 20, width: 1000, height: 700, maximized: true });
    expect(s.load()).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: true });
    expect(JSON.parse(readFileSync(path.join(d, 'window.json'), 'utf8'))).toBeTypeOf('object');
  });

  it('文件损坏时返回 null 而不是抛出', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    const s = createWindowStateStore(d);
    s.save({ x: 10, y: 20, width: 1000, height: 700, maximized: false });
    writeFileSync(path.join(d, 'window.json'), 'nope');
    expect(s.load()).toBeNull();
  });

  it('损坏文件被隔离到独立文件且保留原始字节', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    const s = createWindowStateStore(d);
    s.save({ x: 10, y: 20, width: 1000, height: 700, maximized: false });
    writeFileSync(fileIn(d), 'nope');
    expect(s.load()).toBeNull();
    expect(quarantined(d)).toEqual(['nope']);
    expect(existsSync(fileIn(d))).toBe(false);
  });

  it('连续损坏多次：load() 始终返回 null 而不抛出，每份坏文件都留着', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    const s = createWindowStateStore(d);
    for (const bytes of ['nope-1', 'nope-2', 'nope-3']) {
      writeFileSync(fileIn(d), bytes);
      expect(s.load()).toBeNull();
    }
    expect(quarantined(d)).toHaveLength(3);
    expect(quarantined(d)).toContain('nope-1');
    expect(quarantined(d)).toContain('nope-2');
    expect(quarantined(d)).toContain('nope-3');

    // 隔离后 store 仍可正常写入并读回，不会因为坏文件残留而抛异常
    s.save({ x: 1, y: 2, width: 900, height: 700, maximized: true });
    expect(s.load()).toEqual({ x: 1, y: 2, width: 900, height: 700, maximized: true });
  });

  it('隔离目标名已被占用时不覆盖、不抛出：预置的 .corrupt 内容保持原样', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ds-bounds-'));
    // 播种一个"上次损坏留下的" .corrupt，名字取当前毫秒，与本次隔离的首选后缀同名
    const seeded = `${fileIn(d)}.${Date.now()}.corrupt`;
    writeFileSync(seeded, 'PREVIOUS-QUARANTINE');

    const s = createWindowStateStore(d);
    writeFileSync(fileIn(d), 'nope');
    expect(() => s.load()).not.toThrow();
    expect(s.load()).toBeNull();
    expect(readFileSync(seeded, 'utf8')).toBe('PREVIOUS-QUARANTINE');
    expect(quarantined(d)).toContain('nope');
    expect(quarantined(d)).toContain('PREVIOUS-QUARANTINE');
  });
});
