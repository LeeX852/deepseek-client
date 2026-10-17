# ds-shell V1 Plan 2：事件与增强（M2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 1 的基础壳之上，打通"远端 DOM → 归一化页面事件 → 主进程分发 → 系统通知 / 注入"这条增强管线：会话列表与回答完成可被观察、窗口未聚焦时收到节流的系统通知、划词与本地文本文件能注入到 DeepSeek 输入框；选择器连续失效时 observer 自我禁用、聊天本身不受影响。

**Architecture:** 三层不变。`src/preload/observer.ts` 是纯 DOM 逻辑（接收 `Document`，产出归一化事件），可在 jsdom 下脱离 Electron 单测；`src/preload/deepseek.ts` 只做 Electron 胶水（`ipcRenderer`、`MutationObserver`、`contextBridge`、注入执行）。主进程 `pageEvents.ts` 是远端上报的唯一入口，校验发送方与 zod 负载后分发；`notifications.ts` / `quickAsk.ts` / `fileInject.ts` 各管一件事。所有跨进程负载走 `src/shared/*` 的 zod schema。

**Tech Stack:** Electron 44、TypeScript strict（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）、esbuild（main 与 preload 打包为 CJS）、Vitest + jsdom（纯逻辑与 observer 单测）、@playwright/test 的 `_electron`（IPC 往返与注入 e2e）、zod（跨进程负载）。

