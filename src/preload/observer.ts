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
