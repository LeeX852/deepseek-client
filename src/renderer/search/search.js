// 搜索面板渲染层：只通过 preload 暴露的 searchApi 与主进程往来。
// 标题来自归档文件，属不可信字符串——一律走 textContent，绝不 innerHTML。
const DEBOUNCE_MS = 200;

const input = document.getElementById('query');
const results = document.getElementById('results');

/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

function render(items) {
  results.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item.title;
    li.addEventListener('click', () => {
      if (window.searchApi && typeof window.searchApi.jump === 'function') {
        window.searchApi.jump(item.title);
      }
      window.close();
    });
    results.appendChild(li);
  }
}

input.addEventListener('input', () => {
  clearTimeout(timer);
  const q = input.value;
  timer = setTimeout(() => {
    if (!window.searchApi || typeof window.searchApi.query !== 'function') return;
    window.searchApi.query(q).then(items => {
      render(Array.isArray(items) ? items : []);
    });
  }, DEBOUNCE_MS);
});
