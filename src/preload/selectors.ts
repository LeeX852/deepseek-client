// M0 定稿的 DeepSeek DOM 选择器契约（Plan 2 的 observer / 注入 / 归档全部从这里取）。
//
// 依据 2026-10-17 真实登录态抓取（spike/m0/out/manual.html，已登录且有会话历史）。
// 关键发现：DeepSeek 的 class 有两层——
//   1) 哈希化的 CSS-Module 类（形如 _27c9245 / aaff8b8f），每次构建都变，绝不能当选择器；
//   2) `ds-` 前缀的设计系统类（ds-message / ds-markdown / ds-button--circle …），语义稳定，
//      是官方组件库的一部分，改版概率远低于哈希类——这就是可用的稳定钩子。
// 会话列表用 URL 结构（a[href*="/a/chat/s/"]）而非 class，最稳。
//
// 站点改版时先跑 tests/unit/selectors-contract.test.ts，由它报警而非等用户发现。
export const SELECTORS = {
  // 左侧会话历史里的单条会话（每项一个链接，href 含会话 id）
  sessionItem: 'a[href*="/a/chat/s/"]',
  // 会话条目的标题文本节点（focus-ring 之后的标题 div）
  sessionItemTitle: 'a[href*="/a/chat/s/"] .ds-focus-ring + div',
  // 消息滚动容器（虚拟列表）
  messageList: '.ds-virtual-list',
  // 单条消息（用户或助手）
  messageItem: '.ds-message',
  // 助手回答正文（markdown 容器）
  assistantMessage: '.ds-assistant-message-main-content',
  // 输入框
  inputBox: 'textarea',
  // 发送按钮（主色实心圆形图标按钮，全局唯一）
  sendButton: '.ds-button--primary.ds-button--circle',
  // 登录标志：聊天输入框只在登录态出现，未登录的 sign_in 页无 textarea
  signedInMarker: 'textarea',
  capturedAt: '2026-10-17T04:30:56.212Z',
} as const;
