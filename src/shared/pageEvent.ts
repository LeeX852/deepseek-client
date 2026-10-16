import { z } from 'zod';

export const sessionListItemSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200),
});

export const pageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session-list-changed'), sessions: z.array(sessionListItemSchema).max(500) }),
  z.object({ type: z.literal('answer-completed'), title: z.string().max(200).optional(), preview: z.string().max(300).optional() }),
  z.object({ type: z.literal('auth-state-changed'), signedIn: z.boolean() }),
]);

export type PageEvent = z.infer<typeof pageEventSchema>;
