# ds-shell V1 Plan 4：健壮性与降级恢复（M4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收口 M1–M3 各轮审查累积的健壮性缺口，让壳在改版/登出/窗口重建等异常路径下既不弄坏聊天、又能自我恢复，并把 fileInject 接上触发器——完成 spec §8 降级表与 §15.8 验收。

**Architecture:** 三层不变。observer 的降级从"单向闩"改为"可恢复"（探到好轮即复位），并把 `auth-state-changed` 提到空判定之前使登出通知能从真实 DOM 触发；主进程在窗口 `did-navigate`/恢复信号时清托盘降级态；`registerPageEvents` 的 disposer 与搜索窗在退出时统一回收；fileInject 用应用内 `Ctrl+O`（与已落地的 Ctrl+K/Ctrl+E 同机制，避开冻结的三项托盘契约）。

**Tech Stack:** Electron 44、TypeScript strict、esbuild、Vitest + jsdom、@playwright/test `_electron`、zod。

**Spec:** [docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md](file:///D:/Study/programs/deepseek-client/docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md)

## Global Constraints

- 红线不变：只读已渲染 DOM、不请求内部接口、归档只落本地、剪贴板仅显式快捷键读、远端文本一律不可信（zod 上界、纯文本、不作 HTML/路径）。
- §8 核心原则"壳绝不能弄坏聊天"：任何 observer/主进程异常都不得冒泡杀死进程或干扰页面。
- 降级可视化只走托盘 tooltip，不弹窗；恢复也要能从降级态回到正常态。
- 分区/安全配置不变（远端 persist:deepseek、本地 persist:shell、contextIsolation/sandbox 全开）。
- TypeScript strict（noUncheckedIndexedAccess/exactOptionalPropertyTypes）；每任务一次提交说明"为什么"；沙箱 preload CJS + electron external。
- 不新增全局快捷键、不改托盘三项契约（Plan 1 冻结）；新触发一律用 shell 窗口的 `before-input-event`。

---

## File Structure（改动面）

```
src/preload/observer.ts        （改）auth 提前发；降级可恢复；>500 截断 + 共享上限常量
src/shared/pageEvent.ts        （改）导出 SESSION_LIST_MAX / CONVERSATION_EMIT_MAX 常量；加 jumpPayloadSchema
src/main/index.ts              （改）degradedLatched 可复位；did-navigate 清降级；dispose 接线；jump-after-load 竞态；Ctrl+O 文件注入
src/main/pageEvents.ts         （改）暴露/使用 disposer；OBSERVER_DEGRADED 幂等已在 M2
src/main/search.ts             （改）导出 closeSearchWindow 供退出调用（已存在，接上）
src/main/fileInject.ts         （改）prepareFileInject 用字节校验 + 产 payload 前对 injectTextSchema 自检
src/preload/deepseek.ts        （改）JUMP_TO_SESSION 走 jumpPayloadSchema 校验
scripts/build.mjs              （不变）
tests/unit/observer.test.ts    （改/加）auth 顺序、可恢复降级、>500 截断
tests/unit/fileInject.test.ts  （改）字节上限组合校验
tests/unit/pageEvent.test.ts   （加）jumpPayloadSchema
tests/e2e/recovery.spec.ts     （新）降级→恢复→登出通知 的真实 DOM 路径
```

---

### Task 1: observer——登出通知真实触发 + 共享上限常量

**Files:** Modify `src/preload/observer.ts`, `src/shared/pageEvent.ts`; Test `tests/unit/observer.test.ts`

**Interfaces:**
- Consumes: `extractSessions`、`extractSignedIn`
- Produces: `tick()` 先发 `auth-state-changed`（含 signedIn:false）再做"空轮→降级"判定；`pageEvent.ts` 导出 `SESSION_LIST_MAX=500`、`CONVERSATION_EMIT_MAX=200` 供 observer 与 schema 共用。

- [ ] **Step 1: 写失败测试**（`tests/unit/observer.test.ts` 追加）：

```ts
import { createObserver } from '../../src/preload/observer';
import { JSDOM } from 'jsdom';
import type { PageEvent } from '../../src/shared/pageEvent';

const html = (body: string) => new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: 'https://chat.deepseek.com/' }).window.document;
const SIGNED_IN = `<textarea></textarea><a href="/a/chat/s/abc"><div class="ds-focus-ring"></div><div>t</div></a>`;

it('登出（曾登录→空页）先发 auth-state-changed(false) 再降级', () => {
  const d = html(SIGNED_IN);
  const ev: PageEvent[] = [];
  const o = createObserver({ doc: d, emit: e => ev.push(e), degradeThreshold: 1 });
  o.tick(); // 登录态：auth(true)+session-list
  ev.length = 0;
  d.body.innerHTML = ''; // 模拟登出：无 textarea、无会话
  o.tick();
  expect(ev.some(e => e.type === 'auth-state-changed' && (e as { signedIn: boolean }).signedIn === false)).toBe(true);
});

it('>500 会话被截断到 500', () => {
  const many = Array.from({ length: 600 }, (_, i) => `<a href="/a/chat/s/s${i}"><div class="ds-focus-ring"></div><div>t${i}</div></a>`).join('');
  const ev: PageEvent[] = [];
  createObserver({ doc: html(`<textarea></textarea>${many}`), emit: e => ev.push(e) }).tick();
  const list = ev.find(e => e.type === 'session-list-changed') as { sessions: unknown[] } | undefined;
  expect(list?.sessions).toHaveLength(500);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（auth 顺序错、无截断）。
- [ ] **Step 3: 改 `pageEvent.ts`**：把 `conversationUpdatedSchema` 的 `.max(200)` 与 `session-list-changed` 的 `.max(500)` 改用导出的常量：

```ts
export const SESSION_LIST_MAX = 500;
export const CONVERSATION_EMIT_MAX = 200;
```
`session-list-changed` 用 `.max(SESSION_LIST_MAX)`，`conversationUpdatedSchema.messages` 用 `.max(CONVERSATION_EMIT_MAX)`。
- [ ] **Step 4: 改 `observer.ts` `tick()`**：先算 signedIn 并在变化时 emit auth（含 false），再做降级判定；会话列表 emit 前 `.slice(0, SESSION_LIST_MAX)`：

```ts
tick() {
  const sessions = extractSessions(doc);
  const signedIn = extractSignedIn(doc);
  // auth 变化先报（登出 signedIn:false 必须在"空轮降级"早返回之前发出，否则真实登出页永不触发通知）。
  if (signedIn !== lastSignedIn) {
    lastSignedIn = signedIn;
    emit({ type: 'auth-state-changed', signedIn });
  }
  if (!sessions.length && !signedIn) {
    if (++emptyRounds >= threshold) degraded = true;
    return;
  }
  emptyRounds = 0;
  if (degraded) degraded = false; // 探到好轮即恢复（见 Task 2 主进程侧配套）
  const capped = sessions.slice(0, SESSION_LIST_MAX);
  const key = capped.map(s => `${s.id}\u0000${s.title}`).join('\u0001');
  if (key !== lastSessionKey) {
    lastSessionKey = key;
    emit({ type: 'session-list-changed', sessions: capped });
  }
},
```
删除文件顶部的本地 `const CONVERSATION_EMIT_MAX = 200;`，改从 `../shared/pageEvent` import（`conversationUpdated` 里 `.slice(-CONVERSATION_EMIT_MAX)` 继续用）。注意 `degraded` 早返回：把 `if (degraded) return;` 从 tick 首行移除（改为在降级态仍探测、但 answerCompleted/conversationUpdated 仍各自 `if (degraded) return`）。
- [ ] **Step 5: 跑测试确认通过** → `pnpm test tests/unit/observer.test.ts && pnpm typecheck` 全绿。
- [ ] **Step 6: 提交** — `git commit -m "fix: observer 登出通知先于降级判定发出，会话列表按共享上限截断"`

---

### Task 2: 降级双向恢复（observer 已复位 + 主进程清托盘）

**Files:** Modify `src/main/index.ts`; Test `tests/e2e/recovery.spec.ts`

**Interfaces:**
- Consumes: observer 恢复（Task 1 已在好轮把 `degraded` 复位）、`tray.set`、`getShellWindow`
- Produces: 主进程 `degradedLatched` 可复位——收到新的 `PAGE_EVENT`（说明 observer 又在工作）或窗口 `did-navigate` 时，把 `degradedLatched=false` 且 `tray.set({degraded:false, unread:0})`。`OBSERVER_DEGRADED` 仍幂等置位。

- [ ] **Step 1: 改 `index.ts`**：`onEvent` 顶部加恢复；`onDegraded` 保持幂等；shell 窗口 `did-navigate` 复位：

```ts
let degradedLatched = false;
const clearDegraded = () => { if (degradedLatched) { degradedLatched = false; tray?.set({ degraded: false, unread: 0 }); } };
// onEvent: (e) => { clearDegraded(); notifier(e); ... }   // 有任何上报即视为已恢复
// onDegraded: () => { if (!degradedLatched) { degradedLatched = true; tray?.set({ degraded: true, unread: 0 }); } }
// createShellWindow 之后：getShellWindow()?.webContents.on('did-navigate', clearDegraded);
```
- [ ] **Step 2: 写 e2e `tests/e2e/recovery.spec.ts`**：加载登录 fixture → 断言无降级；把页面置空触发 OBSERVER_DEGRADED → 断言 `degradedLatched`（经测试钩子暴露的 `isDegraded()`）为 true；再注入会话 DOM 触发一次 PAGE_EVENT → 断言恢复为 false。测试钩子 `__dsShellTestHooks` 增 `isDegraded: () => degradedLatched`。
- [ ] **Step 3: 跑** `pnpm typecheck && pnpm test:e2e tests/e2e/recovery.spec.ts` → 通过。
- [ ] **Step 4: 提交** — `git commit -m "feat: 降级可恢复——observer 好轮复位、主进程清托盘降级态"`

---

### Task 3: 生命周期收尾（pageEvents dispose + 退出关搜索窗 + 跳转竞态）

**Files:** Modify `src/main/index.ts`, `src/main/pageEvents.ts`; Test `tests/e2e/recovery.spec.ts`（追加）

**Interfaces:**
- Consumes: `registerPageEvents` 返回的 `{ dispose }`、`closeSearchWindow`
- Produces: `index.ts` 保存 `const pageEvents = registerPageEvents(...)`，在 `will-quit` 里 `pageEvents.dispose()`（与 `hotkeys.dispose()`、`tray.destroy()` 同处，try/finally 隔离）；`will-quit` 里 `closeSearchWindow()`；`jumpToSession` 在窗口刚重建（webContents 尚未就绪）时把注入延到 `did-finish-load` 一次，避免发给没有 preload 监听的新帧。

- [ ] **Step 1: 改 `index.ts`**：`registerPageEvents` 的返回存下来；will-quit 追加 dispose + closeSearchWindow；jumpToSession 竞态：

```ts
const jumpToSession = (title: string): void => {
  showOrFocusShell();
  const wc = getShellWindow()?.webContents;
  if (!wc) return;
  const send = () => wc.send(IPC.JUMP_TO_SESSION, { title });
  if (wc.isLoading()) wc.once('did-finish-load', send); else send();
  closeSearchWindow();
};
// will-quit: try { hotkeys.dispose(); } finally { pageEvents.dispose(); closeSearchWindow(); tray?.destroy(); }
```
- [ ] **Step 2: 加测**：e2e 里退出前 `will-quit` 不抛（dispose 幂等），`pageEvents.dispose` 后再来 PAGE_EVENT 不被处理（可选，若难测则至少断言 dispose 被调用不崩）。
- [ ] **Step 3: 跑** `pnpm typecheck && pnpm test && pnpm test:e2e` → 全绿。
- [ ] **Step 4: 提交** — `git commit -m "fix: 退出回收 pageEvents/搜索窗，跳转在窗口重建后等就绪再发"`

---

### Task 4: fileInject 触发器（Ctrl+O）+ 字节组合校验 + JUMP zod

**Files:** Modify `src/main/fileInject.ts`, `src/main/index.ts`, `src/preload/deepseek.ts`, `src/shared/pageEvent.ts`; Test `tests/unit/fileInject.test.ts`, `tests/unit/pageEvent.test.ts`

**Interfaces:**
- Consumes: `prepareFileInject`（Plan 2）、`performQuickAsk` 的注入投递、`dialog.showOpenDialog`
- Produces:
  - `pageEvent.ts`：`jumpPayloadSchema = z.object({ title: z.string().min(1).max(200) })`。
  - `fileInject.ts`：`prepareFileInject` 产 payload 前用 `Buffer.byteLength(payload,'utf8') <= 512*1024` 且 `injectTextSchema.safeParse({text:payload}).success` 双检，超返 `{ok:false, reason:'too-large'}`。
  - `index.ts`：`before-input-event` 加 `Ctrl/Cmd+O` → `dialog.showOpenDialog({ properties:['openFile'], filters:[{name:'文本',extensions:['txt','md','json','csv','log','ts','js','py',...]}] })` → `prepareFileInject` → ok 则 `webContents.send(IPC.INJECT_TEXT,{text:payload})` 并 `showOrFocusShell()`，too-large 则通知"文件过大，请改用拖放"。
  - `deepseek.ts`：`JUMP_TO_SESSION` 用 `jumpPayloadSchema.safeParse` 取代 `typeof` 手判。

- [ ] **Step 1: 写失败测试**：`fileInject.test.ts` 加"文件内容 + 引用块开销 使 payload 超 512KB → too-large"（用 524288 字节 ASCII 文件，prepareFileInject 应因 payload>injectTextSchema 上限而拒）；`pageEvent.test.ts` 加 `jumpPayloadSchema` 接受 `{title:'x'}`、拒 `{title:''}` 与非字符串。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现**（pageEvent.ts 加 jumpPayloadSchema；fileInject.ts 加双检；index.ts 加 Ctrl+O 分支；deepseek.ts 换 jumpPayloadSchema）。fileInject 关键：

```ts
export function prepareFileInject(filePath: string): { ok: true; payload: string } | { ok: false; reason: string } {
  const r = readTextFileCapped(filePath);
  if (!r.ok) return { ok: false, reason: r.reason };
  const payload = buildQuoteBlock(path.basename(filePath), r.text);
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) return { ok: false, reason: 'too-large' };
  if (!injectTextSchema.safeParse({ text: payload }).success) return { ok: false, reason: 'too-large' };
  return { ok: true, payload };
}
```
- [ ] **Step 4: 跑测试与 e2e** → `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e tests/e2e/inject.spec.ts` 全绿。
- [ ] **Step 5: 提交** — `git commit -m "feat: Ctrl+O 本地文本文件注入 + 字节组合校验；JUMP 走 zod 校验"`

---

### Task 5: e2e flake 加固 + 全量收口

**Files:** Modify `tests/e2e/search-jump.spec.ts`, `tests/e2e/archive.spec.ts`
- [ ] **Step 1:** 把 file:// / http fixture 的等待从裸 `poll>0` 加固为：先 `waitForFunction` 等 `a[href*="/a/chat/s/"]` 且 `document.querySelector('textarea')` 就绪，超时提到 20s，失败信息带 `did-fail-load`（用 `webContents.on('did-fail-load')` 收集）。
- [ ] **Step 2:** 连跑 `pnpm test:e2e` 三次，确认无 flake；记录每次计数。
- [ ] **Step 3:** 提交 `test: 加固 file/http fixture 等待，消除 search-jump flake`。

---

## Plan 4 结束后的自检
- [ ] `pnpm typecheck && pnpm test && pnpm test:e2e` 连跑全绿、无 flake
- [ ] §15.8：模拟选择器失效→degraded 上托盘→恢复→降级态清除，聊天全程无恙
- [ ] 真实登出能触发"登录已过期"通知（Task 1 顺序修复）
- [ ] fileInject 有 Ctrl+O 触发且超限有反馈；JUMP/INJECT 全部 zod 校验
- [ ] 退出回收 pageEvents + 搜索窗 + 托盘，无幽灵图标/悬空窗
- [ ] 红线复核：无内部接口请求、无新全局快捷键、托盘仍三项

## 后续（非本计划）
portable 打包（待安全软件白名单）、GitHub 推送（待网络）、spec §15 全量手动验收清单。
