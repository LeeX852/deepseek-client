import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { SELECTORS } from '../../src/preload/selectors';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const load = (f: string) =>
  new JSDOM(readFileSync(path.join(fixtureDir, f), 'utf8')).window.document;

describe('M0 选择器契约（真实 fixture，非构造 DOM）', () => {
  it('登录态 fixture 里每个选择器都能命中', () => {
    const doc = load('logged-in.html');
    for (const key of [
      'sessionItem', 'sessionItemTitle', 'messageList', 'messageItem',
      'assistantMessage', 'inputBox', 'sendButton', 'signedInMarker',
    ] as const) {
      expect(doc.querySelector(SELECTORS[key]), `${key} = ${SELECTORS[key]}`).not.toBeNull();
    }
    // 会话列表应命中多条（历史会话），不是恰好一个噪声元素
    expect(doc.querySelectorAll(SELECTORS.sessionItem).length).toBeGreaterThan(1);
  });

  it('会话条目能取到非空标题文本', () => {
    const doc = load('logged-in.html');
    const title = doc.querySelector(SELECTORS.sessionItemTitle);
    expect(title?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('未登录 fixture 里登录标志 / 会话链接 / 发送按钮都不命中', () => {
    const doc = load('signed-out.html');
    expect(doc.querySelector(SELECTORS.signedInMarker)).toBeNull();
    expect(doc.querySelector(SELECTORS.sessionItem)).toBeNull();
    expect(doc.querySelector(SELECTORS.sendButton)).toBeNull();
  });
});
