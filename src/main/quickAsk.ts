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