**Spec:** [docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md](file:///D:/Study/programs/deepseek-client/docs/superpowers/specs/2026-10-16-deepseek-desktop-shell-design.md)

**M0 依据：** 见 [spike/m0/REPORT.md](file:///D:/Study/programs/deepseek-client/spike/m0/REPORT.md) 与 [src/preload/selectors.ts](file:///D:/Study/programs/deepseek-client/src/preload/selectors.ts)。五项风险全部通过；稳定钩子为 `ds-*` 设计系统类 + `a[href*="/a/chat/s/"]` URL 结构；React 受控输入框接受"原生 value setter + `input` 事件"写入（`persisted=true`）；合成 `paste` 带 File 能被页面接收。

## Global Constraints

每条来自 spec，每个任务都隐含遵守：

- 红线：绝不以脚本方式向 DeepSeek 内部接口发请求；不做并发自动化；归档数据只落本地 `userData`、无遥测；剪贴板只在用户显式按快捷键时读取，不做后台轮询。
- 不可信输入：远端页面文本一律视为数据，不作为 HTML 渲染、不拼成命令、不做文件路径；跨进程负载必须过 zod 且带长度/条数上界。
- 远端窗口 `webPreferences` 维持 Plan 1：`contextIsolation`/`sandbox`/`webSecurity` 全开、`nodeIntegration` 关；分区 `persist:deepseek`；本地窗口 `persist:shell`。
- observer 连续 3 轮全部选择器失效 → 自我禁用，发 `OBSERVER_DEGRADED`，托盘 tooltip 提示一次，不弹窗；**壳绝不能弄坏聊天**。
- 通知节流：同一会话 30 秒内不重复；全局每分钟最多 3 条。文本文件注入单文件上限 512KB，超限提示改用拖放。
- TypeScript：`strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`；测试与被测同目录树不同根（`tests/unit`、`tests/e2e`）。
- 提交频率：每个任务一次提交，提交信息说明"为什么"。
- 沙箱 preload 必须是 CJS 且 `require('electron')` 保持 external（见 `scripts/build.mjs`）。

---

## File Structure（Plan 2 结束后应有形态）

```
src/shared/pageEvent.ts        （改）新增 injectTextSchema + 导出类型
src/shared/ipc.ts              （改）新增 INJECT_TEXT 负载类型注释；通道名沿用
src/preload/observer.ts        （新）纯 DOM→事件归一化 + 降级判定，可 jsdom 单测
src/preload/deepseek.ts        （改）Electron 胶水：MutationObserver 驱动 observer、
                                ipcRenderer 上报、监听 INJECT_TEXT 执行注入
src/main/pageEvents.ts         （新）远端上报唯一入口：发送方 + schema 校验后分发
src/main/notifications.ts      （新）answer-completed / auth 过期 → 节流系统通知
src/main/quickAsk.ts           （新）划词/截图提问：读剪贴板 → 投递 INJECT_TEXT
src/main/fileInject.ts         （新）选本地文本文件 → 限大小校验 → 引用块 → 投递
src/main/index.ts              （改）装配 pageEvents/notifications/quickAsk，接上快捷键
tests/unit/observer.test.ts            jsdom 对真实 fixture 断言提取结果
tests/unit/pageEvents.test.ts          发送方与负载校验
tests/unit/notifications.test.ts       节流窗口逻辑
tests/unit/quickAsk.test.ts            剪贴板→注入请求转换（mock IO）
tests/unit/fileInject.test.ts          大小/编码校验 + 引用块拼装
tests/e2e/page-events.spec.ts          preload→主进程 IPC 往返 + 降级
tests/e2e/inject.spec.ts               INJECT_TEXT 写入本地受控输入框
```

---

### Task 1: 注入负载 schema 与共享类型

**Files:**
- Modify: `src/shared/pageEvent.ts`
- Test: `tests/unit/pageEvent.test.ts`（追加用例）

**Interfaces:**
- Consumes: 无
- Produces: `injectTextSchema`（zod）、`InjectText = z.infer<typeof injectTextSchema>`。Task 5/6/7 依赖它约束主进程投递给 preload 的文本。上界 512KB（`524_288`）与 spec 的文本文件注入上限一致。

- [ ] **Step 1: 追加失败测试**

在 `tests/unit/pageEvent.test.ts` 末尾追加：

```ts
import { injectTextSchema } from '../../src/shared/pageEvent';

describe('injectTextSchema', () => {
  it('接受普通文本', () => {
    expect(injectTextSchema.safeParse({ text: '选中的文字' }).success).toBe(true);
  });
  it('拒绝空文本', () => {
    expect(injectTextSchema.safeParse({ text: '' }).success).toBe(false);
  });
  it('拒绝超过 512KB 的文本（与文件注入上限一致）', () => {
    expect(injectTextSchema.safeParse({ text: 'x'.repeat(524_289) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/unit/pageEvent.test.ts` → Expected: FAIL，`injectTextSchema` 未导出。

- [ ] **Step 3: 实现**

在 `src/shared/pageEvent.ts` 末尾追加：

```ts
export const injectTextSchema = z.object({
  text: z.string().min(1).max(524_288),
});

export type InjectText = z.infer<typeof injectTextSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/unit/pageEvent.test.ts` → Expected: 全部 passed。

- [ ] **Step 5: 提交**

```bash
git add src/shared/pageEvent.ts tests/unit/pageEvent.test.ts
git commit -m "feat: 注入负载 injectTextSchema，与文件注入 512KB 上界对齐"
```

---

### Task 2: 纯 DOM observer（提取 + 降级判定）

**Files:**
- Create: `src/preload/observer.ts`
- Test: `tests/unit/observer.test.ts`

**Interfaces:**
- Consumes: `SELECTORS`（`src/preload/selectors.ts`）、`PageEvent`/`sessionListItemSchema`（`src/shared/pageEvent.ts`）
- Produces:
  - `extractSessions(doc: Document): Array<{ id: string; title: string }>`
  - `extractSignedIn(doc: Document): boolean`
  - `extractLatestAnswerPreview(doc: Document): string | null`
  - `createObserver(opts: { doc: Document; emit(e: PageEvent): void; degradeThreshold?: number }): { tick(): void; isDegraded(): boolean }`
  observer 每 `tick()` 比对上一次快照，产出 `session-list-changed` / `answer-completed` / `auth-state-changed`；连续 `degradeThreshold`（默认 3）轮 `extractSessions` 与 `extractSignedIn` 全空则 `isDegraded()` 转 true 并停止产出。

- [ ] **Step 1: 写失败测试**

`tests/unit/observer.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractSessions, extractSignedIn, extractLatestAnswerPreview, createObserver } from '../../src/preload/observer';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const doc = (f: string) => new JSDOM(readFileSync(path.join(dir, f), 'utf8')).window.document;

describe('extractSessions', () => {
  it('从登录态 fixture 提取会话，id 来自 href、title 来自标题节点', () => {
    const sessions = extractSessions(doc('logged-in.html'));
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions[0]!.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(sessions[0]!.title.length).toBeGreaterThan(0);
  });
  it('未登录 fixture 提取不到会话', () => {
    expect(extractSessions(doc('signed-out.html'))).toEqual([]);
  });
});

describe('extractSignedIn', () => {
  it('登录态为 true、未登录为 false', () => {
    expect(extractSignedIn(doc('logged-in.html'))).toBe(true);
    expect(extractSignedIn(doc('signed-out.html'))).toBe(false);
  });
});

describe('createObserver', () => {
  it('首轮 emit session-list-changed 与 auth-state-changed(true)', () => {
    const emit = vi.fn();
    createObserver({ doc: doc('logged-in.html'), emit }).tick();
    const types = emit.mock.calls.map(c => (c[0] as { type: string }).type);
    expect(types).toContain('session-list-changed');
    expect(types).toContain('auth-state-changed');
  });
  it('会话列表未变时不重复 emit session-list-changed', () => {
    const emit = vi.fn();
    const o = createObserver({ doc: doc('logged-in.html'), emit });
    o.tick(); emit.mockClear(); o.tick();
    expect(emit.mock.calls.map(c => (c[0] as { type: string }).type)).not.toContain('session-list-changed');
  });
  it('连续 3 轮全空则降级并停发', () => {
    const emit = vi.fn();
    const d = doc('signed-out.html'); // 无会话、无登录标志
    const o = createObserver({ doc: d, emit, degradeThreshold: 3 });
    o.tick(); o.tick(); o.tick();
    expect(o.isDegraded()).toBe(true);
    emit.mockClear(); o.tick();
    expect(emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/unit/observer.test.ts` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/preload/observer.ts`**

```ts
import { SELECTORS } from './selectors';
import type { PageEvent } from '../shared/pageEvent';

const idFromHref = (href: string): string | null => {
  const m = href.match(/\/a\/chat\/s\/([A-Za-z0-9_-]{1,64})/);
  return m ? m[1]! : null;
};

export function extractSessions(doc: Document): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(SELECTORS.sessionItem))) {
    const id = a.href ? idFromHref(a.href) : null;
    if (!id) continue;
    const titleEl = a.querySelector(SELECTORS.sessionItemTitle.replace(/^a\[href[^]]*\]\s*/, '')) ?? a;
    const title = (titleEl.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    out.push({ id, title });
  }
  return out;
}

