import { z } from 'zod';

// id / sessionId 会成为归档记录键的一部分，因此必须与路径注入隔离。
// 光靠长度上界挡不住 '../../secret' 这类短攻击串，改用字符白名单：
// 只允许字母、数字、下划线和连字符，长度 1..64。
const SAFE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const safeKeySchema = z.string().regex(SAFE_KEY_RE);

// Plan 4 Task 1：上报上限由 schema 与 preload observer 共用（单一事实源）。
// observer emit 前必须按这两个常量截断——超阈值事件会被主进程 safeParse 整条
// 拒掉、静默丢事件，所以两侧绝不能各写各的字面量。
export const SESSION_LIST_MAX = 500;
export const CONVERSATION_EMIT_MAX = 200;

export const sessionListItemSchema = z.object({
  id: safeKeySchema,
  title: z.string().max(200),
});

export const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(20000),
});

export const conversationUpdatedSchema = z.object({
  type: z.literal('conversation-updated'),
  sessionId: safeKeySchema.optional(),
  // RW-1：observer 现在带真实侧边栏摘要标题（≤200，与 extractSessions 同口径）。
  // 归档 title 用它，搜索/跳转据此匹配侧边栏 <a>——C-1 的承重字段。
  title: z.string().max(200).optional(),
  messages: z.array(conversationMessageSchema).max(CONVERSATION_EMIT_MAX),
});

export const pageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session-list-changed'), sessions: z.array(sessionListItemSchema).max(SESSION_LIST_MAX) }),
  z.object({
    type: z.literal('answer-completed'),
    sessionId: safeKeySchema.optional(),
    title: z.string().max(200).optional(),
    preview: z.string().max(300).optional(),
  }),
  z.object({ type: z.literal('auth-state-changed'), signedIn: z.boolean() }),
  conversationUpdatedSchema,
]);

export type PageEvent = z.infer<typeof pageEventSchema>;

export const injectTextSchema = z.object({
  text: z.string().min(1).max(524_288),
});

export type InjectText = z.infer<typeof injectTextSchema>;
