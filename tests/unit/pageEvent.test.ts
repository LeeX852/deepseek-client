import { describe, expect, it } from 'vitest';
import { injectTextSchema, pageEventSchema } from '../../src/shared/pageEvent';

describe('pageEventSchema', () => {
  it('接受会话列表事件', () => {
    const r = pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: 'a', title: '标题' }] });
    expect(r.success).toBe(true);
  });

  it('接受回答完成事件', () => {
    const r = pageEventSchema.safeParse({ type: 'answer-completed', preview: '结论是' });
    expect(r.success).toBe(true);
  });

  it('接受登录态事件', () => {
    expect(pageEventSchema.safeParse({ type: 'auth-state-changed', signedIn: true }).success).toBe(true);
  });

  it('拒绝未知 type', () => {
    expect(pageEventSchema.safeParse({ type: 'execute-js' }).success).toBe(false);
  });

  it('拒绝超长标题（不可信页面文本必须有上界）', () => {
    const r = pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: 'a', title: 'x'.repeat(201) }] });
    expect(r.success).toBe(false);
  });

  it('拒绝超长会话列表', () => {
    const sessions = Array.from({ length: 501 }, (_, i) => ({ id: String(i), title: 't' }));
    expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions }).success).toBe(false);
  });

  it('拒绝短 id 里的 ../ ——路径注入靠字符白名单阻断，长度上界挡不住', () => {
    for (const id of ['../../secret', '../a', 'a/b', 'a\\b', '..', 'id ', '.hidden']) {
      expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id, title: 't' }] }).success)
        .toBe(false);
    }
  });

  it('拒绝超长 id 以阻断路径注入', () => {
    expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: '../../x'.repeat(20), title: 't' }] }).success).toBe(false);
    expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: 'a'.repeat(65), title: 't' }] }).success).toBe(false);
  });

  it('answer-completed 的 sessionId 可选：合法字符通过，含 ../ 的拒绝', () => {
    expect(pageEventSchema.safeParse({ type: 'answer-completed', sessionId: 'sess_01-A', preview: '结论是' }).success).toBe(true);
    expect(pageEventSchema.safeParse({ type: 'answer-completed', sessionId: '../../secret' }).success).toBe(false);
    expect(pageEventSchema.safeParse({ type: 'answer-completed', sessionId: 'a'.repeat(65) }).success).toBe(false);
  });
});

describe('injectTextSchema', () => {
  it('接受普通文本', () => {
    expect(injectTextSchema.safeParse({ text: '选中的文字' }).success).toBe(true);
  });
  it('拒绝空文本', () => {
    expect(injectTextSchema.safeParse({ text: '' }).success).toBe(false);
  });
  it('拒绝超过 512KB 的文本（与文件注入上限一致）', () => {
    expect(injectTextSchema.safeParse({ text: 'x'.repeat(524_289) }).success).toBe(false);
  });
});
