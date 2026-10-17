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
