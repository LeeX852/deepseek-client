import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 512 * 1024; // spec：单文件 512KB

export function readTextFileCapped(
  filePath: string,
  maxBytes: number = MAX_BYTES,
): { ok: true; text: string } | { ok: false; reason: 'too-large' | 'read-failed' } {
  try {
    if (statSync(filePath).size > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, text: readFileSync(filePath, 'utf8') };
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
}

export function buildQuoteBlock(fileName: string, text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  // 围栏前置并把文件名作为围栏信息串，整块以围栏开头；围栏比内容里最长反引号串更长，
  // 使内容无法提前闭合围栏。
  return `${fence}${fileName}\n${text}\n${fence}\n`;
}

export function prepareFileInject(
  filePath: string,
): { ok: true; payload: string } | { ok: false; reason: string } {
  const r = readTextFileCapped(filePath);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, payload: buildQuoteBlock(path.basename(filePath), r.text) };
}