export function extractSignedIn(doc: Document): boolean {
  return !!doc.querySelector(SELECTORS.signedInMarker);
}

export function extractLatestAnswerPreview(doc: Document): string | null {
  const list = doc.querySelectorAll(SELECTORS.messageItem);
  const last = list[list.length - 1];
  if (!last) return null;
  const content = last.querySelector(SELECTORS.assistantMessage) ?? last;
  const text = (content.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : null;
}

export function createObserver(opts: {
  doc: Document;
  emit(e: PageEvent): void;
  degradeThreshold?: number;
}) {
  const { doc, emit } = opts;
  const threshold = opts.degradeThreshold ?? 3;
  let lastSessionKey = '';
  let lastSignedIn: boolean | null = null;
  let lastAnswerPreview: string | null = null;
  let emptyRounds = 0;
  let degraded = false;

  return {
    isDegraded: () => degraded,
    tick() {
      if (degraded) return;
      const sessions = extractSessions(doc);
      const signedIn = extractSignedIn(doc);
      if (!sessions.length && !signedIn) {
        if (++emptyRounds >= threshold) degraded = true;
        return;
      }
      emptyRounds = 0;

      if (signedIn !== lastSignedIn) {
        lastSignedIn = signedIn;
        emit({ type: 'auth-state-changed', signedIn });
      }
      const key = sessions.map(s => `${s.id}\u0000${s.title}`).join('\u0001');
      if (key !== lastSessionKey) {
        lastSessionKey = key;
        emit({ type: 'session-list-changed', sessions });
      }
    },
    answerCompleted() {
      if (degraded) return;
      const preview = extractLatestAnswerPreview(doc);
      if (preview && preview !== lastAnswerPreview) {
        lastAnswerPreview = preview;
        emit({ type: 'answer-completed', preview });
      }
    },
  };
}
```

> 说明：`answerCompleted()` 与 `tick()` 分开，是因为"回答完成"由 deepseek.ts 里的 MutationObserver 在消息节点稳定后触发，而列表/登录态是每轮快照比对。降级判定只看会话列表与登录标志（回答节点在空页面本就没有，不算改版信号）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/unit/observer.test.ts` → Expected: 全部 passed。若 `sessionItemTitle` 的相对选择器在 jsdom 下命中失败，回到 `SELECTORS.sessionItemTitle` 确认 `.ds-focus-ring + div` 在锚点子树内可被 `a.querySelector('.ds-focus-ring + div')` 命中（`+` 相邻组合器相对锚点成立）。

- [ ] **Step 5: 提交**

```bash
git add src/preload/observer.ts tests/unit/observer.test.ts
git commit -m "feat: 纯 DOM observer，提取会话/登录/回答并对改版自降级"
```

---

### Task 3: 主进程 pageEvents 接收与分发

**Files:**
- Create: `src/main/pageEvents.ts`
- Test: `tests/unit/pageEvents.test.ts`

**Interfaces:**
- Consumes: `IPC.PAGE_EVENT`、`IPC.OBSERVER_DEGRADED`、`makeSenderGuard`（`src/shared/ipc.ts`）、`pageEventSchema`（`src/shared/pageEvent.ts`）
- Produces: `registerPageEvents(deps: { expectedWebContentsId(): number; onEvent(e: PageEvent): void; onDegraded(): void }): { dispose(): void }`。只接受 `event.sender.id === expectedWebContentsId()` 且通过 `pageEventSchema` 的消息；其余丢弃。

- [ ] **Step 1: 写失败测试**

`tests/unit/pageEvents.test.ts`（用一个最小 ipcMain 替身，不依赖 Electron）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildPageEventHandler } from '../../src/main/pageEvents';

