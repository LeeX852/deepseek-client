import type { ArchivedSession } from './store';

export function sanitizeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'session';
}

export function toMarkdown(session: ArchivedSession): string {
  const lines = [`# ${session.title}`, ''];
  for (const m of session.messages) lines.push(`**${m.role === 'user' ? '你' : 'DeepSeek'}**`, '', m.text, '');
  return lines.join('\n');
}
