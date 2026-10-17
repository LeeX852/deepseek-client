import { SELECTORS } from './selectors';
import { CONVERSATION_EMIT_MAX, SESSION_LIST_MAX, type PageEvent } from '../shared/pageEvent';

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

// Task 6：在侧边栏按标题定位并点击真实会话链接——绝不猜造 URL 拼导航。
// 标题匹配与 extractSessions 同口径：折叠空白、忽略大小写；
// SELECTORS.sessionItemTitle 去掉开头的 `a[href…]` 段，改为在锚点内相对查询
// （同 extractSessions 的技巧）。命中即 a.click() 并返回 true。
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

// 上报上限（SESSION_LIST_MAX / CONVERSATION_EMIT_MAX）由 ../shared/pageEvent 单一
// 事实源提供，schema 侧用的是同两个常量。extractSessions/extractConversation 自身
// 不设条数上限，超限事件会被主进程 safeParse 整条拒掉、静默丢归档/丢列表，
// 所以 emit 前必须先截断（会话保留前 500 条，对话保留最后 200 条 = 最新窗口）。

export function createObserver(opts: {
  doc: Document;
  emit(e: PageEvent): void;
  degradeThreshold?: number;
  // 注入点（默认真实 DOM 抽取）：answerCompleted 的稳定判定与「取哪段预览」解耦，
  // 单测可注入受控预览驱动连续两轮相同/不同的场景，无需构造易碎的 DeepSeek DOM。
  readPreview?: () => string | null;
}) {
  const { doc, emit } = opts;
  const threshold = opts.degradeThreshold ?? 3;
  const readPreview = opts.readPreview ?? (() => extractLatestAnswerPreview(doc));
  let lastSessionKey = '';
  // 初值取 false（未登录）而非 null：auth-state-changed 只在「真正跃迁」时发出。
  // 若初值为 null，未登录用户的首轮、或已登录用户 SPA 尚未水合 textarea 的首轮
  // （signedIn===false）都会命中 false !== null 而发出 auth(false)，被通知侧翻成
  // 每次启动都弹的「登录已过期」。初值 false 后：首轮未登录不发、首轮已登录发
  // auth(true)、后续已登录→登出（true→false）仍发 auth(false)（登出通知不受影响）。
  let lastSignedIn: boolean | null = false;
  let lastConversationKey = '';
  let prevPreview: string | null = null;
  let emittedPreview: string | null = null;
  let emptyRounds = 0;
  let degraded = false;

  return {
    isDegraded: () => degraded,
    tick() {
      const sessions = extractSessions(doc);
      const signedIn = extractSignedIn(doc);
      // auth 变化先报（登出 signedIn:false 必须在「空轮降级」早返回之前发出，
      // 否则真实登出页（无 textarea、无会话）永远走不到 emit，通知侧收不到登出）。
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
    answerCompleted() {
      if (degraded) return;
      // 稳定判定（spec §15.5 / Finding I-1）：流式中预览每个防抖 tick 都在变，
      // 「变了就发」会在半截误报、还会被通知节流吃掉真正的完成事件。只有当本轮
      // 预览与上一轮完全相同（即连续 2 次 answerCompleted 一致）才算回答落定；
      // 且同一个稳定预览只发一次。持续变化的预览永远不发。
      const preview = readPreview();
      if (preview === null) {
        prevPreview = null;
        return;
      }
      const stable = preview === prevPreview;
      prevPreview = preview;
      if (stable && preview !== emittedPreview) {
        emittedPreview = preview;
        emit({ type: 'answer-completed', preview });
      }
    },
    // Plan 3 Task 2 / 返工 RW-1：把当前可见对话上报给归档侧。内容键去重——DOM 每有
    // mutation 防抖 tick 都会调到这里，但只有（截断后的）消息序列真正变了才 emit。
    // 归档键用真 sessionId：idFromHref(location.href) 在对话页命中 /a/chat/s/<id>；
    // 非对话页（落地页/新会话）无稳定 id → 直接不 emit。全终审 C-1/C-2/C-3 的根因
    // 就是旧版省略 sessionId、由归档侧从"首条用户消息"派生键——DeepSeek 侧边栏标题
    // 是自动摘要，与消息正文永不相等，且 CJK 首句会塌成下划线串互相撞键。真 id +
    // 真 title（取自 extractSessions 的侧边栏摘要）从源头消掉这三条缺陷。
    conversationUpdated() {
      if (degraded) return;
      const sessionId = idFromHref(doc.location.href);
      // 不在对话页 → 不归档（没有可锚定的真 id，绝不猜造、也不塌 untitled）。
      if (!sessionId) return;
      const messages = extractConversation(doc).slice(-CONVERSATION_EMIT_MAX);
      if (!messages.length) return;
      const key = messages.map(m => `${m.role}\u0000${m.text}`).join('\u0001');
      if (key === lastConversationKey) return;
      lastConversationKey = key;
      // 真实侧边栏标题：从 extractSessions 找 id===sessionId 的那条；找不到则省略 title，
      // 归档侧回退为 id（绝不回退成消息正文——那正是 C-1 的来源）。
      const title = extractSessions(doc).find(s => s.id === sessionId)?.title;
      emit({ type: 'conversation-updated', sessionId, ...(title ? { title } : {}), messages });
    },
  };
}

// 当前对话的全部可见消息：给 Plan 3 的归档/搜索用。
// 与 extractLatestAnswerPreview 同样的处理——折叠空白 + 截断上界（20000），
// 单条为空（例如只有头像/图标）直接跳过，避免归档里出现空行。
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
