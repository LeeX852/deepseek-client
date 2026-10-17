import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { injectTextSchema } from '../shared/pageEvent';

// MAX_BYTES 与 pageEvent.injectTextSchema 的 max(524_288) 是同一 512KB 上限的两种量纲
// （此处数 UTF-8 字节，那里数 UTF-16 code unit）：ASCII 下重合，多字节内容下字节检查更严
// （只会更早拒，绝不会放不合格 payload 出门）——不是笔误，别把两者"对齐"成同一个数。
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
  const payload = buildQuoteBlock(path.basename(filePath), r.text);
  // readTextFileCapped 只按 statSync().size 判超限，量的是文件内容；引用块还要加
  // 围栏与文件名。恰好 512KB 的文件能过第一关，但组合后的 payload 会越过
  // injectTextSchema.max(524288)，发过去被 preload 静默丢弃、用户看不到任何反应。
  // 出门前按"实际要发的那个串"自检：bytes 先兜底，schema 再与 preload 同一条上限对齐。
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) return { ok: false, reason: 'too-large' };
  if (!injectTextSchema.safeParse({ text: payload }).success) return { ok: false, reason: 'too-large' };
  return { ok: true, payload };
}
