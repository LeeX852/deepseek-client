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
});
describe('sanitizeFileName', () => {
  it('去掉路径分隔与非法字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e')).not.toMatch(/[\\/\\:*?"<>|]/);
  });
});
