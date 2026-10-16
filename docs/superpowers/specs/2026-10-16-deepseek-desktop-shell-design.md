# DeepSeek 桌面客户端（日常壳）设计文档

日期：2026-10-16
状态：已与用户逐段确认，待用户审阅本文
范围代号：V1

## 1. 背景与目标

用户当前的使用方式是每次从浏览器打开 `https://chat.deepseek.com/`，希望搬到一个真正的桌面应用里：登录一次长期保活、随时唤起、有系统级集成，并且能配合本地文件做提问。

项目名 `ds-shell`，位于 `D:\Programs\ds-web-client`。

## 2. 已确认的关键决策

以下决策各有被否决的替代方案，记录原因以免日后重复讨论。

| 决策 | 选择 | 被否决的方案与原因 |
|---|---|---|
| 对话能力来源 | 加载真实网页，复用用户登录态 | 自研 UI 调 `api.deepseek.com`：需单独充值 API Key，与网页版免费额度不互通，且深度思考/联网搜索/文件解析要自己实现 |
| 形态 | 混合：网页为内核 + 原生外壳增强 | 纯套壳：拿不到托盘/快捷键/通知/剪贴板带来的价值；纯原生：成本与风险都高一个量级 |
| 运行时 | Electron | Tauri：托盘、快捷键、通知、文件系统多数要走 Rust 侧，需装 Rust 工具链，往远程页注入能力更弱，Windows WebView2 行为偶有不一致；PWA/`--app` 快捷方式：做不到原生增强 |
| 工作区 Agent（"工作模式"） | 移出 V1，日后单独立项 | 官方 [DeepSeek Harness 桌面端](https://www.deepseek.com/download/)（2026-09-29 v0.2 预览版）已覆盖"登录账号 + 选工作区 + Agent 任务"，自研其子集成本高且难以更好 |
| 会话数据获取 | 只读已渲染 DOM | 拦截内部 API 响应：接口一改即断，且属于对私有接口的抓取，账号风控风险显著更高 |
| 分发 | 本机自用，portable 产物 | 安装包 + 自动更新 + 签名：当前不需要，避免维护发布渠道 |

## 3. 红线（安全与合规约束）

1. **绝不以脚本方式直接向 DeepSeek 内部接口发请求**，不做并发自动化。社区反代项目（`deepseek-free-api`、`ds2api`）记录的风险包括 PoW 求解、token 刷新，以及单账号并发超过 2 触发封号。本项目只在用户真实操作的页面里读写 DOM。
2. **归档数据只落本地 `userData`，不上传、不遥测。** 内容是聊天原文，属于敏感数据。
3. **剪贴板只在用户显式按下快捷键时读取**，不做后台轮询。
4. **不可信输入原则**：远端页面文本一律视为不可信数据，不作为 HTML 渲染、不拼成命令、不做路径。
5. **不伪装非浏览器环境的正当性**：覆写 User-Agent 的目的是让站点接受一个正常的浏览器窗口（Electron 默认 UA 含 `electron` 字样），不是绕过反自动化或风控。

## 4. 架构

三个上下文，职责不重叠，可独立理解和测试。

- **主进程（Node）**：所有"桌面"能力。窗口、托盘、全局快捷键、通知、剪贴板、文件选择、设置与归档存储、IPC 路由。
- **DeepSeek 预加载脚本**：唯一能接触 `chat.deepseek.com` DOM 的组件。运行在同渲染进程的隔离上下文，有 DOM 访问权，通过 `contextBridge` 只暴露白名单上报/注入能力。
  - 选 preload 而非 `webContents.executeJavaScript` 注入：远端有 CSP，注入脚本易被拦且难调试；preload 直接读 DOM + 发 IPC，绕开 CSP 问题。
- **本地 UI 窗口**：快捷提问浮层、会话搜索面板、离线错误覆盖层。自己的页面和自己的分区。

分区隔离：远端窗口用 `persist:deepseek`，本地窗口用 `persist:shell`。DeepSeek 的 cookie 不会进入我们的 UI，我们的 UI 也拿不到登录态。

## 5. 模块划分

每个模块一件事，只依赖表中所列。

| 模块 | 职责 | 依赖 |
|---|---|---|
| `main/settings.ts` | `userData/settings.json` 读写、默认值、版本迁移 | 无 |
| `main/windowState.ts` | 窗口位置尺寸与最大化状态的序列化 | settings |
| `main/shellWindow.ts` | 主窗口生命周期、加载远端、关闭即隐藏到托盘、显示/聚焦/真正退出 | windowState, settings |
| `main/tray.ts` | 托盘图标与菜单、未读与降级状态提示 | shellWindow |
| `main/hotkeys.ts` | 全局快捷键注册、改键、冲突检测与重注册 | settings, shellWindow, quickAsk |
| `main/quickAsk.ts` | 划词/截图提问：读剪贴板 → 投递注入请求 | shellWindow |
| `main/fileInject.ts` | 本地文本文件选取 → 限大小与编码校验读取 → 拼引用块 → 投递注入 | shellWindow |
| `main/pageEvents.ts` | 预加载上报的唯一入口：校验发送方与负载后分发 | shared schema |
| `main/notifications.ts` | 回复完成/登录过期 → 系统通知，带节流与点击聚焦 | pageEvents, settings |
| `main/archive/store.ts` | DOM 快照去重合并、原子写入、容量上限、损坏回滚 | pageEvents |
| `main/archive/export.ts` | 会话转 Markdown | store |
| `main/ipc.ts` | IPC 通道契约：通道名、负载 schema、发送方校验 | shared schema |
| `preload/deepseek.ts` | DOM observer（会话列表、回答完成、登录态）、输入框注入、侧边栏定位点击 | shared schema |
| `renderer/*` | 三个本地窗口的 UI | shared schema |

`shared/` 存放主进程与预加载/渲染共用的类型与 schema，是唯一的跨进程契约来源。

## 6. 数据流

**启动。** 读 settings 与窗口状态 → 创建主窗口（覆写 UA 为标准 Chrome UA）→ 加载远端 → 注册托盘与全局快捷键。

**页面事件（唯一数据入口）。** preload 的 observer 把 DOM 变化归一化为三类事件：`session-list-changed`、`answer-completed`、`auth-state-changed`。主进程 `pageEvents` 校验发送方身份与负载 schema 后分发：`answer-completed` → 通知；`session-list-changed` 与当前对话文本 → 归档。

**划词提问。** 快捷键 → 主进程读剪贴板 → 投递注入请求 → preload 定位输入框、聚焦、写入。写入必须使用原生 value setter + 派发 `input` 事件，或 `document.execCommand('insertText')`；直接赋值 `value` 会被 React 受控组件的内部状态覆盖。这是此功能能否工作的技术核心，列为前置验证项。

**本地文件到对话框。** 三条路径，能力边界明确：
- 用户自行点击官方上传按钮（Electron 正常弹出系统文件框）——零实现。
- 用户从资源管理器拖文件进窗口（页面自身的原生 drop 行为）——零实现。
- 我们代劳的只有文本与图片：文本读内容拼成引用块注入输入框；图片写剪贴板后向页面派发 `paste` 事件。
- **做不到的**：程序化设置 `<input type=file>.files`，Electron 安全模型禁止。PDF/Word 一律走前两条路径。

**会话搜索跳转。** 不猜测 URL 中的会话 id（DeepSeek 的 URL 结构无稳定性保证）。让 preload 在侧边栏 DOM 内按标题定位条目并 `.click()`。

## 7. 安全配置

远端窗口：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`、`allowRunningInsecureContent: false`。不注册任何把本地文件系统暴露给远端页的自定义协议。

导航与弹出：`will-navigate` 限制在 deepseek 域内，其余拒绝；`setWindowOpenHandler` 仅白名单外链交 `shell.openExternal`，其余拒绝。

IPC：主进程对每条消息校验 `event.sender` 对应的 webContents 与分区，只接受白名单通道名与通过 schema 校验的负载；通知与 UI 渲染时截断长度并按纯文本处理。

## 8. 降级策略（核心设计原则：壳绝不能弄坏聊天）

| 故障 | 行为 |
|---|---|
| 选择器连续 3 轮全部失效 | observer 自我禁用，归档与通知标记 `degraded`，仅在托盘 tooltip 提示一次，不弹窗 |
| `did-fail-load` / 离线 | 显示本地错误覆盖层并提供重试，不留在 Chrome 错误页 |
| `render-process-gone` | 重载窗口并提示一次 |
| 归档文件损坏 | 临时文件 + rename 原子写；校验失败回滚上一份完好副本 |
| 归档超限 | 保留最近 200 个会话，且归档总体积上限 100MB，超限按最旧淘汰 |
| 全局快捷键被占用 | 注册失败时在设置里提示并允许改键，不静默失败 |
| 登录态失效 | 通知提示，聚焦窗口到页面自身的登录入口，不代填凭据 |

通知节流：同一会话 30 秒内不重复，全局每分钟最多 3 条。文本文件注入上限：单个文件 512KB，超限时提示用户改用拖放。

## 9. 外壳 UI 设计

主内容区就是官方页面，本项目的视觉只作用于三个本地窗口：快捷提问浮层、会话搜索面板、离线错误覆盖层，以及托盘菜单文案。

方向：**贴近官方风格、克制**。取官方页面的中性浅灰底、蓝色强调、无装饰性投影的卡片与圆角输入框，字体沿用系统 UI 字体栈；浮层保持小面积、无标题栏、可键盘完成全部操作。设计令牌集中在 `renderer/tokens.css`，实现前从真实页面取样一次并记录取样时间，因为官方配色会随版本变化。

具体视觉方案由选用的前端设计扩展在实现阶段产出，见第 12 节。

## 10. 测试策略

1. **纯逻辑单测（Vitest）**：窗口状态序列化、归档去重与合并、Markdown 导出、设置迁移、IPC 负载校验。相关模块设计为不依赖 Electron，因此可直接跑在 Node。
2. **Electron 集成测试（Playwright 驱动 Electron）**：隐藏与唤起、窗口状态恢复、IPC 往返、离线覆盖层显示。
3. **DOM 契约测试（最关键）**：把某一时刻页面的真实 DOM 存成 fixture，断言 observer 仍能提取会话列表、消息与登录态。选择器失效由测试报警，而不是等用户发现历史没存上。附带一个抓取 fixture 的脚本。
4. **手动验收清单**：登录态跨重启保活、注入文本被 React 真正接收、窗口未聚焦时系统通知能弹出、拖放上传可用、导出 Markdown 可读、快捷键改键生效。

无法自动化保证的部分：远端页面随官方变更，契约测试是尽力检测而非保证。

## 11. 前置验证（写代码前必须先做，验不过就回到设计）

| 风险 | 验证方式 | 不成立时的后果 |
|---|---|---|
| 站点拒绝 Electron 环境 | portable spike 打开页面并登录 | 需要调整 UA/窗口配置；若持续被拒，整个路线不可行 |
| preload 在该页的 DOM 可达性与 CSP 影响 | spike 中打印 observer 是否能读到会话列表与消息节点 | 归档/通知无法实现，退化为纯基础壳 |
| 输入框注入是否被 React 接受 | spike 中对真实输入框做注入并检查页面状态 | 划词与文本文件注入失效，改为提示用户手动粘贴 |
| 登录是否在 deepseek 域内完成 | spike 中走一遍登录流程 | 需放宽 `will-navigate` 白名单 |

## 12. 工具依赖

外壳 UI 的视觉方案设计借助一个前端设计类扩展产出。候选已在本机扩展市场检索，由用户选定后安装；未选定则按第 9 节的令牌手工实现。

## 13. 技术栈与目录结构

pnpm + TypeScript（strict）+ Electron + electron-builder（portable 目标）+ Vitest + Playwright + ESLint/Prettier。

```
src/main/        主进程模块（见第 5 节）
src/preload/     deepseek 预加载与本地窗口预加载
src/renderer/    快捷提问浮层 / 搜索面板 / 离线覆盖层
src/shared/      跨进程类型与 IPC schema
scripts/         fixture 抓取、选择器体检
docs/superpowers/specs/  本文档
```

## 14. V1 非范围

工作区 Agent 与"工作模式"切换、程序化文件上传、内部 API 拦截、多账号 profile 隔离、自动更新、macOS/Linux 产物、界面主题自定义。

## 15. 验收标准

以下条件全部满足才算 V1 完成：

1. 首次登录后重启应用仍在登录态，无需重新登录。
2. 关闭窗口后应用常驻托盘，全局快捷键可在任意应用中唤起并聚焦，二次按键隐藏。
3. 窗口位置与尺寸在重启后恢复。
4. 在别的应用里选中文字，按快捷键后文本出现在 DeepSeek 输入框且能直接发送。
5. 长回答生成完成且窗口未聚焦时收到一条系统通知，点击回到窗口；有节流不刷屏。
6. 会话搜索能命中已归档会话并跳转到它。
7. 当前会话可导出为 Markdown 文件。
8. 模拟选择器失效后，聊天本身不受影响，应用进入 `degraded` 状态并可从托盘看出。
9. 断网时显示本地错误覆盖层与重试，不出现 Chrome 错误页。
10. 第 10 节的四类测试全部有实际用例并跑通。

## 16. 里程碑

M0 前置验证（第 11 节四项）→ M1 基础壳（主窗口、托盘、快捷键、窗口记忆、设置）→ M2 事件与增强（observer 上报、通知、划词/截图注入、文本文件注入）→ M3 归档与搜索（store、导出、搜索面板、契约测试与 fixture 脚本）→ M4 打磨（离线覆盖层、降级提示、验收清单跑通）。
