import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractSessions, extractSignedIn, extractLatestAnswerPreview, createObserver } from '../../src/preload/observer';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const doc = (f: string) => new JSDOM(readFileSync(path.join(dir, f), 'utf8')).window.document;

describe('extractSessions', () => {
  it('从登录态 fixture 提取会话，id 来自 href、title 来自标题节点', () => {
    const sessions = extractSessions(doc('logged-in.html'));
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions[0]!.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(sessions[0]!.title.length).toBeGreaterThan(0);
  });
  it('未登录 fixture 提取不到会话', () => {
    expect(extractSessions(doc('signed-out.html'))).toEqual([]);
  });
});

describe('extractSignedIn', () => {
  it('登录态为 true、未登录为 false', () => {
    expect(extractSignedIn(doc('logged-in.html'))).toBe(true);
    expect(extractSignedIn(doc('signed-out.html'))).toBe(false);
  });
});

describe('createObserver', () => {
  it('首轮 emit session-list-changed 与 auth-state-changed(true)', () => {
    const emit = vi.fn();
    createObserver({ doc: doc('logged-in.html'), emit }).tick();
    const types = emit.mock.calls.map(c => (c[0] as { type: string }).type);
    expect(types).toContain('session-list-changed');
    expect(types).toContain('auth-state-changed');
  });
  it('会话列表未变时不重复 emit session-list-changed', () => {
    const emit = vi.fn();
    const o = createObserver({ doc: doc('logged-in.html'), emit });
    o.tick(); emit.mockClear(); o.tick();
    expect(emit.mock.calls.map(c => (c[0] as { type: string }).type)).not.toContain('session-list-changed');
  });
  it('连续 3 轮全空则降级并停发', () => {
    const emit = vi.fn();
    const d = doc('signed-out.html'); // 无会话、无登录标志
    const o = createObserver({ doc: d, emit, degradeThreshold: 3 });
    o.tick(); o.tick(); o.tick();
    expect(o.isDegraded()).toBe(true);
    emit.mockClear(); o.tick();
    expect(emit).not.toHaveBeenCalled();
  });
});

// Finding I-1：answer-completed 必须在预览「稳定」后才发，而不是每次变化就发。
describe('createObserver().answerCompleted 稳定后才上报', () => {
  const completedTypes = (emit: ReturnType<typeof vi.fn>) =>
    emit.mock.calls.map(c => (c[0] as { type: string }).type).filter(t => t === 'answer-completed');

  it('(a) 预览每轮都在变（流式中）→ 从不 emit answer-completed', () => {
    const emit = vi.fn();
    let preview: string | null = null;
    const o = createObserver({ doc: doc('logged-in.html'), emit, readPreview: () => preview });
    preview = 'Deep'; o.answerCompleted();
    preview = 'DeepSe'; o.answerCompleted();
    preview = 'DeepSeek 是好'; o.answerCompleted();
    expect(completedTypes(emit)).toHaveLength(0);
  });

  it('(b) 预览连续两轮相同才 emit 恰好一次 answer-completed', () => {
    const emit = vi.fn();
    let preview: string | null = null;
    const o = createObserver({ doc: doc('logged-in.html'), emit, readPreview: () => preview });
    preview = '最终回答';
    o.answerCompleted(); // 第 1 次看到：不发（尚未确认稳定）
    expect(completedTypes(emit)).toHaveLength(0);
    o.answerCompleted(); // 第 2 次相同：稳定 → 恰好发一次
    expect(completedTypes(emit)).toHaveLength(1);
    const evt = emit.mock.calls.map(c => c[0]).find(e => (e as { type: string }).type === 'answer-completed');
    expect(evt).toEqual({ type: 'answer-completed', preview: '最终回答' });
  });

  it('(c) 第三轮仍是同一稳定预览不重复 emit', () => {
    const emit = vi.fn();
    let preview: string | null = null;
    const o = createObserver({ doc: doc('logged-in.html'), emit, readPreview: () => preview });
    preview = '最终回答';
    o.answerCompleted(); o.answerCompleted();
    o.answerCompleted(); o.answerCompleted(); // 之后持续稳定
    expect(completedTypes(emit)).toHaveLength(1);
  });

  it('默认抽取器（真实 DOM）同样只在稳定后发一次', () => {
    // 走生产路径：不注入 readPreview，用 extractLatestAnswerPreview 读 DOM，
    // 在两次调用之间改最后一条助手消息文本，验证变化不发、停顿才发。
    const emit = vi.fn();
    const d = new JSDOM(
      '<div class="ds-message"><div class="ds-assistant-message-main-content">第一</div></div>',
    ).window.document;
    const o = createObserver({ doc: d, emit });
    const setContent = (t: string) => {
      const el = d.querySelector('.ds-assistant-message-main-content')!;
      el.textContent = t;
    };
    o.answerCompleted(); // 首次看到「第一」：不发
    expect(completedTypes(emit)).toHaveLength(0);
    setContent('第一段'); // 流式追加：预览变了 → 仍不发
    o.answerCompleted();
    expect(completedTypes(emit)).toHaveLength(0);
    o.answerCompleted(); // 与上轮同为「第一段」：稳定 → 发一次
    expect(completedTypes(emit)).toHaveLength(1);
    o.answerCompleted(); // 继续稳定：不重复
    expect(completedTypes(emit)).toHaveLength(1);
  });
});
