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

// 上报上限：必须与 pageEvent.ts conversationUpdatedSchema 的 messages.max(200) 对齐。
// extractConversation 不设条数上限，超限事件会被主进程 safeParse 整条拒掉、
// 静默丢归档，所以 emit 前必须先截断（保留最后 200 条 = 最新的对话窗口）。
const CONVERSATION_EMIT_MAX = 200;

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
  let lastSignedIn: boolean | null = null;
  let lastConversationKey = '';
  let prevPreview: string | null = null;
  let emittedPreview: string | null = null;
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
    // Plan 3 Task 2：把当前可见对话上报给归档侧。内容键去重——DOM 每有 mutation
    // 防抖 tick 都会调到这里，但只有（截断后的）消息序列真正变了才 emit。
    // sessionId 省略：M2 的 observer 无稳定"当前会话高亮"判据，绝不猜造；
    // 归档键由 Task 3 用首条用户消息在归档侧派生（Plan 3 裁决）。
    conversationUpdated() {
      if (degraded) return;
      const messages = extractConversation(doc).slice(-CONVERSATION_EMIT_MAX);
      if (!messages.length) return;
      const key = messages.map(m => `${m.role}\u0000${m.text}`).join('\u0001');
      if (key === lastConversationKey) return;
      lastConversationKey = key;
      emit({ type: 'conversation-updated', messages });
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
