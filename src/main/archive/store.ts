import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PageEvent } from '../../shared/pageEvent';

export type ArchivedMessage = { role: 'user' | 'assistant'; text: string };
export type ArchivedSession = { id: string; title: string; updatedAt: number; messages: ArchivedMessage[] };
type ConvEv = Extract<PageEvent, { type: 'conversation-updated' }>;

const safeKey = (raw: string): string => (raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)) || 'untitled';

function keyOf(ev: ConvEv): { id: string; title: string } {
  if (ev.sessionId) return { id: safeKey(ev.sessionId), title: safeKey(ev.sessionId) };
  const firstUser = ev.messages.find(m => m.role === 'user')?.text ?? '';
  return { id: safeKey(firstUser.slice(0, 24)), title: firstUser.slice(0, 200) || '未命名会话' };
}

export function createArchiveStore(dir: string, opts?: { maxSessions?: number; maxBytes?: number }) {
  const root = path.join(dir, 'archive');
  mkdirSync(root, { recursive: true });
  const maxSessions = opts?.maxSessions ?? 200;
  const maxBytes = opts?.maxBytes ?? 100 * 1024 * 1024;
  const fileFor = (id: string) => path.join(root, `${safeKey(id)}.json`);

  // 语法合法但字段缺失的 JSON（如 `{}`）会被 JSON.parse 接受，直接 cast 就
  // 产生 id/undefined 的幽灵条目，且让 evict 少算、下游按 id 索引时崩掉。
  // 只有满足这张形状的快照才算有效，其余一律按损坏处理去回退 .bak。
  function isWellFormed(v: unknown): v is ArchivedSession {
    if (!v || typeof v !== 'object') return false;
    const s = v as Record<string, unknown>;
    return typeof s.id === 'string' && s.id.length > 0
      && typeof s.title === 'string'
      && Array.isArray(s.messages)
      && typeof s.updatedAt === 'number';
  }
  function parseFile(f: string): ArchivedSession | undefined {
    try { const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown; return isWellFormed(parsed) ? parsed : undefined; }
    catch { return undefined; }
  }
  // 主文件损坏（不可解析或形状不符）时回退到 .bak，两处读取共用同一套回退逻辑。
  function readFrom(f: string): ArchivedSession | undefined {
    return parseFile(f) ?? (existsSync(f + '.bak') ? parseFile(f + '.bak') : undefined);
  }
  function read(id: string): ArchivedSession | undefined {
    const f = fileFor(id);
    if (!existsSync(f)) return undefined;
    return readFrom(f);
  }
  function write(s: ArchivedSession): void {
    const f = fileFor(s.id);
    if (existsSync(f)) { try { renameSync(f, f + '.bak'); } catch { /* best-effort */ } }
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, f);
  }
  function list(): Array<{ id: string; title: string; updatedAt: number }> {
    if (!existsSync(root)) return [];
    return readdirSync(root).filter(f => f.endsWith('.json')).flatMap(f => {
      const s = readFrom(path.join(root, f));
      return s ? [{ id: s.id, title: s.title, updatedAt: s.updatedAt }] : [];
    });
  }
  function evict(): void {
    const items = list().sort((a, b) => b.updatedAt - a.updatedAt);
    let total = 0;
    items.forEach((it, i) => {
      const f = fileFor(it.id);
      const size = existsSync(f) ? readFileSync(f).length : 0;
      if (i >= maxSessions || total + size > maxBytes) { try { rmSync(f, { force: true }); rmSync(f + '.bak', { force: true }); } catch { /* ignore */ } }
      else total += size;
    });
  }

  return {
    pathFor: fileFor,
    get: read,
    list,
    upsert(ev: ConvEv): void {
      const { id, title } = keyOf(ev);
      const existing = read(id);
      // 仅当已存快照"严格更长"才跳过。observer 每 ~2×/s 在流式回答期间发
      // conversation-updated，此时消息数不变但文本在增长；用 >= 会让第一个残缺
      // 快照定型、最终全文永不落盘。等长时继续整体替换：observer 对同一内容去重，
      // 故等长写入仍幂等且有界（每键一个文件），同时捕获流式增长。
      if (existing && existing.messages.length > ev.messages.length) return;
      write({ id, title: existing?.title && existing.title !== existing.id ? existing.title : title, updatedAt: Date.now(), messages: ev.messages });
      evict();
    },
  };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
