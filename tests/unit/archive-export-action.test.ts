import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExportAction } from '../../src/main/archive/exportAction';
import { createArchiveStore } from '../../src/main/archive/store';
import type { ArchivedSession } from '../../src/main/archive/store';

const older: ArchivedSession = { id: 'a', title: '旧会话', updatedAt: 100, messages: [{ role: 'user', text: '早' }] };
const newer: ArchivedSession = { id: 'b', title: '新/会话: 1', updatedAt: 200, messages: [{ role: 'assistant', text: '晚' }] };

function makeDeps(opts?: {
  sessions?: ArchivedSession[];
  get?: (id: string) => ArchivedSession | undefined;
  pick?: (defaultPath: string) => Promise<string | null>;
  write?: (filePath: string, markdown: string) => void;
}) {
  const sessions = opts?.sessions ?? [older, newer];
  const picked: string[] = [];
  const written: Array<{ filePath: string; markdown: string }> = [];
  const notices: Array<{ title: string; body: string }> = [];
  return {
    deps: createExportAction({
      // 打乱输入顺序：导出必须自己按 updatedAt 降序，而不是信任 list() 的次序。
      list: () => [...sessions].reverse().map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
      get: opts?.get ?? ((id) => sessions.find(s => s.id === id)),
      pickSavePath: async (defaultPath) => { picked.push(defaultPath); return opts?.pick ? opts.pick(defaultPath) : 'C:/out/session.md'; },
      writeMarkdown: (filePath, markdown) => {
        if (opts?.write) { opts.write(filePath, markdown); return; }
        written.push({ filePath, markdown });
      },
      notify: (title, body) => { notices.push({ title, body }); },
    }),
    picked,
    written,
    notices,
  };
}

describe('createExportAction（Task 7 交接 A：Ctrl/Cmd+E 导出链路）', () => {
  it('选 updatedAt 最新的一条，建议名走 sanitizeFileName+.md，写入 toMarkdown 结果', async () => {
    const h = makeDeps();
    await h.deps();
    expect(h.picked).toEqual(['新_会话_ 1.md']);
    expect(h.written).toHaveLength(1);
    const w = h.written[0]!;
    expect(w.filePath).toBe('C:/out/session.md');
    expect(w.markdown).toContain('# 新/会话: 1');
    expect(w.markdown).toContain('**DeepSeek**');
    expect(w.markdown).toContain('晚');
    // 选错条目（导出陈旧内容）在这里变红：旧的绝不掺进来。
    expect(w.markdown).not.toContain('早');
    expect(h.notices).toEqual([]);
  });

  it('无归档会话：只提示，不开保存框、不写盘', async () => {
    const h = makeDeps({ sessions: [] });
    await h.deps();
    expect(h.picked).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.notices.map(n => n.title)).toEqual(['没有可导出的会话']);
  });

  it('用户取消保存框：整体放弃，不写盘、不打扰', async () => {
    const h = makeDeps({ pick: async () => null });
    await h.deps();
    expect(h.picked).toEqual(['新_会话_ 1.md']);
    expect(h.written).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('list 有而 get 读不出（损坏/被淘汰）：提示失败，不开框', async () => {
    const h = makeDeps({ get: () => undefined });
    await h.deps();
    expect(h.picked).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.notices.map(n => n.title)).toEqual(['导出失败']);
  });

  it('写盘抛错（选中只读路径）：提示导出失败，不静默失灵', async () => {
    const h = makeDeps({ write: () => { throw new Error('EACCES'); } });
    await h.deps();
    expect(h.notices.map(n => n.title)).toEqual(['导出失败']);
    expect(h.notices[0]!.body).toContain('C:/out/session.md');
  });

  it('pickSavePath 拒绝（异常）时错误上抛给调用方，由接线处 catch——action 不吞异常', async () => {
    const h = createExportAction({
      list: () => [{ id: 'a', title: 't', updatedAt: 1 }],
      get: () => ({ id: 'a', title: 't', updatedAt: 1, messages: [] }),
      pickSavePath: () => Promise.reject(new Error('dialog unavailable')),
      writeMarkdown: () => { throw new Error('must not reach'); },
      notify: () => { throw new Error('must not reach'); },
    });
    await expect(h()).rejects.toThrow('dialog unavailable');
  });

  // I-3 修复：导出写路径。fake 只有保存框（注入临时路径，绕开原生 dialog），
  // store 是真实 createArchiveStore（upsert→落盘→list/get 读回），writeMarkdown
  // 与 index.ts 生产胶水逐字同构（writeFileSync utf8）。磁盘上读回来的 Markdown
  // 必须含标题行与角色标签——§15.7 的接线就此钉死，不需要真对话框。
  it('真实 store + 真实写盘 + fake 保存路径：磁盘文件含标题行与角色标签（§15.7 写路径）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ds-export-unit-'));
    try {
      const store = createArchiveStore(dir);
      store.upsert({
        type: 'conversation-updated',
        messages: [
          { role: 'user', text: '导出会话标题' },
          { role: 'assistant', text: '导出回答正文' },
        ],
      });
      // 直接在临时根目录落盘（store 自己已建好 archive 子目录，这里不再造目录）。
      const out = path.join(dir, 'picked-export.md');
      const picked: string[] = [];
      const notices: string[] = [];
      const run = createExportAction({
        list: () => store.list(),
        get: (id) => store.get(id),
        pickSavePath: async (defaultPath) => { picked.push(defaultPath); return out; },
        writeMarkdown: (filePath, markdown) => { writeFileSync(filePath, markdown, 'utf8'); },
        notify: (title) => { notices.push(title); },
      });
      await run();
      // 建议名来自归档标题（sanitize 后 + .md），不是硬编码。
      expect(picked).toEqual(['导出会话标题.md']);
      const md = readFileSync(out, 'utf8');
      expect(md.split('\n')[0]).toBe('# 导出会话标题');
      expect(md).toContain('**你**');
      expect(md).toContain('**DeepSeek**');
      expect(md).toContain('导出回答正文');
      // 成功路径不通知（静默即用户可见的落盘文件本身）。
      expect(notices).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
