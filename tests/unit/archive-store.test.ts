import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArchiveStore } from '../../src/main/archive/store';
const dir = () => mkdtempSync(path.join(tmpdir(), 'ds-arch-'));

// RW-2：归档键一律来自 observer 传来的真 sessionId，标题取 ev.title（真实侧边栏摘要）。
// 旧的"首条用户消息派生键"路径已删除——它把 CJK 首句塌成下划线串（撞键 C-2）、
// 把助手开头的对话塌进 untitled（C-3）、把标题存成正文（搜索匹配不上 C-1）。
describe('createArchiveStore', () => {
  it('upsert 带真 sessionId 的对话后可读回', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'abc', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }] });
    expect(s.get('abc')?.messages).toHaveLength(2);
  });

  it('无 sessionId 时跳过不归档（不再派生坏键）', () => {
    const d = dir();
    const s = createArchiveStore(d);
    s.upsert({ type: 'conversation-updated', messages: [{ role: 'user', text: 'hello world' }] });
    expect(s.list()).toHaveLength(0);
    expect(existsSync(path.join(d, 'archive'))).toBe(true); // 目录建了，但没落任何记录
    expect(readdirSync(path.join(d, 'archive')).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('两条不同 CJK 会话不再撞键（C-2）', () => {
    const s = createArchiveStore(dir());
    // 首句都是纯中文：旧实现 safeKey(首句) 会把它们都变一串下划线 → 同一文件互相覆盖。
    s.upsert({ type: 'conversation-updated', sessionId: 's1', title: '初次问候', messages: [{ role: 'user', text: '你好啊朋友' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 's2', title: '年后含义解释', messages: [{ role: 'user', text: '你好啊朋友' }] });
    const ids = s.list().map(i => i.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(s.get('s1')?.title).toBe('初次问候');
    expect(s.get('s2')?.title).toBe('年后含义解释');
  });

  it('助手开头的对话不再塌成 untitled（C-3）', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'as1', title: '某会话摘要', messages: [{ role: 'assistant', text: '你好！很高兴见到你' }] });
    const rec = s.get('as1');
    expect(rec).toBeDefined();
    expect(rec?.id).toBe('as1');
    expect(rec?.id).not.toBe('untitled');
    expect(rec?.title).toBe('某会话摘要');
    // 标题绝不再是消息正文（C-1 的来源）
    expect(rec?.title).not.toBe(rec?.messages[0]?.text);
  });

  it('无 title 时回退为真 id，而不是消息正文', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'nt', messages: [{ role: 'user', text: '这是一段正文' }] });
    expect(s.get('nt')?.title).toBe('nt');
  });

  it('追加式合并：更长覆盖、更短不覆盖', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: '1' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: '1' }, { role: 'assistant', text: '2' }] });
    expect(s.get('a')?.messages).toHaveLength(2);
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: 'x' }] });
    expect(s.get('a')?.messages).toHaveLength(2); // 更短不覆盖
  });

  it('等长且首条相同 → 替换：捕获流式末答增长', () => {
    const s = createArchiveStore(dir());
    // 流式回答期间消息数恒为 2，只有末条 assistant 文本在增长，首条（锚定问题）不变。
    s.upsert({ type: 'conversation-updated', sessionId: 'g', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'g', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a much longer answer' }] });
    expect(s.get('g')?.messages[1]?.text).toBe('a much longer answer');
  });

  it('等长但首条不同 → 不覆盖：滚动碎片保留现有快照', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'f', messages: [{ role: 'user', text: 'A' }, { role: 'assistant', text: 'x' }] });
    // 虚拟列表滚到别处：条数相同、首条换了 → 视碎片为不完整快照，保留已存的。
    s.upsert({ type: 'conversation-updated', sessionId: 'f', messages: [{ role: 'user', text: 'B' }, { role: 'assistant', text: 'y' }] });
    expect(s.get('f')?.messages).toEqual([{ role: 'user', text: 'A' }, { role: 'assistant', text: 'x' }]);
  });

  it('list 反映磁盘真实文件', () => {
    const d = dir();
    const s = createArchiveStore(d);
    s.upsert({ type: 'conversation-updated', sessionId: 'k1', title: '会话一', messages: [{ role: 'user', text: 'a' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'k2', title: '会话二', messages: [{ role: 'user', text: 'b' }] });
    const onDisk = readdirSync(path.join(d, 'archive')).filter(f => f.endsWith('.json')).sort();
    expect(s.list().map(i => i.id).sort()).toEqual(['k1', 'k2']);
    expect(onDisk).toEqual(['k1.json', 'k2.json']);
    // 内存索引与磁盘一致：每个列出的 id 都能 get 回来，get 不列幽灵。
    for (const it of s.list()) expect(s.get(it.id)?.title).toBe(it.title);
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
