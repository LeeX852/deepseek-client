# ds-shell

`chat.deepseek.com` 的 Electron 桌面壳（Windows 10+ x64）。登录一次长期保活、关闭窗口常驻托盘、全局快捷键随时唤起、窗口位置尺寸记忆、断网时停在自有覆盖层而不是 Chrome 错误页。

功能已全部落地（Plans 1–4 / M1–M4）：托盘常驻 + 全局快捷键唤起/隐藏、窗口状态记忆、离线覆盖层、会话归档与 Ctrl+K 搜索跳转、Ctrl+E 导出 Markdown、回答完成 / 登录过期通知、划词提问、Ctrl+O 本地文本文件注入、选择器失效自动降级与恢复（托盘可见）。

## 下载与安装

- **要求**：Windows 10+ x64。
- **安装版（推荐）**：`DeepSeek Shell 0.1.0-setup-x64.exe`——助手式向导、可选安装目录、每用户安装（免管理员 / 无 UAC）、桌面 + 开始菜单快捷方式、自带卸载器；卸载保留登录态。
- **免安装 portable**：`DeepSeek Shell 0.1.0-portable-win-x64.exe`——每次启动自解压到临时目录运行，适合不装东西直接试用。
- **下载**：GitHub Releases <https://github.com/LeeX852/deepseek-client/releases>（`v0.1.0`）。
- 产物**未做代码签名**：首次运行 Windows SmartScreen 会提示「未知发布者 / Windows 已保护你的电脑」，需手动选择「仍要运行」；消除该提示需要购买代码签名证书。

## 运行

```bash
pnpm install
pnpm dev          # 先 esbuild 打包再启动 Electron
```

其它脚本：`pnpm build`（打包 main/preload/静态资源到 `out/`）、`pnpm typecheck`、`pnpm test`（Vitest 单测）、`pnpm test:e2e`（Playwright `_electron` 集成测试）、`pnpm icon`（重新生成托盘图标）。

## 打包

```bash
pnpm exec electron-builder --win nsis portable
```

两个目标，产物在 `dist/`：

| 产物 | 说明 |
|---|---|
| `DeepSeek Shell 0.1.0-setup-x64.exe` | NSIS 安装版：助手式向导、可选安装目录、每用户安装（免管理员 / 无 UAC）、桌面 + 开始菜单快捷方式、自带卸载器 |
| `DeepSeek Shell 0.1.0-portable-win-x64.exe` | 免安装 portable，每次启动自解压到临时目录运行 |

安装版卸载时**保留**登录态（`deleteAppDataOnUninstall: false`）。产物**未做代码签名**：Windows SmartScreen 会提示「未知发布者 / Windows 已保护你的电脑」；消除它需要付费代码签名证书。

> **包后 userData 落点（2026-10-18 实测，已定论）**：打包态与 `pnpm dev` **共用同一个 profile** `%APPDATA%\ds-shell`；`%APPDATA%\DeepSeek Shell` 自始至终未被创建（Electron 的 `userData` 取自 `app.getName()`，即 package.json 的 `name`；electron-builder 不会把 `productName` 注入这里）。该目录跨运行稳定复用（两次启动 `window.json` mtime 11:01:41 → 11:02:25），登录态因此具备跨重启保活的机制前提，且 §15.1 已由真人登录 + 连开两次实测通过。此前「portable 模式下 userData 可能不持久」的担心未复现，故未加 `requestExecutionLevel` / 硬编码 userData 之类的预防性改动。详见 `.superpowers/sdd/2026-10-18-portable-packaging/verify-report.md`。

## 配置

