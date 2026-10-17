import type { ArchivedSession } from './store';

// Windows 保留设备名：即便带扩展名（CON.txt、nul.md）也无法建文件，故按第一个
// 点之前的基名判定（大小写不敏感），命中就补一个下划线前缀再落盘。
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'session';
  return RESERVED_NAME.test(cleaned.split('.')[0] ?? '') ? `_${cleaned}` : cleaned;
}

export function toMarkdown(session: ArchivedSession): string {
  const lines = [`# ${session.title}`, ''];
  for (const m of session.messages) lines.push(`**${m.role === 'user' ? '你' : 'DeepSeek'}**`, '', m.text, '');
  return lines.join('\n');
}
