import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchQueryHandler } from '../../src/main/search';
import { buildPageEventHandler } from '../../src/main/pageEvents';
import { createArchiveStore } from '../../src/main/archive/store';

const newStore = () => createArchiveStore(mkdtempSync(path.join(tmpdir(), 'ds-search-')));

afterEach(() => { vi.restoreAllMocks(); });

// RW-3 / I-4：SEARCH_QUERY 补齐发送方校验——非搜索窗 sender 一律拒答，不泄露归档标题。
describe('buildSearchQueryHandler', () => {
  it('非搜索窗 sender 返回空数组', () => {
    const s = newStore();
    s.upsert({ type: 'conversation-updated', sessionId: 'abc', title: '机密会话标题', messages: [{ role: 'user', text: 'x' }] });
    const h = buildSearchQueryHandler({ store: s, expectedSearchWindowId: () => 42 });
    expect(h(999, { query: '机密' })).toEqual([]);
    expect(h(999, { query: '' })).toEqual([]);
  });

  it('搜索窗 sender 命中子串标题；空查询返回全量', () => {
    const s = newStore();
    s.upsert({ type: 'conversation-updated', sessionId: 'abc', title: 'e2e-search-target', messages: [{ role: 'user', text: 'x' }] });
    const h = buildSearchQueryHandler({ store: s, expectedSearchWindowId: () => 42 });
    expect(h(42, { query: 'e2e-search' }).map(i => i.title)).toContain('e2e-search-target');
    expect(h(42, { query: '' }).map(i => i.id)).toContain('abc');
  });
});

// RW-3 / I-1（spec §8）：page-event 处理链里任何抛错（如归档写失败）都必须被隔离，
// 绝不冒到 ipcMain 监听器把主进程打死。
describe('buildPageEventHandler 崩溃隔离', () => {
  it('onEvent 抛错不外泄，且记日志', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onEvent = vi.fn(() => { throw new Error('fs exploded'); });
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    expect(() => h({ sender: { id: 7 }, payload: { type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: 'hi' }] } })).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });
});
