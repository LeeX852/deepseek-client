# ds-shell

`chat.deepseek.com` 的 Electron 桌面壳（Windows 10+ x64，本机自用）。登录一次长期保活、关闭窗口常驻托盘、全局快捷键随时唤起、窗口位置尺寸记忆、断网时停在自有覆盖层而不是 Chrome 错误页。

远端页面增强（会话归档、回答通知、划词提问等）属于 Plan 2，尚未实现；Plan 2 的可行性由 `spike/m0/` 的前置验证结论决定（见下）。

## 运行

```bash
pnpm install
pnpm dev          # 先 esbuild 打包再启动 Electron
```

其它脚本：`pnpm build`（打包 main/preload/静态资源到 `out/`）、`pnpm typecheck`、`pnpm test`（Vitest 单测）、`pnpm test:e2e`（Playwright `_electron` 集成测试）、`pnpm icon`（重新生成托盘图标）。

## 打包

```bash
pnpm exec electron-builder --win portable
```

产物：`dist/DeepSeek Shell <version>-portable-win-x64.exe`（免安装 portable，不做安装包 / 自动更新 / macOS / Linux）。

> portable exe 每次启动会自解压到临时目录运行。**登录态是否能跨重启保活必须实测**：Electron 在 portable 模式下的 `userData` 落点由打包配置决定，若发现重启后需要重新登录，按计划 Task 10 的既定处置——在 `electron-builder.yml` 的 `portable` 段加 `requestExecutionLevel: user`，并把 `src/main/paths.ts` 的 `userDataDir()` 指到 `path.join(app.getPath('appData'), 'ds-shell')`。不要假定默认配置就一定持久。

## 配置

设置文件是应用 `userData` 目录下的 `settings.json`。托盘右键菜单「打开设置文件」会直接定位到它——开发态通常是 `%APPDATA%\ds-shell\settings.json`，打包后随 `productName` 变为 `%APPDATA%\DeepSeek Shell\settings.json`。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toggleHotkey` | string | `CommandOrControl+Alt+D` | 唤起 / 隐藏窗口的全局快捷键 |
| `quickAskHotkey` | string | `CommandOrControl+Alt+Q` | 划词提问快捷键（Plan 2 使用，当前仅唤起窗口） |
| `notifyOnAnswer` | boolean | `true` | 回答完成时通知（Plan 2 消费） |
| `closeToTray` | boolean | `true` | 点窗口 X 时收进托盘而非退出进程 |
| `archiveEnabled` | boolean | `true` | 会话归档开关（Plan 2 消费） |

改键**必须含修饰键**：写成 `"D"` 这类无修饰键的单一语法值会被设置层规范化回默认值（不触发冲突通知）。键被系统其它应用占用时，应用会弹一条「快捷键不可用」系统通知，而不是静默失灵。损坏的 `settings.json` 会被改名为 `.corrupt` 保留、回落默认值，不会静默覆盖你写过的内容。

## 设计边界（红线）

- 只在用户真实操作的页面窗口内读写 DOM，**绝不以脚本方式向 DeepSeek 内部接口发请求**，也不做并发自动化。社区反代项目记录的封号风险正来自这类调用。
- 归档数据只写本地 `userData`，无遥测；剪贴板只在用户显式按下划词快捷键时读取。
- 远端页面文本一律视为不可信数据：不作为 HTML 渲染、不拼成命令、不作为文件路径。跨进程负载经 zod 校验并带长度 / 条数上界。
- 远端窗口 `webPreferences`：`contextIsolation`、`sandbox`、`webSecurity` 全开，`nodeIntegration` 关闭；导航锁在 deepseek 域白名单内，外链交给系统浏览器。远端用 `persist:deepseek` 分区，本地覆盖层窗口用 `persist:shell`，两者物理隔离；不注册任何把本地文件系统暴露给远端页的自定义协议。
- `spike/` 是唯一允许 `sandbox: false` 的地方，且是一次性探针代码，不进产品主代码路径。

## M0 验证结论

见 [`spike/m0/REPORT.md`](spike/m0/REPORT.md)。

**当前状态：`PENDING-USER-RUN`。** spike 代码已就绪并在未登录态跑通（页面正常渲染真实登录页、preload 能读 DOM 落盘、UA 清洗生效），但五项风险结论——站点是否接受登录、DOM 可达性、React 输入注入是否被接受、合成 paste 带 File、登录是否全程在白名单域内——**必须由真人登录跑完 `spike/m0` 的 Step 3 后才能定稿**。

因此 `src/preload/selectors.ts` 与 `tests/fixtures/*`（选择器契约测试）在本仓库中**有意不存在**：没有真实登录态会话数据之前写选择器就是编造。执行人按 `REPORT.md` 的「运行说明」登录后，用 `Ctrl+Shift+U` 采集注入 / paste 证据，据产物定稿选择器并回填五项结论。若结论 1 或 2 为「不通过」，则停止、不进入 Plan 2。

远端页面结构变化时，先跑 `pnpm test` 的选择器契约测试（定稿后）报警，而不是靠用户发现。

## 手动验收清单

以下条目因平台 API 限制无法进入自动化测试，每次发版前人工过一遍：

- [ ] 登录后重启应用仍在登录态（`persist:deepseek` 分区持久化生效）。
- [ ] 托盘图标出现在系统通知区；悬停 tooltip 显示 `DeepSeek`（有未读时为 `DeepSeek · N 条新回复`，上限 `99+`；页面改版降级时显示 `DeepSeek · 页面已改版，增强功能暂停`）。
  原因：Electron 44 无 `Tray.getAllTrays`，且 `Tray` 实例没有 `getToolTip`/`getContextMenu` getter，无法从 e2e 枚举托盘并回读 tooltip（探测证据见 task-7-8 报告），不许把断言改成永真，故不入自动化用例。
- [ ] 托盘右键菜单恰为三项且顺序固定：`显示 / 隐藏窗口`、`打开设置文件`、`退出（结束进程）`；点击"退出"进程真正结束（可取消退出被禁止：Task 6 的 quitters/quitEmitted 是进程级永久闩）。
- [ ] 单击托盘图标切换窗口：可见且聚焦时隐藏，否则唤起并聚焦。
- [ ] 关闭主窗口（点 X）后应用仍活在托盘里，再经托盘或快捷键唤起。
- [ ] 窗口位置尺寸重启后恢复；`window.json` 里的屏幕外坐标被忽略、回落默认尺寸。
- [ ] 在别的应用（如记事本）里按 `Ctrl+Alt+D`：DeepSeek 窗口唤起；再按一次隐藏。
- [ ] 快捷键冲突通知：把与系统其他应用占用的键写进 `settings.json` 的 `toggleHotkey`
  （须是语法合法组合，如某个已被输入法/工具占用的 `CommandOrControl+Alt+X`），重启后
  应收到"快捷键不可用"系统通知而不是静默失灵。
  注意：把 `toggleHotkey` 写成 `"D"` 这类无修饰键值**不会**触发通知——设置层会把它
  规范化回默认值（单一语法 F4 裁决的既定行为）。
  Windows 通知依赖 AppUserModelID：开发态 `pnpm dev` 可见；打包 portable 后的表现留待
  Task 10 验收（探测记录：本机 Electron 44 `Notification.isSupported() === true`）。
- [ ] 断网时出现自有覆盖层且无 Chrome 错误页，恢复网络点"重新加载"可回到对话且登录态仍在。
