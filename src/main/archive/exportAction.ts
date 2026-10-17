import { sanitizeFileName, toMarkdown } from './export';
import type { ArchivedSession } from './store';

// Task 7 交接 A：导出最近归档会话为 Markdown。spec §15.7 的触发链路。
// dialog/落盘/通知全部走注入（同 notifications/quickAsk 的纪律）：本模块在纯
// Node 单测下可全路径验证；index.ts 只保留"取真实句柄 + 调 Electron API"的胶水。
// 语义钉死：Ctrl/Cmd+E → list() 按 updatedAt 降序取最近一条 → get(id) 复核可读
// → 弹保存框（取消即整体放弃，绝不留半成品文件）→ 写失败必须通知，不静默失灵。
export type ExportActionDeps = {
  list(): Array<{ id: string; title: string; updatedAt: number }>;
  get(id: string): ArchivedSession | undefined;
  /** 返回用户选定的绝对路径；取消（或平台不支持）返回 null。 */
  pickSavePath(defaultPath: string): Promise<string | null>;
  writeMarkdown(filePath: string, markdown: string): void;
  notify(title: string, body: string): void;
};

export function createExportAction(deps: ExportActionDeps): () => Promise<void> {
  return async (): Promise<void> => {
    const latest = [...deps.list()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) {
      deps.notify('没有可导出的会话', '先在 DeepSeek 里聊几句，会话会自动归档');
      return;
    }
    // list 与 get 之间文件可能被淘汰/损坏（store 的读回退在这里兜底）：
    // 取不到就提示失败，绝不导出上一条目的陈旧内容。
    const session = deps.get(latest.id);
    if (!session) {
      deps.notify('导出失败', '最新的归档记录读不出来了');
      return;
    }
    const filePath = await deps.pickSavePath(`${sanitizeFileName(session.title)}.md`);
    if (!filePath) return;
    try {
      deps.writeMarkdown(filePath, toMarkdown(session));
    } catch {
      deps.notify('导出失败', `无法写入 ${filePath}`);
    }
  };
}
