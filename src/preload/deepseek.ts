import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import { injectTextSchema } from '../shared/pageEvent';
import { SELECTORS } from './selectors';
import { createObserver } from './observer';

// 降级时序（Task 8 交接 4）：observer 默认阈值 3 轮 × 500ms ≈ 1.5s，而真实
// DeepSeek SPA 的 hydrate 常常不止这么久——慢加载会被误判成"页面改版"而整场
// 静默降级。两手缓解：空轮计数推迟到 DOMContentLoaded 之后才开始（加载期的
// mutation 洪水不再消耗降级预算），并把容忍度提高到 20 轮（约 10s），
// 真改版仍会被抓住，只是晚几秒。
const observer = createObserver({
  doc: document,
  emit: (e) => ipcRenderer.send(IPC.PAGE_EVENT, e),
  degradeThreshold: 20,
});

let pageReady = document.readyState !== 'loading';
let scheduled = false;
function schedule() {
  if (scheduled || !pageReady) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    observer.tick();
    observer.answerCompleted();
    if (observer.isDegraded()) ipcRenderer.send(IPC.OBSERVER_DEGRADED);
  }, 500);
}

// document-start 时 DOMContentLoaded 尚未发生；就绪前 schedule() 一律空转，
// 就绪瞬间补排一次首 tick。readyState 已非 loading 的极端情形由下方 schedule() 兜底。
document.addEventListener('DOMContentLoaded', () => {
  pageReady = true;
  schedule();
}, { once: true });

// preload 在 document-start 执行，此时 documentElement 还不存在（null），
// observe(documentElement) 会抛 TypeError 并杀死整个 preload（注入监听随之消失，
// e2e 实测）。观测 `document` 本身：它永远是合法 Node，subtree:true 覆盖
// documentElement 的挂载与其后子树内全部 childList/characterData 变化，
// 与 brief 的"任意 DOM 变化触发防抖 tick"语义等价且无时序隐患。
new MutationObserver(schedule).observe(document, {
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

// IPC 契约（Task 3）：负载是监听器的第二个位置参数，不是事件属性。
ipcRenderer.on(IPC.INJECT_TEXT, (_e, payload) => injectText(payload));

contextBridge.exposeInMainWorld('__dsShellPreload', { version: 1 });
