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
  // spec §15.5：回答完成只在窗口未聚焦时提示。缺省（undefined）按未聚焦处理，
  // 即默认通知；auth-state-changed{signedIn:false} 不受此门控，始终提示。
  isFocused?: () => boolean;
}) {
  const throttle = createThrottle(deps.now);
  return (e: PageEvent): void => {
    if (e.type === 'answer-completed') {
      if (!deps.settings().notifyOnAnswer) return;
      // 聚焦检查前置于节流：前台阅读无需通知，且不该白白吃掉一个节流名额。
      if (deps.isFocused?.() === true) return;
      const key = e.sessionId ?? 'current';
      if (!throttle(`answer:${key}`)) return;
      deps.show('DeepSeek 有新回复', e.preview ?? '回答已完成');
    } else if (e.type === 'auth-state-changed' && e.signedIn === false) {
      if (!throttle('auth-expired')) return;
      deps.show('登录已过期', '请在窗口内重新登录 DeepSeek');
    }
  };
}