const mkEvent = (senderId: number, payload: unknown) =>
  ({ sender: { id: senderId }, payload } as never);

describe('buildPageEventHandler', () => {
  it('接受合法事件并分发', () => {
    const onEvent = vi.fn();
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    h(mkEvent(7, { type: 'auth-state-changed', signedIn: true }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'auth-state-changed', signedIn: true });
  });
  it('拒绝非预期发送方', () => {
    const onEvent = vi.fn();
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    h(mkEvent(999, { type: 'auth-state-changed', signedIn: true }));
    expect(onEvent).not.toHaveBeenCalled();
  });
  it('拒绝不合 schema 的负载（超长标题）', () => {
    const onEvent = vi.fn();
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    h(mkEvent(7, { type: 'session-list-changed', sessions: [{ id: 'a', title: 'x'.repeat(201) }] }));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/unit/pageEvents.test.ts` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/pageEvents.ts`**

```ts
import { ipcMain, type IpcMainEvent } from 'electron';
import { IPC } from '../shared/ipc';
import { pageEventSchema, type PageEvent } from '../shared/pageEvent';

export function buildPageEventHandler(deps: {
  expectedId(): number;
  onEvent(e: PageEvent): void;
  onDegraded(): void;
}) {
  return (event: IpcMainEvent): void => {
    if (event.sender.id !== deps.expectedId()) return;
    const parsed = pageEventSchema.safeParse(event.payload);
    if (parsed.success) deps.onEvent(parsed.data);
  };
}

export function registerPageEvents(deps: {
  expectedWebContentsId(): number;
  onEvent(e: PageEvent): void;
  onDegraded(): void;
}) {
  const handler = buildPageEventHandler(deps);
  const degradedHandler = (event: IpcMainEvent) => {
    if (event.sender.id === deps.expectedWebContentsId()) deps.onDegraded();
  };
  ipcMain.on(IPC.PAGE_EVENT, handler);
  ipcMain.on(IPC.OBSERVER_DEGRADED, degradedHandler);
  return {
    dispose() {
      ipcMain.removeListener(IPC.PAGE_EVENT, handler);
      ipcMain.removeListener(IPC.OBSERVER_DEGRADED, degradedHandler);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/unit/pageEvents.test.ts` → Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/pageEvents.ts tests/unit/pageEvents.test.ts
git commit -m "feat: pageEvents 接收远端上报，按发送方与 zod 校验后分发"
```

---

### Task 4: 节流通知

**Files:**
- Create: `src/main/notifications.ts`
- Test: `tests/unit/notifications.test.ts`

**Interfaces:**
- Consumes: `PageEvent`、`Settings`（`notifyOnAnswer`）
- Produces:
  - `createThrottle(now: () => number): (key: string) => boolean` — 同 key 30s 内返回 false；全局每分钟最多 3 次。
  - `createNotifier(deps: { settings(): { notifyOnAnswer: boolean }; show(title: string, body: string): void; now(): number }): (e: PageEvent) => void` — `answer-completed` 且 `notifyOnAnswer` 为真时通知；`auth-state-changed{signedIn:false}` 提示登录过期；点击聚焦由调用方在 `show` 里接。

- [ ] **Step 1: 写失败测试**

`tests/unit/notifications.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createThrottle, createNotifier } from '../../src/main/notifications';

describe('createThrottle', () => {
  it('同 key 30 秒内第二次被挡', () => {
    let t = 0;
    const th = createThrottle(() => (t += 0));
    t = 1000; expect(th('a')).toBe(true);
    t = 1000 + 29_000; expect(th('a')).toBe(false);
    t = 1000 + 31_000; expect(th('a')).toBe(true);
  });
  it('全局每分钟最多 3 条', () => {
    let t = 0;
    const th = createThrottle(() => t);
    t = 0;
    expect(th('a')).toBe(true); expect(th('b')).toBe(true); expect(th('c')).toBe(true);
    expect(th('d')).toBe(false); // 第 4 条同分钟被挡
    t = 61_000; expect(th('e')).toBe(true); // 下一分钟放行
  });
});

describe('createNotifier', () => {
  it('notifyOnAnswer=false 时不发回答通知', () => {
    const show = vi.fn();
    const n = createNotifier({ settings: () => ({ notifyOnAnswer: false }), show, now: () => 0 });
    n({ type: 'answer-completed', preview: '结论' });
    expect(show).not.toHaveBeenCalled();
  });
  it('登录过期始终提示', () => {
    const show = vi.fn();
    const n = createNotifier({ settings: () => ({ notifyOnAnswer: true }), show, now: () => 0 });
    n({ type: 'auth-state-changed', signedIn: false });
    expect(show).toHaveBeenCalledWith('登录已过期', expect.stringContaining('登录'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/unit/notifications.test.ts` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/notifications.ts`**

```ts
import type { PageEvent } from '../shared/pageEvent';

const PER_KEY_MS = 30_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 3;

export function createThrottle(now: () => number) {
  const lastByKey = new Map<string, number>();
  let hits: number[] = [];
  return (key: string): boolean => {
    const t = now();
    hits = hits.filter(h => t - h < GLOBAL_WINDOW_MS);
    const last = lastByKey.get(key);
    if (last !== undefined && t - last < PER_KEY_MS) return false;
    if (hits.length >= GLOBAL_MAX) return false;
    lastByKey.set(key, t);
    hits.push(t);
    return true;
  };
}

export function createNotifier(deps: {
  settings(): { notifyOnAnswer: boolean };
  show(title: string, body: string): void;
  now(): number;
}) {
  const throttle = createThrottle(deps.now);
  return (e: PageEvent): void => {
    if (e.type === 'answer-completed') {
      if (!deps.settings().notifyOnAnswer) return;
      const key = e.sessionId ?? 'current';
      if (!throttle(`answer:${key}`)) return;
      deps.show('DeepSeek 有新回复', e.preview ?? '回答已完成');
    } else if (e.type === 'auth-state-changed' && e.signedIn === false) {
      if (!throttle('auth-expired')) return;
      deps.show('登录已过期', '请在窗口内重新登录 DeepSeek');
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/unit/notifications.test.ts` → Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/notifications.ts tests/unit/notifications.test.ts
git commit -m "feat: 节流系统通知（回答完成/登录过期），同会话30s、每分钟3条"
```

---

### Task 5: 划词/截图提问 quickAsk

**Files:**
- Create: `src/main/quickAsk.ts`
- Test: `tests/unit/quickAsk.test.ts`

**Interfaces:**
- Consumes: `injectTextSchema`（Task 1）
- Produces: `performQuickAsk(deps: { readClipboardText(): string; sendInject(text: string): void; notifyEmpty(): void }): void` — 读剪贴板，trim 后为空则 `notifyEmpty()`；否则 `sendInject(text)`。剪贴板与发送都是注入依赖，便于脱离 Electron 单测。

- [ ] **Step 1: 写失败测试**

`tests/unit/quickAsk.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { performQuickAsk } from '../../src/main/quickAsk';

describe('performQuickAsk', () => {
  it('剪贴板有内容时投递注入', () => {
    const send = vi.fn();
    performQuickAsk({ readClipboardText: () => '  选中的文字\n', sendInject: send, notifyEmpty: () => {} });
    expect(send).toHaveBeenCalledWith('选中的文字');
  });
  it('剪贴板为空时不投递，改为提示', () => {
    const send = vi.fn(); const empty = vi.fn();
    performQuickAsk({ readClipboardText: () => '   ', sendInject: send, notifyEmpty: empty });
    expect(send).not.toHaveBeenCalled(); expect(empty).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/unit/quickAsk.test.ts` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/quickAsk.ts`**

```ts
import { injectTextSchema } from '../shared/pageEvent';

export function performQuickAsk(deps: {
  readClipboardText(): string;
  sendInject(text: string): void;
  notifyEmpty(): void;
}): void {
  const text = deps.readClipboardText().trim();
  if (!text) return deps.notifyEmpty();
  if (!injectTextSchema.safeParse({ text }).success) return deps.notifyEmpty();
  deps.sendInject(text);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/unit/quickAsk.test.ts` → Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/quickAsk.ts tests/unit/quickAsk.test.ts
git commit -m "feat: 划词提问读剪贴板并投递注入，空剪贴板只提示不写"
```

---

### Task 6: 本地文本文件注入 fileInject

**Files:**
- Create: `src/main/fileInject.ts`
- Test: `tests/unit/fileInject.test.ts`

**Interfaces:**
- Consumes: `injectTextSchema`（Task 1）
- Produces:
  - `readTextFileCapped(filePath: string, maxBytes: number): { ok: true; text: string } | { ok: false; reason: 'too-large' | 'read-failed' }`
  - `buildQuoteBlock(fileName: string, text: string): string` — 拼成 `文件名 + 代码围栏引用块`，围栏长度按内容里最长反引号串动态加长，避免内容提前闭合围栏。
  - `prepareFileInject(filePath: string): { ok: true; payload: string } | { ok: false; reason: string }`

- [ ] **Step 1: 写失败测试**

`tests/unit/fileInject.test.ts`：

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextFileCapped, buildQuoteBlock, prepareFileInject } from '../../src/main/fileInject';

const tmp = (name: string, content: string) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ds-file-'));
  const p = path.join(d, name); writeFileSync(p, content); return p;
};

describe('readTextFileCapped', () => {
  it('限内文件读出内容', () => {
    const r = readTextFileCapped(tmp('a.txt', 'hello'), 512);
    expect(r).toEqual({ ok: true, text: 'hello' });
  });
  it('超限文件判 too-large', () => {
    const r = readTextFileCapped(tmp('b.txt', 'x'.repeat(600)), 512);
    expect(r.ok).toBe(false);
  });
});

describe('buildQuoteBlock', () => {
  it('普通文本用三反引号围栏并带文件名', () => {
    const s = buildQuoteBlock('a.txt', 'hi');
    expect(s).toContain('a.txt'); expect(s).toContain('```'); expect(s).toContain('hi');
  });
  it('内容含三反引号时加长围栏，不被提前闭合', () => {
    const s = buildQuoteBlock('code.md', '```\ncode\n```');
    expect(s.startsWith('````')).toBe(true); // 四个反引号
  });
});

describe('prepareFileInject', () => {
  it('限内文件产出可注入 payload', () => {
    const r = prepareFileInject(tmp('c.txt', 'content here'));
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/unit/fileInject.test.ts` → Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/fileInject.ts`**

```ts
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
  return `${fileName}\n${fence}\n${text}\n${fence}\n`;
}

export function prepareFileInject(
  filePath: string,
): { ok: true; payload: string } | { ok: false; reason: string } {
  const r = readTextFileCapped(filePath);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, payload: buildQuoteBlock(path.basename(filePath), r.text) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/unit/fileInject.test.ts` → Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/fileInject.ts tests/unit/fileInject.test.ts
git commit -m "feat: 本地文本文件注入，512KB 上限与防提前闭合围栏"
```

---

### Task 7: preload 胶水——驱动 observer 上报 + 执行注入

**Files:**
- Modify: `src/preload/deepseek.ts`
- Test: `tests/e2e/inject.spec.ts`

**Interfaces:**
- Consumes: `createObserver`（Task 2）、`IPC`（`PAGE_EVENT`/`INJECT_TEXT`/`OBSERVER_DEGRADED`）、`SELECTORS`
- Produces: 挂载到远端窗口的 preload。用 `MutationObserver` + 500ms 防抖驱动 `observer.tick()` 与 `answerCompleted()`，经 `ipcRenderer.send(IPC.PAGE_EVENT, event)` 上报；降级时 `ipcRenderer.send(IPC.OBSERVER_DEGRADED)`。监听 `INJECT_TEXT`，用"原生 value setter + `input` 事件"写入 `SELECTORS.inputBox`（M0 证实 React 接受此法）。

- [ ] **Step 1: 实现 `src/preload/deepseek.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import { injectTextSchema } from '../shared/pageEvent';
import { SELECTORS } from './selectors';
import { createObserver } from './observer';

const observer = createObserver({
  doc: document,
  emit: (e) => ipcRenderer.send(IPC.PAGE_EVENT, e),
});

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    observer.tick();
    observer.answerCompleted();
    if (observer.isDegraded()) ipcRenderer.send(IPC.OBSERVER_DEGRADED);
  }, 500);
}

new MutationObserver(schedule).observe(document.documentElement, {
  childList: true, subtree: true, characterData: true,
});
schedule();

function injectText(raw: unknown) {
  const parsed = injectTextSchema.safeParse(raw);
  if (!parsed.success) return;
  const ed = document.querySelector<HTMLTextAreaElement>(SELECTORS.inputBox);
  if (!ed) return;
  ed.focus();
  const proto = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(ed, parsed.data.text);
  ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: parsed.data.text }));
}

ipcRenderer.on(IPC.INJECT_TEXT, (_e, payload) => injectText(payload));

contextBridge.exposeInMainWorld('__dsShellPreload', { version: 1 });
```

- [ ] **Step 2: 写 e2e（注入往返）**

`tests/e2e/inject.spec.ts`：用一个本地 HTML（含一个 React 式受控 textarea 的简化版：`input` 事件回写 `state`）经 `DS_SHELL_URL` 加载，主进程 `webContents.send(IPC.INJECT_TEXT, { text })`，断言 textarea 的 value 变为注入文本。

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('INJECT_TEXT 写入受控 textarea 且触发 input 事件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-inject-'));
  const page = path.join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><meta charset=utf-8><body>
    <textarea id="t"></textarea>
    <script>const t=document.getElementById('t');let state='';
    t.addEventListener('input',()=>{state=t.value;document.title='state:'+state;});</script>
    </body>`);
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/') },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }, text) => {
    BrowserWindow.getAllWindows()[0].webContents.send('shell:inject-text', { text });
  }, '注入的文本');
  await expect.poll(async () => {
    return win.title();
  }, { timeout: 5000 }).toContain('state:注入的文本');
  await app.close();
});
```

- [ ] **Step 3: 跑 e2e 确认通过**

Run: `pnpm test:e2e tests/e2e/inject.spec.ts` → Expected: PASS。若失败，先确认 `file://` 页能加载 preload（preload 路径由 `app.getAppPath()/out/preload/deepseek.js` 提供，e2e 前须 `pnpm build`）。

> 注意：`will-navigate` 白名单只放 deepseek 域，`file://` 首屏加载不受 `will-navigate` 限制（`loadURL` 初始导航不触发它），故 e2e 可用本地文件页。若被拦，改为在测试里断言注入而非依赖导航。

- [ ] **Step 4: 提交**

```bash
git add src/preload/deepseek.ts tests/e2e/inject.spec.ts
git commit -m "feat: preload 驱动 observer 上报并执行 React 兼容的文本注入"
```

---

### Task 8: 主进程装配（pageEvents + 通知 + 快捷键 + 托盘降级）

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/e2e/page-events.spec.ts`

**Interfaces:**
- Consumes: `registerPageEvents`（Task 3）、`createNotifier`（Task 4）、`performQuickAsk`（Task 5）、`prepareFileInject`（Task 6）、`getShellWindow`/`showOrFocusShell`/`toggleShell`（Plan 1）、`TrayHandle.set`（Task 7 Plan1）、`registerHotkeys`（Plan 1）
- Produces: 端到端可运行的增强壳。`onEvent` 把事件喂给 notifier；`onDegraded` 调 `tray.set({ degraded: true, unread: 0 })`；quickAsk 快捷键读剪贴板 → 向远端窗口 `webContents.send(IPC.INJECT_TEXT, { text })`。

- [ ] **Step 1: 装配 index.ts（whenReady 内）**

在 `createShellWindow()` 之后、`registerHotkeys` 之前接入：

```ts
import { Notification, clipboard } from 'electron';
import { registerPageEvents } from './pageEvents';
import { createNotifier } from './notifications';
import { performQuickAsk } from './quickAsk';
import { IPC } from '../shared/ipc';
import { getShellWindow } from './shellWindow';

const notifier = createNotifier({
  settings: () => settings.get(),
  show: (title, body) => {
    const n = new Notification({ title, body });
    n.on('click', () => showOrFocusShell());
    n.show();
  },
  now: () => Date.now(),
});

registerPageEvents({
  expectedWebContentsId: () => getShellWindow()?.webContents.id ?? -1,
  onEvent: (e) => notifier(e),
  onDegraded: () => tray?.set({ degraded: true, unread: 0 }),
});
```

并把 Task 8(Plan1) 里 `registerHotkeys` 的 `onQuickAsk` 从占位改为：

```ts
onQuickAsk: () => performQuickAsk({
  readClipboardText: () => clipboard.readText(),
  sendInject: (text) => getShellWindow()?.webContents.send(IPC.INJECT_TEXT, { text }),
  notifyEmpty: () => new Notification({ title: '剪贴板为空', body: '请先选中要提问的文字' }).show(),
}),
```

- [ ] **Step 2: 写 e2e（事件往返 + 降级）**

`tests/e2e/page-events.spec.ts`：加载一个含会话结构与输入框的本地 fixture 页（复用 `tests/fixtures/logged-in.html` 拷贝到临时目录经 `file://` 打开），断言主进程收到 `session-list-changed`（通过一个测试钩子把收到的事件计数写文件，参照 Plan 1 的 `recordShellEvents` 手法）。

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('observer 从登录态 DOM 上报 session-list-changed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-pe-'));
  const page = path.join(dir, 'index.html');
  copyFileSync(path.join(repoRoot, 'tests/fixtures/logged-in.html'), page);
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: { ...process.env, DS_SHELL_USER_DATA: dir, DS_SHELL_URL: 'file://' + page.replace(/\\/g, '/') },
  });
  await app.firstWindow();
  // 通过注入到主进程的测试钩子读取事件计数（见 Step 3 的 DS_SHELL_TEST_HOOKS）
  const got = await app.evaluate(() => (globalThis as any).__dsPageEventCount ?? 0);
  expect(got).toBeGreaterThan(0);
  await app.close();
});
```

- [ ] **Step 3: 加测试钩子并在 index.ts 记录事件数**

在 `src/main/index.ts` 的 `DS_SHELL_TEST_HOOKS` 分支里，`registerPageEvents` 的 `onEvent` 追加：

```ts
onEvent: (e) => {
  notifier(e);
  if (process.env.DS_SHELL_TEST_HOOKS) {
    (globalThis as unknown as { __dsPageEventCount: number }).__dsPageEventCount =
      ((globalThis as unknown as { __dsPageEventCount?: number }).__dsPageEventCount ?? 0) + 1;
  }
},
```

- [ ] **Step 4: 跑 e2e 与全量测试确认通过**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e` → Expected: 全绿。

