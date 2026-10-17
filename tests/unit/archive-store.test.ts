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
  it('损坏文件回滚不抛出', () => {
    const d = dir(); const s = createArchiveStore(d);
    s.upsert({ type: 'conversation-updated', sessionId: 'z', messages: [{ role: 'user', text: 'ok' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'z', messages: [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'again' }] });
    writeFileSync(s.pathFor('z'), '{ broken');
    expect(createArchiveStore(d).get('z')?.messages.length).toBeGreaterThan(0); // 回退 .bak
  });
  it('超 maxSessions 淘汰最旧', () => {
    const s = createArchiveStore(dir(), { maxSessions: 2 });
    for (const id of ['a', 'b', 'c']) s.upsert({ type: 'conversation-updated', sessionId: id, messages: [{ role: 'user', text: id }] });
    expect(s.list()).toHaveLength(2);
    expect(s.get('a')).toBeUndefined();
  });
});
