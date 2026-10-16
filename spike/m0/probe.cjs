// M0 前置验证 spike 的 preload：一次性探测代码，允许 sandbox:false 直接落盘。
// 注意：本文件必须是 CommonJS（require），因为 Electron 沙箱外的 preload
// 由 Electron 自身以 CJS 包装执行，不看 package.json 的 "type" 字段。
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.env.DS_SPIKE_OUT || 'spike/m0/out';
fs.mkdirSync(OUT, { recursive: true });

function chain(el) {
  const parts = [];
  let n = el;
  for (let d = 0; d < 5 && n && n.nodeType === 1; d++, n = n.parentElement) {
    const cls = typeof n.className === 'string' && n.className.trim()
      ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + cls);
  }
  return parts.join(' > ');
}

function rows(sel, limit) {
  return [...document.querySelectorAll(sel)].slice(0, limit).map(el => ({
    tag: el.tagName, id: el.id || null,
    cls: typeof el.className === 'string' ? el.className : null,
    role: el.getAttribute('role'), testid: el.getAttribute('data-testid'),
    aria: el.getAttribute('aria-label'), chain: chain(el),
    text: (el.innerText || el.value || '').replace(/\s+/g, ' ').slice(0, 120),
  }));
}

function snapshot(tag) {
  const stamp = {
    at: new Date().toISOString(), url: location.href, title: document.title,
    ua: navigator.userAgent,
    editable: rows('textarea,[contenteditable="true"],[role="textbox"]', 20),
    sidebar: rows('aside,[class*="sidebar" i],[class*="list" i],[class*="history" i]', 40),
    itemish: rows('[data-testid],[class*="session" i],[class*="conversation" i],[class*="chat-item" i]', 120),
    messages: rows('[class*="markdown" i],[class*="message" i],[class*="answer" i]', 60),
  };
  fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify(stamp, null, 2));
  fs.writeFileSync(path.join(OUT, `${tag}.html`), document.documentElement.outerHTML);
  console.log('[probe] snapshot ' + tag + ' url=' + location.href);
  return stamp;
}

// 可编辑元素里的"当前内容"：input/textarea 取 value，contenteditable 取纯文本。
function currentText(el) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value ?? '';
  return el.innerText ?? '';
}

// 一个字段是否"干净"到可以被自测覆写：空，或只含前几轮自测留下的
// DS_SHELL_SPIKE_<ts> 令牌。含任何其他文本都视为操作者的草稿。
function isSpikeTokenOnly(text) {
  const t = String(text ?? '').trim();
  if (t === '') return true;
  return /^(DS_SHELL_SPIKE_\d+)(?:[\s,;、/]+DS_SHELL_SPIKE_\d+)*$/.test(t);
}

// 把内容写回字段并派发 input，让 React 的内部状态与 DOM 保持一致——
// 复原草稿时必须这样做，否则只改 DOM 会被 React 的下一次渲染覆盖回去。
function writeValue(el, value) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: (value === '' ? 'deleteContentBackward' : 'insertText'), data: value }));
    return;
  }
  const sel = window.getSelection();
  if (sel) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
  // delete 清空 + insertText 写入，全程走 execCommand，好让 contenteditable
  // 宿主（含富文本编辑器）自己的 model 同步跟上，而不是只动了 DOM。
  document.execCommand('delete', false);
  if (value !== '') document.execCommand('insertText', false, value);
}

// 注入自测：React 受控组件是否接受我们的写入。
// 判据：写入后 500ms 值仍在，说明组件内部状态被同步更新。
//
// 这是破坏性操作，只在显式 `spike:insert` IPC 上运行（main.mjs 里绑定的
// Ctrl+Shift+U），5 秒自动循环只快照、绝不注入。保护操作者草稿三管齐下：
//   (1) 字段里已有非令牌文本就跳过，不覆写；
//   (2) 运行前存旧值、运行后连同 React 状态一起复原；
//   (3) 合成 paste 带 spike.png 也在同一次触发的作用域内（复原之后仍会留在
//       字段上，需要操作者确认后手动丢弃——见 REPORT.md 运行说明）。
async function insertTest() {
  const ed = document.querySelector('textarea,[contenteditable="true"],[role="textbox"]');
  if (!ed) { console.log('[probe] insert=NO_EDITABLE'); return; }
  const priorText = currentText(ed);
  if (!isSpikeTokenOnly(priorText)) {
    console.log('[probe] insert=SKIPPED_DIRTY len=' + priorText.length + ' tag=' + ed.tagName);
    return;
  }
  const token = 'DS_SHELL_SPIKE_' + Date.now();
  ed.focus();
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) {
    const proto = ed instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    setter.call(ed, token);
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: token }));
  } else {
    const sel = window.getSelection();
    if (sel) { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    document.execCommand('insertText', false, token);
  }
  const before = (ed.value || ed.innerText || '').includes(token);
  await new Promise(r => setTimeout(r, 500));
  const after = (ed.value || ed.innerText || '').includes(token);
  console.log(`[probe] insert dispatched=${before} persisted=${after} tag=${ed.tagName}`);

  // 合成 paste 带 File：截图注入路线的可行性判据。
  const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const dt = new DataTransfer();
  dt.items.add(new File([png], 'spike.png', { type: 'image/png' }));
  try {
    ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
    console.log('[probe] paste=DISPATCHED');
  } catch (e) { console.log('[probe] paste=ERROR ' + e.message); }

  // 复原操作者此前的草稿（含 React 状态）；若此前只是历史令牌，则清空。
  try {
    writeValue(ed, priorText);
    console.log('[probe] restore=ok prev=' + (priorText === '' ? 'EMPTY' : 'DRAFT') + ' len=' + priorText.length);
  } catch (e) { console.log('[probe] restore=ERROR ' + e.message); }
}

ipcRenderer.on('spike:snapshot', (_e, tag) => snapshot(tag));
// 破坏性自测只在这里运行：main.mjs 的 before-input-event 把 Ctrl+Shift+U
// 转成这条 IPC，即操作者显式触发的通道。自动循环不再发送它。
ipcRenderer.on('spike:insert', () => void insertTest());

// 自动循环：每 5 秒仅做 DOM 快照落盘，不做任何写入。
// 此前它每轮都无条件调用 insertTest()，会覆写并抢走操作者正在编辑的
// 输入框，把风险 3/4 的证据也一起污染；现已彻底移除。
let rounds = 0;
const timer = setInterval(() => {
  if (++rounds > 240) { clearInterval(timer); return; }
  snapshot('auto-' + String(rounds).padStart(3, '0'));
}, 5000);
