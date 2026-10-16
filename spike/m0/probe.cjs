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

// 注入自测：React 受控组件是否接受我们的写入。
// 判据：写入后 500ms 值仍在，说明组件内部状态被同步更新。
async function insertTest() {
  const ed = document.querySelector('textarea,[contenteditable="true"],[role="textbox"]');
  if (!ed) { console.log('[probe] insert=NO_EDITABLE'); return; }
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
}

ipcRenderer.on('spike:snapshot', (_e, tag) => snapshot(tag));
ipcRenderer.on('spike:insert', () => void insertTest());

let rounds = 0;
const timer = setInterval(() => {
  if (++rounds > 240) { clearInterval(timer); return; }
  snapshot('auto-' + String(rounds).padStart(3, '0'));
  void insertTest();
}, 5000);
