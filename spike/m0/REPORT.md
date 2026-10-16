# M0 前置验证报告

> 状态：spike 代码已就绪并在**未登录**状态下跑通（见"已验证 / 未验证"）。
> 五项结论必须等真人登录跑完 Step 3 后才能填写，当前一律为 `PENDING-USER-RUN`。

| # | 风险项 | 判据 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 站点是否拒绝本环境 | 页面正常渲染并可登录，无 bot 拦截 | PENDING-USER-RUN | spike/m0/out/manual.json 的 url + 截图说明 |
| 2 | preload 的 DOM 可达性与 CSP | observer 能读到会话列表、消息节点、登录标志 | PENDING-USER-RUN | SELECTORS 每项在 fixture 中的命中数 |
| 3 | 输入框注入是否被 React 接受 | 控制台 persisted=true | PENDING-USER-RUN | `[probe] insert ...` 原始日志行 |
| 4 | 合成 paste 带 File 能否被页面接收 | 页面出现附件缩略图 | PENDING-USER-RUN | 人工观察说明 |
| 5 | 登录是否在 deepseek 域内完成 | did-navigate 全程 hostname 属于白名单 | PENDING-USER-RUN | `[spike] navigate ->` 全部日志行 |

## 对后续设计的影响

- 结论 2 不成立 → Plan 2 的归档/通知/划词全部取消，项目退化为 Task 1 的基础壳（仍然可用）。
- 结论 3 不成立 → 划词与文本注入改为"复制到剪贴板 + 提示用户粘贴"。
- 结论 4 不成立 → 截图注入取消，只保留划词与文本文件注入。
- 结论 5 不成立 → 放宽 ALLOWED_HOSTS 并把实际登录域加进白名单。

## 已验证（未登录态，2026-10-16，本机 Windows 11 + Electron 44.8.0）

1. **spike 可跑通**：`pnpm exec electron spike/m0/main.mjs`（项目根为工作目录）能启动、
   加载 `https://chat.deepseek.com/` 并持续产出产物；kill 前观察到连续 2-3 个探测周期。
2. **窗口渲染的是真实登录页**，非错误页 / bot 拦截页：页面被 SPA 路由到
   `https://chat.deepseek.com/sign_in`，快照正文含"发送验证码 / 密码登录 / 使用 Apple
   账号登录 / 微信扫码登录 / 浙ICP备2023025841号"，DOM 中有手机号与验证码两个
   `<input type="tel" class="ds-input__input">`。
   （旁证：同环境用 curl 直接请求站点返回 HTTP 429，带浏览器化 UA 的 Electron 不受影响。）
3. **preload 能读 DOM 并落盘**（风险 2 的机制前提，非最终结论）：`auto-NNN.json/.html`
   正常写入 `spike/m0/out/`；`auto-NNN.json` 里 `editable/sidebar/itemish/messages`
   在未登录态全为空数组——符合预期，说明探测选择器没有命中登录页噪声，但也意味着
   风险 2 的正式判据（会话列表/消息节点可达）必须有登录态数据才能下结论。
4. **UA 清洗生效**：快照 `navigator.userAgent` 不含 `Electron/` 与 `ds-shell/` 标记。
5. **日志链路打通**：`[probe] snapshot auto-00N url=...`、`[probe] insert=NO_EDITABLE`、
   `[spike] navigate -> ...`、`[spike] in-page -> ...` 都能到达终端 stdout。
   未登录态 `insert=NO_EDITABLE` 是预期行为（登录页输入框是 `<input>`，不在注入自测的
   `textarea/[contenteditable]/[role=textbox]` 选择器范围内），风险 3/4 仍需登录实测。

## 未验证（必须真人登录完成）

- 风险 1 的"可登录"部分：只验证了页面渲染，未验证登录流程本身。
- 风险 2：登录态下的会话列表、消息节点、登录标志是否真的可达。
- 风险 3：React 受控输入框是否接受程序化写入（persisted=true）。
- 风险 4：合成 paste 携带 File 后页面是否出现附件缩略图。
- 风险 5：登录全程（含第三方 OAuth 弹窗/跳转）hostname 是否始终在白名单内。
- Step 4-6：选择器定稿、`src/preload/selectors.ts`、`tests/fixtures/*` 与契约测试。
  **这些文件在本 spike 代码库中有意不存在**——没有真实会话数据之前写选择器就是编造。

## 运行说明（给 Step 3 执行人）

- 命令：`pnpm exec electron spike/m0/main.mjs`（项目根为工作目录），产物在 `spike/m0/out/`。
- 每 5 秒自动落一份 `auto-NNN.json/.html`，上限 240 轮（约 20 分钟）后自动停止探测；
  30 秒起每 30 秒另有 `manual.json/.html`。登录完成后至少留一份 `manual.json` 再 Ctrl+C。
- 登录态保存在 `spike/m0/out/userdata`（partition `persist:deepseek`），重跑不必重复登录；
  要彻底重置就删该目录。
