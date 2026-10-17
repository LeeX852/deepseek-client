import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextFileCapped, buildQuoteBlock, prepareFileInject } from '../../src/main/fileInject';

const tmp = (name: string, content: string) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ds-file-'));
  const p = path.join(d, name); writeFileSync(p, content); return p;
};

describe('readTextFileCapped', () => {
  it('限内文件读出内容', () => {
    const r = readTextFileCapped(tmp('a.txt', 'hello'), 512);
    expect(r).toEqual({ ok: true, text: 'hello' });
  });
  it('超限文件判 too-large', () => {
    const r = readTextFileCapped(tmp('b.txt', 'x'.repeat(600)), 512);
    expect(r.ok).toBe(false);
  });
});

describe('buildQuoteBlock', () => {
  it('普通文本用三反引号围栏并带文件名', () => {
    const s = buildQuoteBlock('a.txt', 'hi');
    expect(s).toContain('a.txt'); expect(s).toContain('```'); expect(s).toContain('hi');
  });
  it('内容含三反引号时加长围栏，不被提前闭合', () => {
    const s = buildQuoteBlock('code.md', '```\ncode\n```');
    expect(s.startsWith('````')).toBe(true); // 四个反引号
  });
});

describe('prepareFileInject', () => {
  it('限内文件产出可注入 payload', () => {
    const r = prepareFileInject(tmp('c.txt', 'content here'));
    expect(r.ok).toBe(true);
  });
});
