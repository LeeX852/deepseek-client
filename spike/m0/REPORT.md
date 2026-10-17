# M0 前置验证报告

> 状态：2026-10-17 真人登录跑通，风险 1/2/5 已定论为**通过**；风险 3/4（注入 / 合成 paste）
> 仍待操作者在 spike 窗口内按一次 `Ctrl+Shift+U` 采集 `[probe] insert / paste` 日志后填写。

| # | 风险项 | 判据 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 站点是否拒绝本环境 | 页面正常渲染并可登录，无 bot 拦截 | 通过 | 微信扫码登录后 `manual.json` url=`chat.deepseek.com/a/chat/s/<uuid>`，DOM 有 100 条会话与消息；同环境 curl 直连返回 429，Electron 不受影响 |
| 2 | preload 的 DOM 可达性与 CSP | observer 能读到会话列表、消息节点、登录标志 | 通过 | 定稿 `src/preload/selectors.ts`；`tests/unit/selectors-contract.test.ts` 对真实 fixture 全绿：sessionItem 命中 100、messageItem/assistantMessage/inputBox/sendButton 均命中，signed-out 全部不命中。关键：稳定钩子是 `ds-*` 设计系统类 + `a[href*="/a/chat/s/"]` URL 结构，哈希 CSS-Module 类不作选择器 |
| 3 | 输入框注入是否被 React 接受 | 控制台 persisted=true | PENDING-USER-RUN | 待登录后按 `Ctrl+Shift+U`，读 `[probe] insert dispatched=... persisted=...` |
| 4 | 合成 paste 带 File 能否被页面接收 | 页面出现附件缩略图 | PENDING-USER-RUN | 待同一次 `Ctrl+Shift+U` 触发后人工看附件缩略图 + `[probe] paste=...` |
| 5 | 登录是否在 deepseek 域内完成 | did-navigate 全程 hostname 属于白名单 | 通过 | 导航日志全程停在 `chat.deepseek.com`（含 `/authorized?provider=WECHAT` 与 `/api/v0/users/oauth/wechat/callback`）；微信二维码是 `open.weixin.qq.com` 的嵌入 iframe，顶层文档 hostname 未越白名单 |

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
4. **UA 清洗生效（与产品壳同款环境）**：不仅 `loadURL` 覆盖了页面 UA，
   `persist:deepseek` 分区 session 也 `setUserAgent` 成清洗后的 UA，因此后续
   XHR/worker 请求头的 `User-Agent` 同样干净。实测：分区 session `setUserAgent`
   前 `... Electron/44.8.0 ...`，之后 `... Chrome/152.0.7977.167 Safari/537.36`；
   快照 `navigator.userAgent` 也不含 `Electron/` 与 `ds-shell/` 标记。
5. **日志链路打通**：`[probe] snapshot auto-00N url=...`、
   `[spike] navigate -> ...`、`[spike] in-page -> ...` 都能到达终端 stdout。
6. **自动循环不再破坏操作者草稿**：5 秒节拍只做快照，`[probe] insert=` 这类
   破坏性自测日志在非手动触发时**根本不出现**。实测两轮自动快照（auto-001..004）
   全程无 `insert=`；只有主进程收到显式 `spike:insert`（Ctrl+Shift+U）时才运行自测。
   未登录的签名页里，即便触发也只会 `insert=NO_EDITABLE`（登录表单是 `<input>`，
   不在注入自测的 `textarea/[contenteditable]/[role=textbox]` 选择器范围内）。
   风险 3/4 仍需登录后用真实输入框实测。

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
- **快照自动、破坏性自测手动**（本轮修复的核心变化，运行前务必了解）：
  - 每 5 秒**只自动落一份** `auto-NNN.json/.html` 快照——不写入、不聚焦、不动你的
    输入框，可以放心边操作边让它跑。上限 240 轮（约 20 分钟）后自动停探测。
  - 30 秒起每 30 秒再落一份 `manual.json/.html`（同样是纯快照），最多 40 次。
  - **注入 + 合成 paste 的破坏性自测不会自动运行**。只有当你按下 **`Ctrl+Shift+U`**
    时，主进程才会发出 `spike:insert`，probe 才对**当前第一个可编辑元素**
    （登录后即聊天输入框）跑一次自测。
- 关于 `Ctrl+Shift+U` 触发的那次自测——它会**碰你的输入框**，请知情后再按：
  - 字段里若已有你正在输入的文本（非历史 `DS_SHELL_SPIKE_` 令牌），自测会**跳过**
    并打印 `insert=SKIPPED_DIRTY`，绝不覆写你的草稿；
  - 字段为空（或只剩历史令牌）时才会写入 `DS_SHELL_SPIKE_<时间戳>` 令牌、测
    `persisted`，随后派发携带 `spike.png` 的合成 paste，最后**把此前的内容还原**；
  - ⚠️ 自测运行的大约 1 秒内，输入框里会短暂出现令牌文本，且 `spike.png` 附件
    一旦被页面接受就**不会自动移除**——测完后请确认你的草稿已回来、附件已丢弃，
    **切勿在自测进行中点发送**，否则可能把令牌和 spike.png 一起发出去。
- 采集风险 3/4 证据的正确姿势：先让输入框**空着**，按 `Ctrl+Shift+U`，读终端
  `[probe] insert dispatched=... persisted=...` 与 `paste=...` 两行，再人工看页面是否出现附件缩略图。
- 结束：直接关窗即可退出（已补 `win.on('closed')` / `window-all-closed`），
  也可 `Ctrl+C`；关窗后不会再有"对已销毁页面每 30 秒抛异常"的残留。
- 登录态保存在 `spike/m0/out/userdata`（partition `persist:deepseek`），重跑不必重复登录；
  要彻底重置就删该目录。
- 登录完成后至少留一份 `manual.json`（纯快照）再结束，供 Step 4 定选择器。
