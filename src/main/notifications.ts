import type { PageEvent } from '../shared/pageEvent';

// 纯逻辑模块：不 import electron。now/show/settings 全部注入，单测跑在纯 Node 下。
// Task 8 负责把真实 Electron Notification 接到 show 上（含点击聚焦窗口）。
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
