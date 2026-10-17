import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { clickSessionByTitle, createObserver, extractConversation } from '../../src/preload/observer';
import type { PageEvent } from '../../src/shared/pageEvent';
import { pageEventSchema } from '../../src/shared/pageEvent';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const doc = (f: string) => new JSDOM(readFileSync(path.join(dir, f), 'utf8')).window.document;

describe('extractConversation', () => {
  it('提取到用户/助手两类消息且长度受限', () => {
    const msgs = extractConversation(doc('logged-in.html'));
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.role === 'assistant')).toBe(true);
    expect(msgs.every(m => (m.role === 'user' || m.role === 'assistant') && m.text.length <= 20000)).toBe(true);
  });
});

// Task 6：侧边栏按标题定位跳转。点击真实 <a>（jsdom 对 <a> 的 click 会尝试
// 导航并打 "Not implemented: navigation"——不抛异常也不该断言导航），
// 这里只断言返回值：命中并点击 = true，未命中 = false。
describe('clickSessionByTitle', () => {
  it('命中存在标题返回 true，不存在返回 false', () => {
    const d = doc('logged-in.html');
    const first = d.querySelector('a[href*="/a/chat/s/"] .ds-focus-ring + div')?.textContent?.trim() ?? '';
    expect(first).not.toBe('');
    expect(clickSessionByTitle(d, first)).toBe(true);
    expect(clickSessionByTitle(d, '__不存在__的标题')).toBe(false);
  });
});

describe('conversation-updated schema', () => {
  it('接受合法对话更新', () => {
    expect(pageEventSchema.safeParse({ type: 'conversation-updated', sessionId: 'abc123', messages: [{ role: 'user', text: 'hi' }] }).success).toBe(true);
  });
  it('拒绝超长单条文本', () => {
    expect(pageEventSchema.safeParse({ type: 'conversation-updated', messages: [{ role: 'user', text: 'x'.repeat(20001) }] }).success).toBe(false);
  });
  it('拒绝消息条数超上限', () => {
    const messages = Array.from({ length: 201 }, () => ({ role: 'user' as const, text: 't' }));
    expect(pageEventSchema.safeParse({ type: 'conversation-updated', messages }).success).toBe(false);
  });
});

// Task 2：observer 在防抖 tick 内稳定上报当前对话。三条硬约束：
// 1) 内容未变不重复 emit（按消息序列做内容键去重）；
// 2) emit 前截断到最后 200 条——extractConversation 不设上限，
//    超限会被主进程 pageEvents 的 safeParse 整条拒掉、静默丢归档；
// 3) sessionId 省略（Plan 3 裁决：归档键由首条用户消息在归档侧派生）。
describe('observer.conversationUpdated', () => {
  it('内容变化 emit，未变不重复，再变再 emit', () => {
    const events: PageEvent[] = [];
    const d = doc('logged-in.html');
    const o = createObserver({ doc: d, emit: (e) => events.push(e) });
    o.conversationUpdated();
    expect(events.some(e => e.type === 'conversation-updated')).toBe(true);
    events.length = 0; o.conversationUpdated();
    expect(events.some(e => e.type === 'conversation-updated')).toBe(false);
    // DOM 内容变了 → 应再次 emit
    d.querySelector('.ds-message')!.textContent = '换了一个问题';
    o.conversationUpdated();
    expect(events.some(e => e.type === 'conversation-updated')).toBe(true);
  });

  it('emit 的消息不带 sessionId', () => {
    const events: PageEvent[] = [];
    const o = createObserver({ doc: doc('logged-in.html'), emit: (e) => events.push(e) });
    o.conversationUpdated();
    const evt = events.find(e => e.type === 'conversation-updated')!;
    expect('sessionId' in evt).toBe(false);
  });

  it('超过 200 条时截断为最后 200 条，且事件能通过 pageEventSchema', () => {
    const events: PageEvent[] = [];
    const html = Array.from({ length: 201 }, (_, i) => `<div class="ds-message">消息${i}</div>`).join('');
    const d = new JSDOM(`<body>${html}</body>`).window.document;
    const o = createObserver({ doc: d, emit: (e) => events.push(e) });
    o.conversationUpdated();
    const messages = events.flatMap(e => (e.type === 'conversation-updated' ? e.messages : []));
    expect(messages).toHaveLength(200);
    // slice(-200) 保留最新的最后 200 条：首条「消息0」被丢弃
    expect(messages[0]!.text).toBe('消息1');
    expect(messages[199]!.text).toBe('消息200');
    const evt = events.find(e => e.type === 'conversation-updated')!;
    expect(pageEventSchema.safeParse(evt).success).toBe(true);
  });

  it('无消息时不发（未登录 fixture 没有 .ds-message）', () => {
    const events: PageEvent[] = [];
    const o = createObserver({ doc: doc('signed-out.html'), emit: (e) => events.push(e) });
    o.conversationUpdated();
    expect(events).toHaveLength(0);
  });

  it('降级后不发', () => {
    const events: PageEvent[] = [];
    // 只有消息节点、无会话链接也无 textarea → tick 连续空轮后降级
    const d = new JSDOM('<body><div class="ds-message">hi</div></body>').window.document;
    const o = createObserver({ doc: d, emit: (e) => events.push(e), degradeThreshold: 2 });
    o.tick(); o.tick();
    expect(o.isDegraded()).toBe(true);
    events.length = 0;
    o.conversationUpdated();
    expect(events).toHaveLength(0);
  });
});
