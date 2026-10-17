import { describe, expect, it, vi } from 'vitest';
import { createThrottle, createNotifier } from '../../src/main/notifications';

describe('createThrottle', () => {
  it('同 key 30 秒内第二次被挡', () => {
    let t = 0;
    const th = createThrottle(() => (t += 0));
    t = 1000; expect(th('a')).toBe(true);
    t = 1000 + 29_000; expect(th('a')).toBe(false);
    t = 1000 + 31_000; expect(th('a')).toBe(true);
  });
  it('全局每分钟最多 3 条', () => {
    let t = 0;
    const th = createThrottle(() => t);
    t = 0;
    expect(th('a')).toBe(true); expect(th('b')).toBe(true); expect(th('c')).toBe(true);
    expect(th('d')).toBe(false); // 第 4 条同分钟被挡
    t = 61_000; expect(th('e')).toBe(true); // 下一分钟放行
  });
});

describe('createNotifier', () => {
  it('notifyOnAnswer=false 时不发回答通知', () => {
    const show = vi.fn();
    const n = createNotifier({ settings: () => ({ notifyOnAnswer: false }), show, now: () => 0 });
    n({ type: 'answer-completed', preview: '结论' });
    expect(show).not.toHaveBeenCalled();
  });
  it('登录过期始终提示', () => {
    const show = vi.fn();
    const n = createNotifier({ settings: () => ({ notifyOnAnswer: true }), show, now: () => 0 });
    n({ type: 'auth-state-changed', signedIn: false });
    expect(show).toHaveBeenCalledWith('登录已过期', expect.stringContaining('登录'));
  });
});
