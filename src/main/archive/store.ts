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

  function read(id: string): ArchivedSession | undefined {
    const f = fileFor(id);
    if (!existsSync(f)) return undefined;
    try { return JSON.parse(readFileSync(f, 'utf8')) as ArchivedSession; }
    catch {
      const bak = f + '.bak';
      if (existsSync(bak)) { try { return JSON.parse(readFileSync(bak, 'utf8')) as ArchivedSession; } catch { return undefined; } }
      return undefined;
    }
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
      try { const s = JSON.parse(readFileSync(path.join(root, f), 'utf8')) as ArchivedSession; return [{ id: s.id, title: s.title, updatedAt: s.updatedAt }]; }
      catch { return []; }
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
      if (existing && existing.messages.length >= ev.messages.length) return;
      write({ id, title: existing?.title && existing.title !== existing.id ? existing.title : title, updatedAt: Date.now(), messages: ev.messages });
      evict();
    },
  };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
