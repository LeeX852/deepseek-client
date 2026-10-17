import { describe, expect, it } from 'vitest';
import { toMarkdown, sanitizeFileName } from '../../src/main/archive/export';
import type { ArchivedSession } from '../../src/main/archive/store';

const s: ArchivedSession = { id: 'a', title: '测试/会话: 1', updatedAt: 1, messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你**好**' }] };

describe('toMarkdown', () => {
  it('含标题与按角色前缀的消息，正文不被当 HTML', () => {
    const md = toMarkdown(s);
    expect(md).toContain('# 测试/会话: 1');
    expect(md).toContain('**你**');
    expect(md).toContain('**DeepSeek**');
    expect(md).toContain('你**好**');
  });

  // I-1: 正文必须原样输出——任何把 <b> & " 转义成 HTML 实体的实现都会在此失败。
  it('正文不转义 HTML 字符', () => {
    const s2: ArchivedSession = {
      id: 'b',
      title: 't',
      updatedAt: 1,
      messages: [{ role: 'user', text: 'a <b> & "c"' }],
    };
    const md = toMarkdown(s2);
    expect(md).toContain('<b>');
    expect(md).toContain('&');
    expect(md).toContain('"c"');
    expect(md).not.toContain('&lt;');
    expect(md).not.toContain('&amp;');
    expect(md).not.toContain('&quot;');
  });

  // I-1: 角色标签与其对应正文的配对顺序，而非仅各自存在。
  it('标签紧贴对应正文：你→用户文本、DeepSeek→助手文本', () => {
    const md = toMarkdown(s);
    expect(md.indexOf('**你**')).toBeLessThan(md.indexOf('你好'));
    expect(md.indexOf('你好')).toBeLessThan(md.indexOf('**DeepSeek**'));
    expect(md.indexOf('**DeepSeek**')).toBeLessThan(md.indexOf('你**好**'));
  });
});

describe('sanitizeFileName', () => {
  it('去掉路径分隔与非法字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e')).not.toMatch(/[\\/\\:*?"<>|]/);
  });

  // I-1: 控制字符（\u0000-\u001f）必须被剥离。
  it('剥离控制字符', () => {
    expect(sanitizeFileName('a\u0001b')).not.toMatch(/[\u0000-\u001f]/);
  });

  // I-1: 完整非法字符集全部剥离。
  it('剥离完整非法字符集', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).not.toMatch(/[\\/\\:*?"<>|]/);
  });

  // I-1: 空白/无有效字符的标题回退为 'session'。
  it('空白标题回退 session', () => {
    expect(sanitizeFileName('')).toBe('session');
    expect(sanitizeFileName('   ')).toBe('session');
  });

  // I-1: 长度封顶 80。
  it('长度上限 80', () => {
    expect(sanitizeFileName('x'.repeat(100))).toHaveLength(80);
  });

  // I-2: Windows 保留设备名需加前缀，避免裸保留名落盘。
  it('规避 Windows 保留设备名', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul')).toBe('_nul');
    expect(sanitizeFileName('COM1')).toBe('_COM1');
    expect(sanitizeFileName('LPT9')).toBe('_LPT9');
    // 非保留名不受影响。
    expect(sanitizeFileName('conversation')).toBe('conversation');
  });
});
