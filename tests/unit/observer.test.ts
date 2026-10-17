import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractSessions, extractSignedIn, extractLatestAnswerPreview, createObserver } from '../../src/preload/observer';
import type { PageEvent } from '../../src/shared/pageEvent';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const doc = (f: string) => new JSDOM(readFileSync(path.join(dir, f), 'utf8')).window.document;
// Plan 4 Task 1：内联片段构造 DOM 必须给 JSDOM 传 url——conversationUpdated 走
// doc.location.href，没有 url 时 jsdom 的 location 是 about:blank 会干扰断言。
const html = (body: string) => new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: 'https://chat.deepseek.com/' }).window.document;
const SIGNED_IN = `<textarea></textarea><a href="/a/chat/s/abc"><div class="ds-focus-ring"></div><div>t</div></a>`;

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

// Plan 4 Task 1：真实登出页既无 textarea 也无会话链接 —— tick() 若先做
// 「空轮→降级」早返回，auth-state-changed(false) 永远发不出去，托盘/通知侧
// 再也收不到登出信号。登出事件必须优先于降级判定发出。
describe('createObserver().tick 登出通知与上限', () => {
  it('首轮就是登出/空 DOM 时不发 auth-state-changed（消除启动误报）', () => {
    const ev: PageEvent[] = [];
    // lastSignedIn 初值为 false：未登录首屏、或已登录但 SPA 尚未水合 textarea 的首轮
    // （signedIn 都是 false），false !== false 不成立 → 绝不发 auth(false)，
    // 通知侧不会在每次启动弹一条假的「登录已过期」。
    const o = createObserver({ doc: html(''), emit: e => ev.push(e) });
    o.tick();
    expect(ev.some(e => e.type === 'auth-state-changed')).toBe(false);
  });

  it('登出（曾登录→空页）先发 auth-state-changed(false) 再降级', () => {
    const d = html(SIGNED_IN);
    const ev: PageEvent[] = [];
    const o = createObserver({ doc: d, emit: e => ev.push(e), degradeThreshold: 1 });
    o.tick(); // 登录态：auth(true)+session-list
    ev.length = 0;
    d.body.innerHTML = ''; // 模拟登出：无 textarea、无会话
    o.tick();
    // 真实的 true→false 跃迁仍必须发出登出通知（初值 false 不会吃掉它）……
    expect(ev.some(e => e.type === 'auth-state-changed' && (e as { signedIn: boolean }).signedIn === false)).toBe(true);
    // ……且是在「空轮→降级」早返回之前发出的：同一轮 tick 之后已置为降级，
    // 证明 auth 事件确实在降级判定前发出、而非仅存在。
    expect(o.isDegraded()).toBe(true);
  });

  it('>500 会话被截断到 500', () => {
    const many = Array.from({ length: 600 }, (_, i) => `<a href="/a/chat/s/s${i}"><div class="ds-focus-ring"></div><div>t${i}</div></a>`).join('');
    const ev: PageEvent[] = [];
    createObserver({ doc: html(`<textarea></textarea>${many}`), emit: e => ev.push(e) }).tick();
    const list = ev.find(e => e.type === 'session-list-changed') as { sessions: unknown[] } | undefined;
    expect(list?.sessions).toHaveLength(500);
  });
});
