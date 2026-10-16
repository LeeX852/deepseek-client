import { describe, expect, it } from 'vitest';
import { pageEventSchema } from '../../src/shared/pageEvent';

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

  it('拒绝超长 id 以阻断路径注入', () => {
    expect(pageEventSchema.safeParse({ type: 'session-list-changed', sessions: [{ id: '../../x'.repeat(20), title: 't' }] }).success).toBe(false);
  });
});