设置文件是应用 `userData` 目录下的 `settings.json`。托盘右键菜单「打开设置文件」会直接定位到它——开发态与打包态是**同一个目录** `%APPDATA%\ds-shell\settings.json`（实测：不是 `%APPDATA%\DeepSeek Shell`，见「打包」）。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toggleHotkey` | string | `CommandOrControl+Alt+D` | 唤起 / 隐藏窗口的全局快捷键 |
| `quickAskHotkey` | string | `CommandOrControl+Alt+Q` | 划词提问快捷键 |
| `notifyOnAnswer` | boolean | `true` | 回答完成时通知 |
| `closeToTray` | boolean | `true` | 点窗口 X 时收进托盘而非退出进程 |
| `archiveEnabled` | boolean | `true` | 会话归档开关 |

改键**必须含修饰键**：写成 `"D"` 这类无修饰键的单一语法值会被设置层规范化回默认值（不触发冲突通知）。键被系统其它应用占用时，应用会弹一条「快捷键不可用」系统通知，而不是静默失灵。损坏的 `settings.json` 会被改名为 `.corrupt` 保留、回落默认值，不会静默覆盖你写过的内容。

## 设计边界（红线）

- 只在用户真实操作的页面窗口内读写 DOM，**绝不以脚本方式向 DeepSeek 内部接口发请求**，也不做并发自动化。社区反代项目记录的封号风险正来自这类调用。
- 归档数据只写本地 `userData`，无遥测；剪贴板只在用户显式按下划词快捷键时读取。
- 远端页面文本一律视为不可信数据：不作为 HTML 渲染、不拼成命令、不作为文件路径。跨进程负载经 zod 校验并带长度 / 条数上界。
- 远端窗口 `webPreferences`：`contextIsolation`、`sandbox`、`webSecurity` 全开，`nodeIntegration` 关闭；导航锁在 deepseek 域白名单内，外链交给系统浏览器。远端用 `persist:deepseek` 分区，本地覆盖层窗口用 `persist:shell`，两者物理隔离；不注册任何把本地文件系统暴露给远端页的自定义协议。
- `spike/` 是唯一允许 `sandbox: false` 的地方，且是一次性探针代码，不进产品主代码路径。
- 本项目是对 `chat.deepseek.com` 的非官方桌面封装，与 DeepSeek 官方无任何关联。

## M0 验证结论

见 [`spike/m0/REPORT.md`](spike/m0/REPORT.md)。

**当前状态：五项风险全部通过（2026-10-17 真人登录验证）。** 站点接受本环境并可登录；DOM 可达（稳定钩子是 `ds-*` 设计系统类 + `a[href*="/a/chat/s/"]` URL 结构，哈希 CSS-Module 类不可用）；React 受控输入框接受程序化写入（`persisted=true`）；合成 paste 带 File 能被页面接收（出现附件缩略图）；登录全程 hostname 停在 `chat.deepseek.com` 白名单内。

据此 `src/preload/selectors.ts` 与 `tests/fixtures/{logged-in,signed-out}.html` 已定稿，并由 `tests/unit/selectors-contract.test.ts` 锁成契约。**Plan 2（页面增强：归档 / 通知 / 划词注入 / 截图注入）解锁。**

远端页面结构变化时，先跑 `pnpm test` 的选择器契约测试报警，而不是靠用户发现。

## 手动验收清单

分两部分：**(a) 已有自动化 / 实测证据**，**(b) 仍需真机 + 人工过目**。发版前把 (b) 过一遍。

### (a) 已有自动化测试 / 实测证据

- [x] **登录后重启应用仍在登录态**（§15.1）。2026-10-18 真人登录后，用打包产物连开两次，两次都停在 `chat.deepseek.com/` 且输入框存在（不是 `/sign_in`），`1 passed (9.9s)`；输出 `RUN1={"url":"https://chat.deepseek.com/","signedIn":true,...}`，`RUN2` 相同。
  证据：`.superpowers/sdd/2026-10-18-portable-packaging/verify-report.md`。诚实备注：两次 `hasSessions` 均为 `false`（未读到侧边栏会话锚点，最可能是账号当时尚无历史会话），不影响本条判定，但归档 / 搜索（§15.6）需要账号里有真实历史会话才谈得上被检验。
- [x] **打包**：`pnpm exec electron-builder --win nsis portable` 退出码 0，产出 `dist\DeepSeek Shell 0.1.0-setup-x64.exe`（114,270,336 bytes，SHA256 `5b39984f…69591`）与 `dist\DeepSeek Shell 0.1.0-portable-win-x64.exe`（113,939,824 bytes，SHA256 `86392d5c…27fd4`），无安全软件拦截。
- [x] **安装包可装可卸，且卸载不动登录态**（2026-10-18 实测）：`setup-x64.exe /S` 静默安装（19.7s）落到 `%LOCALAPPDATA%\Programs\DeepSeek Shell`，桌面与开始菜单快捷方式均生成且指向安装版 exe，HKCU 注册表出现 `DeepSeek Shell 0.1.0` 卸载项；启动**安装版** exe（**不设** `DS_SHELL_USER_DATA`）仍是 `https://chat.deepseek.com/`、UA 不含 `Electron`/`ds-shell`、输入框存在（仍登录）；`Uninstall DeepSeek Shell.exe /S` 后安装目录、两个快捷方式、注册表项全清，而 `%APPDATA%\ds-shell`（`settings.json` + `Partitions\deepseek\Network\Cookies`）原样保留。
  证据：`.superpowers/sdd/2026-10-18-installer-release/verify-report.md`。未验证：干净机器安装、覆盖安装升级、代码签名（安装条目「发布者」为空，因为 `package.json` 没有 `author`）。
