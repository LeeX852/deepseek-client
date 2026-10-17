import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArchiveStore } from '../../src/main/archive/store';
const dir = () => mkdtempSync(path.join(tmpdir(), 'ds-arch-'));

describe('createArchiveStore', () => {
  it('upsert 带 id 的对话后可读回', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'abc', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }] });
    expect(s.get('abc')?.messages).toHaveLength(2);
  });
  it('无 id 时派生稳定键并落盘', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', messages: [{ role: 'user', text: 'hello world' }] });
    expect(s.list()).toHaveLength(1);
    expect(existsSync(s.pathFor(s.list()[0]!.id))).toBe(true);
  });
  it('追加式合并：更长快照覆盖', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: '1' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: '1' }, { role: 'assistant', text: '2' }] });
    expect(s.get('a')?.messages).toHaveLength(2);
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: 'x' }] });
    expect(s.get('a')?.messages).toHaveLength(2); // 更短不覆盖
  });
  it('等长快照替换：捕获流式增长', () => {
    const s = createArchiveStore(dir());
    // 流式回答期间消息数恒为 2，只有 assistant 文本在增长。
    s.upsert({ type: 'conversation-updated', sessionId: 'g', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'g', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a much longer answer' }] });
    expect(s.get('g')?.messages[1]?.text).toBe('a much longer answer'); // 等长也覆盖，最终全文落盘
  });
  it('损坏文件回滚不抛出', () => {
    const d = dir(); const s = createArchiveStore(d);
    s.upsert({ type: 'conversation-updated', sessionId: 'z', messages: [{ role: 'user', text: 'ok' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'z', messages: [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'again' }] });
    writeFileSync(s.pathFor('z'), '{ broken');
    expect(createArchiveStore(d).get('z')?.messages.length).toBeGreaterThan(0); // 回退 .bak
  });
  it('list 回退 .bak 恢复损坏记录且不产生幽灵条目', () => {
    const d = dir(); const s = createArchiveStore(d);
    s.upsert({ type: 'conversation-updated', sessionId: 'k', messages: [{ role: 'user', text: 'hello' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'k', messages: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }] });
    writeFileSync(s.pathFor('k'), 'garbage-not-json');                 // 主文件损坏，应回退 .bak
    writeFileSync(path.join(d, 'archive', 'phantom.json'), '{}');      // 语法合法但缺字段，须跳过而非幽灵
    const reopened = createArchiveStore(d);
    const items = reopened.list();
    expect(items.map(i => i.id)).toContain('k');                        // 从 .bak 恢复可见
    expect(items.some(i => i.id === 'phantom')).toBe(false);            // 无幽灵条目
    expect(items.every(i => typeof i.id === 'string' && i.id.length > 0 && typeof i.title === 'string')).toBe(true);
    expect(reopened.get('k')?.messages.length).toBeGreaterThan(0);
  });
  it('超 maxSessions 淘汰最旧', () => {
    const s = createArchiveStore(dir(), { maxSessions: 2 });
    for (const id of ['a', 'b', 'c']) s.upsert({ type: 'conversation-updated', sessionId: id, messages: [{ role: 'user', text: id }] });
    expect(s.list()).toHaveLength(2);
    expect(s.get('a')).toBeUndefined();
  });
});
