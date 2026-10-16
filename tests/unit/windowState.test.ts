import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWindowStateStore, sanitizeBounds } from '../../src/main/windowState';

const one = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
const two = [...one, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];

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
});
