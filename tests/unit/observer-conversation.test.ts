import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractConversation } from '../../src/preload/observer';
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
