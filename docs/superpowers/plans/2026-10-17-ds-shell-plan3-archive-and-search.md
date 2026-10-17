# ds-shell V1 Plan 3：归档与搜索（M3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M2 的事件管线之上，把远端对话落到本地归档、导出成 Markdown，并提供一个本地搜索面板命中已归档会话、点击后在真实侧边栏里定位跳转——完成 spec 验收标准第 6、7 条。

**Architecture:** 先扩页面事件契约：observer 新增采集"当前对话消息"（role+text）并作为 `conversation-updated` 上报；主进程 `archive/store.ts` 以会话 id 为键做去重合并、原子写、200 会话 / 100MB 上限、损坏回滚；`archive/export.ts` 把一条归档转 Markdown；本地 `renderer/search` 窗口（`persist:shell`，与登录态隔离）查询归档，选中后经主进程让远端 preload 在侧边栏按标题定位并 `.click()` 跳转（不猜 URL id）。

**Tech Stack:** Electron 44、TypeScript strict、esbuild、Vitest + jsdom、@playwright/test `_electron`、zod。

**Spec:** [docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md](file:///D:/Study/programs/deepseek-client/docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md)

**M0/Plan2 依据：** 稳定选择器见 [src/preload/selectors.ts](file:///D:/Study/programs/deepseek-client/src/preload/selectors.ts)。M2 已交付 observer/pageEvents/notifications/quickAsk（`feat/ds-shell-plan1` 至 `401bfe2`）。

## Global Constraints

- 红线：只读已渲染 DOM，绝不请求 DeepSeek 内部接口；归档只落本地 `userData`、无遥测；不可信页面文本一律作数据（zod 上界、纯文本、不作 HTML/路径）。
- 分区：远端 `persist:deepseek`；本地搜索窗口 `persist:shell`，不共享登录态；不注册暴露本地文件系统的自定义协议。
- 归档降级：选择器连续失效时 observer 已自降级（M2），归档停止写入但聊天不受影响。
- 存储：原子写（临时文件 + rename）；损坏回滚上一份 `.bak`；保留最近 200 会话、总体积 ≤100MB、超限按最旧淘汰。
- 跳转不猜 URL 里的会话 id，改为在侧边栏 DOM 内按标题定位并 `.click()`。
- 搜索面板触发：用 shell 窗口聚焦时的应用内快捷键 `Ctrl/Cmd+K`（`webContents.on('before-input-event')` 拦截），**不新增全局快捷键、不加第 4 个托盘项**（Plan 1 冻结"恰好 3 项"契约）。
- TypeScript：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；测试与被测不同根。
- 每任务一次提交，说明"为什么"。沙箱 preload 必须 CJS 且 `require('electron')` external。

---

## File Structure（Plan 3 结束后形态）

```
src/shared/pageEvent.ts        （改）conversation-updated 变体 + conversationMessageSchema
src/preload/observer.ts        （改）extractConversation + conversationUpdated()
src/preload/deepseek.ts        （改）tick 内上报对话；监听 JUMP_TO_SESSION 执行侧边栏点击跳转
src/shared/ipc.ts              （改）新增 JUMP_TO_SESSION、SEARCH_QUERY 通道
src/main/archive/store.ts      （新）归档 store
src/main/archive/export.ts     （新）归档 → Markdown
src/main/archive/index.ts      （新）pageEvents → store 接线
src/main/search.ts             （新）搜索窗口生命周期 + ipcMain.handle(SEARCH_QUERY)
src/renderer/search/index.html / search.css / search.js   （新）搜索面板（persist:shell）
src/main/index.ts              （改）装配归档、搜索、Ctrl+K、导出触发
scripts/capture-fixture.mjs    （新）抓取登录态 DOM 存 fixture
tests/unit/{observer-conversation,archive-store,archive-export}.test.ts
tests/e2e/{archive,search-jump}.spec.ts
```

---

### Task 1: 扩展页面事件契约——采集当前对话消息

**Files:** Modify `src/shared/pageEvent.ts`, `src/preload/observer.ts`; Test `tests/unit/observer-conversation.test.ts`

**Interfaces:**
- Consumes: `SELECTORS.messageItem`、`SELECTORS.assistantMessage`
- Produces: `conversationMessageSchema`、`conversationUpdatedSchema`（并入 `pageEventSchema`）；`extractConversation(doc): Array<{role:'user'|'assistant'; text:string}>`。`messages` ≤200，每条 `text` ≤20000。

- [ ] **Step 1: 写失败测试** — `tests/unit/observer-conversation.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractConversation } from '../../src/preload/observer';
import { pageEventSchema } from '../../src/shared/pageEvent';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const doc = (f: string) => new JSDOM(readFileSync(path.join(dir, f), 'utf8')).window.document;

describe('extractConversation', () => {
  it('提取到用户/助手两类消息且长度受限', () => {
    const msgs = extractConversation(doc('logged-in.html'));
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.role === 'assistant')).toBe(true);
    expect(msgs.every(m => (m.role === 'user' || m.role === 'assistant') && m.text.length <= 20000)).toBe(true);
  });
});

describe('conversation-updated schema', () => {
  it('接受合法对话更新', () => {
    expect(pageEventSchema.safeParse({ type: 'conversation-updated', sessionId: 'abc123', messages: [{ role: 'user', text: 'hi' }] }).success).toBe(true);
  });
  it('拒绝超长单条文本', () => {
    expect(pageEventSchema.safeParse({ type: 'conversation-updated', messages: [{ role: 'user', text: 'x'.repeat(20001) }] }).success).toBe(false);
  });
  it('拒绝消息条数超上限', () => {
    const messages = Array.from({ length: 201 }, () => ({ role: 'user' as const, text: 't' }));
    expect(pageEventSchema.safeParse({ type: 'conversation-updated', messages }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm test tests/unit/observer-conversation.test.ts` → FAIL（未导出）。

- [ ] **Step 3: 扩展 schema（`src/shared/pageEvent.ts`）** — 在 `safeKeySchema` 之后加：

```ts
export const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(20000),
});
export const conversationUpdatedSchema = z.object({
  type: z.literal('conversation-updated'),
  sessionId: safeKeySchema.optional(),
  messages: z.array(conversationMessageSchema).max(200),
});
```
在 `pageEventSchema` 判别联合数组追加 `conversationUpdatedSchema`。

- [ ] **Step 4: 实现 `extractConversation`（`src/preload/observer.ts`）** — 文件末尾追加：

```ts
export function extractConversation(doc: Document): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of Array.from(doc.querySelectorAll(SELECTORS.messageItem))) {
    const isAssistant = !!m.querySelector(SELECTORS.assistantMessage);
    const text = (m.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    if (!text) continue;
    out.push({ role: isAssistant ? 'assistant' : 'user', text });
  }
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过** — `pnpm test tests/unit/observer-conversation.test.ts && pnpm typecheck` → 全绿。

- [ ] **Step 6: 提交** — `git commit -m "feat: 页面事件新增 conversation-updated，采集当前对话消息"`

---

### Task 2: observer 稳定上报对话内容

**Files:** Modify `src/preload/observer.ts`, `src/preload/deepseek.ts`; Test 追加 `tests/unit/observer-conversation.test.ts`

**Interfaces:**
- Consumes: `extractConversation`（Task 1）、`createObserver`（M2）
- Produces: `createObserver` 返回值新增 `conversationUpdated()`——对话内容变化时 emit `conversation-updated`；`sessionId` 能稳定取到才带、否则省略（绝不猜造）。`deepseek.ts` debounce tick 内调用。

- [ ] **Step 1: 追加失败测试**：

```ts
import { createObserver } from '../../src/preload/observer';
import type { PageEvent } from '../../src/shared/pageEvent';
describe('observer.conversationUpdated', () => {
  it('内容变化 emit，未变不重复', () => {
    const events: PageEvent[] = [];
    const o = createObserver({ doc: doc('logged-in.html'), emit: (e) => events.push(e) });
    o.conversationUpdated();
    expect(events.some(e => e.type === 'conversation-updated')).toBe(true);
    events.length = 0; o.conversationUpdated();
    expect(events.some(e => e.type === 'conversation-updated')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（`conversationUpdated` 不存在）。

- [ ] **Step 3: 实现** — `createObserver` 闭包内加 `let lastConversationKey = '';`，返回对象加：

```ts
conversationUpdated() {
  if (degraded) return;
  const messages = extractConversation(doc);
  if (!messages.length) return;
  const key = messages.map(m => `${m.role}\u0000${m.text}`).join('\u0001');
  if (key === lastConversationKey) return;
  lastConversationKey = key;
  emit({ type: 'conversation-updated', messages });
},
```
（`sessionId` 省略：M2 的 observer 无稳定"当前会话高亮"判据，Task 3 归档用首条用户消息派生键。留待 Plan 4 若拿到稳定 active 标记再补。）

`src/preload/deepseek.ts` debounce 回调里 `observer.answerCompleted();` 之后加 `observer.conversationUpdated();`。

- [ ] **Step 4: 跑测试与 e2e** — `pnpm test tests/unit/observer-conversation.test.ts && pnpm typecheck && pnpm build && pnpm test:e2e tests/e2e/inject.spec.ts` → 全绿。

- [ ] **Step 5: 提交** — `git commit -m "feat: observer 稳定上报当前对话内容（sessionId 暂缺省，键由归档侧派生）"`

---

### Task 3: 归档 store（去重合并 / 原子写 / 上限 / 损坏回滚）

**Files:** Create `src/main/archive/store.ts`; Test `tests/unit/archive-store.test.ts`

**Interfaces:**
- Consumes: `PageEvent`（`conversation-updated`）
- Produces:
  - `type ArchivedMessage = { role:'user'|'assistant'; text:string }`
  - `type ArchivedSession = { id:string; title:string; updatedAt:number; messages:ArchivedMessage[] }`
  - `createArchiveStore(dir, opts?:{maxSessions?:number;maxBytes?:number}) => { upsert(ev); get(id); list(); pathFor(id) }`
  - 键：`conversation-updated` 有 `sessionId` 用之；否则用首条用户消息前 24 字符 safeKey 化。合并：新消息数 ≥ 旧才整体替换。原子写 tmp→rename，旧副本转 `.bak`。读损坏回退 `.bak`。上限：`updatedAt` 保留最近 maxSessions(默认200)、总字节 ≤ maxBytes(默认100MB)，超限删最旧。

- [ ] **Step 1: 写失败测试** — `tests/unit/archive-store.test.ts`：

```ts
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArchiveStore } from '../../src/main/archive/store';
const dir = () => mkdtempSync(path.join(tmpdir(), 'ds-arch-'));

describe('createArchiveStore', () => {
  it('upsert 带 id 的对话后可读回', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'abc', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }] });
    expect(s.get('abc')?.messages).toHaveLength(2);
  });
  it('无 id 时派生稳定键并落盘', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', messages: [{ role: 'user', text: 'hello world' }] });
    expect(s.list()).toHaveLength(1);
    expect(existsSync(s.pathFor(s.list()[0]!.id))).toBe(true);
  });
  it('追加式合并：更长快照覆盖', () => {
    const s = createArchiveStore(dir());
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: '1' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: '1' }, { role: 'assistant', text: '2' }] });
    expect(s.get('a')?.messages).toHaveLength(2);
    s.upsert({ type: 'conversation-updated', sessionId: 'a', messages: [{ role: 'user', text: 'x' }] });
    expect(s.get('a')?.messages).toHaveLength(2); // 更短不覆盖
  });
  it('损坏文件回滚不抛出', () => {
    const d = dir(); const s = createArchiveStore(d);
    s.upsert({ type: 'conversation-updated', sessionId: 'z', messages: [{ role: 'user', text: 'ok' }] });
    s.upsert({ type: 'conversation-updated', sessionId: 'z', messages: [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'again' }] });
    writeFileSync(s.pathFor('z'), '{ broken');
    expect(createArchiveStore(d).get('z')?.messages.length).toBeGreaterThan(0); // 回退 .bak
  });
  it('超 maxSessions 淘汰最旧', () => {
    const s = createArchiveStore(dir(), { maxSessions: 2 });
    for (const id of ['a', 'b', 'c']) s.upsert({ type: 'conversation-updated', sessionId: id, messages: [{ role: 'user', text: id }] });
    expect(s.list()).toHaveLength(2);
    expect(s.get('a')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/archive/store.ts`**：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过** → 全绿。
- [ ] **Step 5: 提交** — `git commit -m "feat: 本地归档 store，去重合并 + 原子写 + 上限淘汰 + 损坏回滚"`

---

### Task 4: Markdown 导出

**Files:** Create `src/main/archive/export.ts`; Test `tests/unit/archive-export.test.ts`

**Interfaces:**
- Consumes: `ArchivedSession`（Task 3）
- Produces: `toMarkdown(session: ArchivedSession): string` — 标题行 + 每条消息按 role 加 `**你**` / `**DeepSeek**` 前缀，正文原样（纯文本，不转义为 HTML）。`sanitizeFileName(title): string` — 去路径分隔符与控制字符，供写盘名用。

- [ ] **Step 1: 写失败测试**：

```ts
import { describe, expect, it } from 'vitest';
import { toMarkdown, sanitizeFileName } from '../../src/main/archive/export';
import type { ArchivedSession } from '../../src/main/archive/store';

const s: ArchivedSession = { id: 'a', title: '测试/会话: 1', updatedAt: 1, messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你**好**' }] };

describe('toMarkdown', () => {
  it('含标题与按角色前缀的消息，正文不被当 HTML', () => {
    const md = toMarkdown(s);
    expect(md).toContain('# 测试/会话: 1');
    expect(md).toContain('**你**');
    expect(md).toContain('**DeepSeek**');
    expect(md).toContain('你**好**');
  });
});
describe('sanitizeFileName', () => {
  it('去掉路径分隔与非法字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e')).not.toMatch(/[\\/\\:*?"<>|]/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/main/archive/export.ts`**：

```ts
import type { ArchivedSession } from './store';

export function sanitizeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'session';
}

export function toMarkdown(session: ArchivedSession): string {
  const lines = [`# ${session.title}`, ''];
  for (const m of session.messages) lines.push(`**${m.role === 'user' ? '你' : 'DeepSeek'}**`, '', m.text, '');
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过** → 全绿。
- [ ] **Step 5: 提交** — `git commit -m "feat: 归档会话转 Markdown 导出"`

---

### Task 5: 搜索面板（本地窗口 + 查询 IPC）

**Files:** Create `src/main/search.ts`, `src/renderer/search/index.html`, `src/renderer/search/search.css`, `src/renderer/search/search.js`, `src/preload/search.ts`; Modify `src/shared/ipc.ts`, `scripts/build.mjs`; Test `tests/e2e/archive.spec.ts`

**Interfaces:**
- Consumes: `ArchiveStore.list()`（Task 3）、`IPC`
- Produces: `IPC.SEARCH_QUERY = 'shell:search-query'`（`ipcMain.handle`，入参 `{ query: string }`，返回 `Array<{id,title,updatedAt}>` 按标题/正文子串过滤）。`openSearchWindow(store)`：创建 `persist:shell` 窗口加载 `out/renderer/search/index.html`，注册 `ipcMain.handle(SEARCH_QUERY)`。`closeSearchWindow()`。

- [ ] **Step 1: 加 IPC 通道** — `src/shared/ipc.ts` 的 `IPC` 增加 `SEARCH_QUERY: 'shell:search-query'` 与 `SEARCH_JUMP: 'shell:search-jump'`、`JUMP_TO_SESSION: 'shell:jump-to-session'`。
- [ ] **Step 2: 加 search preload 构建入口** — `scripts/build.mjs` 仿 overlay 入口新增 `src/preload/search.ts` → `out/preload/search.js`（`platform:'browser'`, `format:'cjs'`, `external:['electron']`）。
- [ ] **Step 3: `src/preload/search.ts`**：

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
contextBridge.exposeInMainWorld('searchApi', {
  query: (q: string) => ipcRenderer.invoke(IPC.SEARCH_QUERY, { query: q }),
  jump: (title: string) => ipcRenderer.send(IPC.SEARCH_JUMP, { title }),
});
```
- [ ] **Step 4: `src/main/search.ts`**：

```ts
import { BrowserWindow, app, ipcMain } from 'electron';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import type { ArchiveStore } from './archive/store';

let win: BrowserWindow | null = null;
export function openSearchWindow(store: ArchiveStore, onJump: (title: string) => void): void {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 520, height: 420, title: '搜索会话', show: false,
    webPreferences: { partition: 'persist:shell', preload: path.join(app.getAppPath(), 'out/preload/search.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  ipcMain.removeHandler(IPC.SEARCH_QUERY);
  ipcMain.handle(IPC.SEARCH_QUERY, (_e, arg: unknown) => {
    const query = typeof (arg as { query?: unknown })?.query === 'string' ? (arg as { query: string }).query.trim().toLowerCase() : '';
    const items = store.list().sort((a, b) => b.updatedAt - a.updatedAt);
    return query ? items.filter(i => i.title.toLowerCase().includes(query)) : items.slice(0, 50);
  });
  ipcMain.removeAllListeners(IPC.SEARCH_JUMP);
  ipcMain.on(IPC.SEARCH_JUMP, (e, arg: unknown) => {
    if (e.sender.id !== win?.webContents.id) return;
    const title = typeof (arg as { title?: unknown })?.title === 'string' ? (arg as { title: string }).title : '';
    if (title) onJump(title);
  });
  win.on('closed', () => { win = null; });
  void win.loadFile(path.join(app.getAppPath(), 'out/renderer/search/index.html'));
  win.once('ready-to-show', () => { win?.show(); win?.focus(); });
}
export function closeSearchWindow(): void { if (win && !win.isDestroyed()) win.close(); win = null; }
```
- [ ] **Step 5: 渲染层** — `src/renderer/search/index.html`（CSP `default-src 'none'; style-src 'self'; script-src 'self'`，一个输入框 + 结果列表 `<ul id="results">`）、`search.css`（沿用官方中性浅灰 + `#4d6bfe` 强调，无投影）、`search.js`（输入防抖 200ms 调 `window.searchApi.query`，渲染 `li`，点击项调 `window.searchApi.jump(title)` 并 `window.close()`）。三文件内容按此职责写实，不留 TODO。
- [ ] **Step 6: e2e** — `tests/e2e/archive.spec.ts`：`openSearchWindow` 后向 `SEARCH_QUERY` invoke 一个已归档标题，断言返回含该项。（用测试钩子或直接 `app.evaluate` 建 store + 开窗。）
- [ ] **Step 7: 跑 `pnpm build && pnpm test:e2e tests/e2e/archive.spec.ts`** → 通过；`pnpm typecheck` 干净。
- [ ] **Step 8: 提交** — `git commit -m "feat: 本地搜索面板窗口与归档查询 IPC（persist:shell 隔离）"`

---

### Task 6: 侧边栏按标题定位跳转

**Files:** Modify `src/preload/observer.ts`（新增 `clickSessionByTitle`）, `src/preload/deepseek.ts`（监听 JUMP_TO_SESSION）; Test `tests/unit/observer-conversation.test.ts`（追加）

**Interfaces:**
- Consumes: `SELECTORS.sessionItem`、`SELECTORS.sessionItemTitle`
- Produces: `clickSessionByTitle(doc, title): boolean` — 在会话条目里找标题（折叠空白、忽略大小写）等于 `title` 的 `<a>`，`.click()` 并返回是否命中。`deepseek.ts` 监听 `IPC.JUMP_TO_SESSION` 调用它。

- [ ] **Step 1: 追加失败测试**：

```ts
import { clickSessionByTitle } from '../../src/preload/observer';
describe('clickSessionByTitle', () => {
  it('命中存在标题返回 true，不存在返回 false', () => {
    const d = doc('logged-in.html');
    const first = d.querySelector('a[href*="/a/chat/s/"] .ds-focus-ring + div')?.textContent?.trim() ?? '';
    expect(clickSessionByTitle(d, first)).toBe(true);
    expect(clickSessionByTitle(d, '__不存在__的标题')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `clickSessionByTitle`（`src/preload/observer.ts`）**：

```ts
export function clickSessionByTitle(doc: Document, title: string): boolean {
  const want = title.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return false;
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(SELECTORS.sessionItem))) {
    const t = (a.querySelector(SELECTORS.sessionItemTitle.replace(/^a\[href[^]]*\]\s*/, ''))?.textContent ?? a.textContent ?? '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    if (t === want) { a.click(); return true; }
  }
  return false;
}
```
`src/preload/deepseek.ts` 加：`ipcRenderer.on(IPC.JUMP_TO_SESSION, (_e, arg) => { const title = (arg as {title?:string})?.title; if (title) clickSessionByTitle(document, title); });`（import `clickSessionByTitle`）。
- [ ] **Step 4: 跑测试与构建** → `pnpm test tests/unit/observer-conversation.test.ts && pnpm typecheck && pnpm build` 全绿。
- [ ] **Step 5: 提交** — `git commit -m "feat: 侧边栏按标题定位并点击跳转，不猜造会话 URL"`

---

### Task 7: 装配（归档接线 + Ctrl+K 搜索 + 跳转接线 + fixture 脚本）

**Files:** Modify `src/main/index.ts`; Create `scripts/capture-fixture.mjs`; Test `tests/e2e/search-jump.spec.ts`

**Interfaces:**
- Consumes: `createArchiveStore`、`openSearchWindow`、`IPC.JUMP_TO_SESSION`、`registerPageEvents`、`getShellWindow`
- Produces: 端到端 M3。`onEvent` 把 `conversation-updated` 喂给 store；`Ctrl/Cmd+K`（shell 窗口 `before-input-event`）开搜索窗；搜索选中 → `onJump(title)` → `getShellWindow().webContents.send(JUMP_TO_SESSION,{title})` 并唤起窗口。

- [ ] **Step 1: 装配 index.ts（whenReady 内，createShellWindow 之后）**：

```ts
import { createArchiveStore } from './archive/store';
import { openSearchWindow } from './search';
import { IPC as SHARED_IPC } from '../shared/ipc';

const archive = createArchiveStore(userDataDir());
registerPageEvents({
  expectedWebContentsId: () => getShellWindow()?.webContents.id ?? -1,
  onEvent: (e) => {
    notifier(e);
    if (e.type === 'conversation-updated') archive.upsert(e);
  },
  onDegraded: () => { if (!degradedLatched) { degradedLatched = true; tray?.set({ degraded: true, unread: 0 }); } },
});
const jumpToSession = (title: string) => { showOrFocusShell(); getShellWindow()?.webContents.send(SHARED_IPC.JUMP_TO_SESSION, { title }); };
```
在 shell 窗口 `webContents` 上：`getShellWindow()?.webContents.on('before-input-event', (_e, input) => { if (input.type==='keyDown' && (input.control||input.meta) && !input.alt && input.key.toLowerCase()==='k'){ _e.preventDefault(); openSearchWindow(archive, jumpToSession); } });`
（`registerPageEvents` 在 M2 已存在，这里合并 `conversation-updated` 分支，不要重复注册。）
- [ ] **Step 2: `scripts/capture-fixture.mjs`** — 复用 spike 的 probe 思路：启动一个 `persist:deepseek` 窗口，`Ctrl+S` 或首次快照把 `document.documentElement.outerHTML` 写到 `tests/fixtures/logged-in.html`（带覆盖确认）。脚本自述用法，一次性工具，允许 `sandbox:false`。
- [ ] **Step 3: e2e `tests/e2e/search-jump.spec.ts`** — 用本地 fixture 页（含会话 `<a>`）加载 shell，`openSearchWindow` 后触发 jump 到某标题，断言该 `<a>` 被点击（页内 `onclick` 记录到 `document.title`）。
- [ ] **Step 4: 全量验证** — `pnpm typecheck && pnpm test && pnpm test:e2e` 全绿。
- [ ] **Step 5: 手动验收** — `pnpm dev`：登录后聊几句 → 归档目录 `userData/archive/*.json` 出现；`Ctrl+K` 开搜索、命中会话、点击 → 窗口唤起并跳到该会话；导出当前会话为 `.md` 可读（spec §15.6、§15.7）。
- [ ] **Step 6: 提交** — `git commit -m "feat: 装配 M3——归档落盘、Ctrl+K 搜索、按标题跳转、fixture 抓取脚本"`

---

## Plan 3 结束后的自检

- [ ] `pnpm typecheck && pnpm test && pnpm test:e2e` 全绿
- [ ] 归档 store 单测覆盖：合并、原子写、损坏回滚、上限淘汰
- [ ] 搜索命中已归档会话并跳转（§15.6）、导出 Markdown 可读（§15.7）手动过
- [ ] 无任何向 DeepSeek 内部接口发请求的代码；搜索窗口走 `persist:shell` 不碰登录态
- [ ] 记录 Plan 4/M4 待办：降级双向恢复、logout 误降级修复、fileInject 触发器、dispose 接线

## Plan 4 范围（本计划不实现）

M4 打磨与降级恢复：observer 双向 re-enable、logout 不误降级（`auth-state-changed(false)` 在空检查前发）、`registerPageEvents.dispose()` 接线、fileInject 触发器与 cap 组合校验、>500 会话截断、验收清单全量跑通。
