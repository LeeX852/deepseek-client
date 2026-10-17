import { IPC } from '../shared/ipc';
import { injectTextSchema } from '../shared/pageEvent';
import { SELECTORS } from './selectors';
import { createObserver } from './observer';

// scripts/build.mjs 不给这个入口设 external: ['electron']（overlay 入口设了），
// `import ... from 'electron'` 会让 esbuild 去打包 electron 包主入口（Node-only）直接构建失败。
// 从对象属性上取 require 绕过 esbuild 的静态 require 解析，产物里保留运行时
// require——沙箱 preload 运行时恰好注入 require('electron')，语义与 external 完全等价。
const electronModule = ({ require }).require('electron') as typeof import('electron');
const { contextBridge, ipcRenderer } = electronModule;

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