- [x] **单实例锁**：第一个实例存活时再启动，只多出一个 NSIS stub 进程，electron 进程数不变——不产生第二个应用实例。
- [x] **关闭主窗口进程存活**：点窗口 X 后主窗口隐藏、进程仍在（收进托盘），无幽灵图标残留。

### (b) 仍需真机 + 人工过目

以下条目因平台 API 限制无法进入自动化测试，且尚无实测证据，每次发版前人工过一遍：

- [ ] 托盘图标出现在系统通知区；悬停 tooltip 显示 `DeepSeek`（有未读时为 `DeepSeek · N 条新回复`，上限 `99+`；页面改版降级时显示 `DeepSeek · 页面已改版，增强功能暂停`）。
  原因：Electron 44 无 `Tray.getAllTrays`，且 `Tray` 实例没有 `getToolTip`/`getContextMenu` getter，无法从 e2e 枚举托盘并回读 tooltip（探测证据见 task-7-8 报告），不许把断言改成永真，故不入自动化用例。
- [ ] 托盘右键菜单恰为三项且顺序固定：`显示 / 隐藏窗口`、`打开设置文件`、`退出（结束进程）`；点击"退出"进程真正结束（可取消退出被禁止：Task 6 的 quitters/quitEmitted 是进程级永久闩）。
- [ ] 单击托盘图标切换窗口：可见且聚焦时隐藏，否则唤起并聚焦。
- [ ] 关闭主窗口（点 X）后仍可经托盘或快捷键唤起（"进程存活"已在 (a) 实测，此处指"再次唤起"）。
- [ ] 窗口位置尺寸重启后恢复；`window.json` 里的屏幕外坐标被忽略、回落默认尺寸。
- [ ] 在别的应用（如记事本）里按 `Ctrl+Alt+D`：DeepSeek 窗口唤起；再按一次隐藏。
- [ ] 快捷键冲突通知：把与系统其他应用占用的键写进 `settings.json` 的 `toggleHotkey`
  （须是语法合法组合，如某个已被输入法/工具占用的 `CommandOrControl+Alt+X`），重启后
  应收到"快捷键不可用"系统通知而不是静默失灵。
  注意：把 `toggleHotkey` 写成 `"D"` 这类无修饰键值**不会**触发通知——设置层会把它
  规范化回默认值（单一语法 F4 裁决的既定行为）。
  Windows 通知依赖 AppUserModelID：开发态 `pnpm dev` 可见；打包态下的表现尚未验证
  （探测记录：本机 Electron 44 `Notification.isSupported() === true`）。
- [ ] 断网时出现自有覆盖层且无 Chrome 错误页，恢复网络点"重新加载"可回到对话且登录态仍在。
