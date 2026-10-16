import { describe, expect, it } from 'vitest';
import { buildMenuActions, buildTooltip } from '../../src/main/tray';

describe('buildTooltip', () => {
  it('空闲态', () => {
    expect(buildTooltip({ unread: 0, degraded: false })).toBe('DeepSeek');
  });

  it('有未读时带上条数', () => {
    expect(buildTooltip({ unread: 3, degraded: false })).toBe('DeepSeek · 3 条新回复');
  });

  it('降级态必须可见地告知增强功能失效，而不是静默失灵', () => {
    expect(buildTooltip({ unread: 0, degraded: true })).toBe('DeepSeek · 页面已改版，增强功能暂停');
  });

  it('未读上限截断到 99+', () => {
    expect(buildTooltip({ unread: 140, degraded: false })).toBe('DeepSeek · 99+ 条新回复');
  });
});

describe('buildMenuActions', () => {
  it('三个动作且顺序固定', () => {
    expect(buildMenuActions().map(a => a.id)).toEqual(['show', 'settings', 'quit']);
  });

  it('退出项明确区别于关窗', () => {
    expect(buildMenuActions().find(a => a.id === 'quit')?.label).toContain('退出');
    expect(buildMenuActions().find(a => a.id === 'quit')?.label).toContain('进程');
  });
});
