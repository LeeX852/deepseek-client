import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PageEvent } from '../../shared/pageEvent';

export type ArchivedMessage = { role: 'user' | 'assistant'; text: string };
export type ArchivedSession = { id: string; title: string; updatedAt: number; messages: ArchivedMessage[] };
type ConvEv = Extract<PageEvent, { type: 'conversation-updated' }>;

const safeKey = (raw: string): string => (raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)) || 'untitled';

// RW-2：归档键只用 observer 传来的真 sessionId（/a/chat/s/<id>，safeKey 后是
// [A-Za-z0-9_-]{1,64}，无 CJK 碰撞）。RW-1 已保证只在对话页 emit，sessionId 恒在；
// 万一缺失（老事件/异常调用）直接返回 null 由 upsert 跳过——绝不从消息正文派生键
// （那正是全终审 C-2 撞键、C-3 塌 untitled 的根因）。title 取 ev.title（真实侧边栏
// 摘要），搜索/跳转据此匹配侧边栏 <a>（C-1 的承重前提）。
function keyOf(ev: ConvEv): { id: string } | null {
  if (!ev.sessionId) return null;
  return { id: safeKey(ev.sessionId) };
}

// 流式合并规则（RW-2 / I-3）：在"同一真 id"下区分三种等/不等长场景。
//   • 更长 → 替换（滚动采到更多消息，或流式追加了新回合）。
//   • 更短 → 永不覆盖（保留已采到的最全快照）。
//   • 等长：
//       - 首条消息 role+text 相同 → 替换：这是同一锚定对话、末条答案在流式增长
//         （消息数不变、文本变长），必须覆盖才能拿到全文。
//       - 首条不同 → 不覆盖：等长却换了首条 = 虚拟列表滚到别处的碎片，保留现有。
// 判据取自内存索引（count + first），无需读盘。
function shouldReplace(prev: { count: number; first: ArchivedMessage | undefined } | undefined, next: ArchivedMessage[]): boolean {
  if (!prev) return true;
  if (next.length > prev.count) return true;
  if (next.length < prev.count) return false;
  const a = next[0];
  const b = prev.first;
  return !!a && !!b && a.role === b.role && a.text === b.text;
}

// 内存索引条目：足以支撑 list()（title/updatedAt）、evict()（size）、流式合并判定
// （count/first），让每次 upsert 不再全量读盘——修 I-2（10MB 会话每 tick 卡 ~100ms）。
type IndexEntry = { title: string; updatedAt: number; size: number; count: number; first: ArchivedMessage | undefined };

export function createArchiveStore(dir: string, opts?: { maxSessions?: number; maxBytes?: number }) {
  const root = path.join(dir, 'archive');
  mkdirSync(root, { recursive: true });
  const maxSessions = opts?.maxSessions ?? 200;
  const maxBytes = opts?.maxBytes ?? 100 * 1024 * 1024;
  const fileFor = (id: string) => path.join(root, `${safeKey(id)}.json`);
  const index = new Map<string, IndexEntry>();

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
    // I-1：任何读盘/解析异常都降级为"这条不可用"，绝不抛出打断调用方。
    try { const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown; return isWellFormed(parsed) ? parsed : undefined; }
    catch { return undefined; }
  }
  // 主文件损坏（不可解析或形状不符）时回退到 .bak，两处读取共用同一套回退逻辑。
  function readFrom(f: string): ArchivedSession | undefined {
    const primary = parseFile(f);
    if (primary) return primary;
    try { return existsSync(f + '.bak') ? parseFile(f + '.bak') : undefined; }
    catch { return undefined; }
  }
  function read(id: string): ArchivedSession | undefined {
    const f = fileFor(id);
    try { if (!existsSync(f)) return undefined; } catch { return undefined; }
    return readFrom(f);
  }
  // I-1：写盘全程包 try/catch。失败（磁盘满/权限/占用）返回 false，upsert 据此跳过
  // 这次写并保留索引原状，异常绝不冒到 ipcMain 监听器杀死主进程（spec §8）。
  function write(s: ArchivedSession): boolean {
    const f = fileFor(s.id);
    const tmp = f + '.tmp';
    try {
      if (existsSync(f)) { try { renameSync(f, f + '.bak'); } catch { /* 备份失败不阻断主写 */ } }
      writeFileSync(tmp, JSON.stringify(s));
      renameSync(tmp, f);
      return true;
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* 清临时文件尽力而为 */ }
      return false;
    }
  }

  // 启动时扫盘一次建索引；此后 list/evict/合并判定全走内存，不再逐文件读+parse（I-2）。
  function buildIndex(): void {
    let files: string[];
    try { files = readdirSync(root); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(root, f);
      const s = readFrom(full);
      if (!s) continue;
      let size = 0;
      try { size = statSync(full).size; } catch { size = 0; }
      index.set(s.id, { title: s.title, updatedAt: s.updatedAt, size, count: s.messages.length, first: s.messages[0] });
    }
  }

  function list(): Array<{ id: string; title: string; updatedAt: number }> {
    return Array.from(index, ([id, e]) => ({ id, title: e.title, updatedAt: e.updatedAt }));
  }

  function evict(): void {
    const items = [...index.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    let total = 0;
    items.forEach(([id, e], i) => {
      if (i >= maxSessions || total + e.size > maxBytes) {
        const f = fileFor(id);
        try { rmSync(f, { force: true }); rmSync(f + '.bak', { force: true }); } catch { /* ignore */ }
        index.delete(id);
      } else total += e.size;
    });
  }

  // 淘汰只在新键出现（条数变化）或每写满 N 次才跑；等长流式覆盖不触发全量扫描（I-2）。
  let writesSinceEvict = 0;
  const EVICT_EVERY_N_WRITES = 32;
  function maybeEvict(countChanged: boolean): void {
    writesSinceEvict += 1;
    if (countChanged || writesSinceEvict >= EVICT_EVERY_N_WRITES) {
      writesSinceEvict = 0;
      evict();
    }
  }

  buildIndex();

  return {
    pathFor: fileFor,
    get: read,
    list,
    upsert(ev: ConvEv): void {
      if (!ev.messages.length) return;
      const key = keyOf(ev);
      if (!key) return; // 无真 sessionId → 跳过（RW-1 已保证只在对话页 emit）
      const { id } = key;
      const prev = index.get(id);
      if (!shouldReplace(prev, ev.messages)) return;
      const title = ev.title ?? prev?.title ?? id;
      const updatedAt = Date.now();
      const session: ArchivedSession = { id, title, updatedAt, messages: ev.messages };
      if (!write(session)) return; // fs 异常：跳过这次写，不抛
      let size = 0;
      try { size = statSync(fileFor(id)).size; } catch { size = JSON.stringify(session).length; }
      index.set(id, { title, updatedAt, size, count: ev.messages.length, first: ev.messages[0] });
      maybeEvict(prev === undefined);
    },
  };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