- [ ] **Step 5: 手动验收**

Run: `pnpm dev`，登录后：在别处选中一段文字按 `Ctrl+Alt+Q` → 文本出现在 DeepSeek 输入框；制造一条长回答并把窗口切到后台 → 收到一条系统通知、点击回到窗口；断网重连后增强仍工作。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 装配事件管线——通知、划词注入、降级上托盘，打通 M2"
```

---

## Plan 2 结束后的自检

- [ ] `pnpm typecheck && pnpm test && pnpm test:e2e` 全绿
- [ ] `tests/unit/observer.test.ts` 跑的是真实 `tests/fixtures/logged-in.html`，不是构造 DOM
- [ ] 划词注入、回答完成通知、登录过期通知、降级托盘提示四项手动验收通过（spec 第 15 节验收标准第 4、5、8 条）
- [ ] 未新增任何向 DeepSeek 内部接口发请求的代码（红线复核）
- [ ] M3（归档 store / Markdown 导出 / 搜索面板 + DOM 跳转）另立 Plan 3

## Plan 3 范围（本计划不实现）

`main/archive/store.ts`（DOM 快照去重合并、原子写、200 会话/100MB 上限、损坏回滚）、`main/archive/export.ts`（会话转 Markdown）、`renderer/search`（搜索面板 + 侧边栏按标题定位 `.click()` 跳转）、fixture 抓取脚本、验收清单第 6、7 条。前置：Plan 2 的事件管线稳定。
