# ds-shell

DeepSeek 桌面壳（开发中）。本 README 目前只承载手动验收清单，随任务推进补全打包与使用说明。

## 手动验收清单

以下条目因平台 API 限制无法进入自动化测试，每次发版前人工过一遍：

- [ ] 托盘图标出现在系统通知区；悬停 tooltip 显示 `DeepSeek`（有未读时为 `DeepSeek · N 条新回复`，上限 `99+`；页面改版降级时显示 `DeepSeek · 页面已改版，增强功能暂停`）。
  原因：Electron 44 无 `Tray.getAllTrays`，且 `Tray` 实例没有 `getToolTip`/`getContextMenu` getter，无法从 e2e 枚举托盘并回读 tooltip（探测证据见 task-7-8 报告），不许把断言改成永真，故不入自动化用例。
- [ ] 托盘右键菜单恰为三项且顺序固定：`显示 / 隐藏窗口`、`打开设置文件`、`退出（结束进程）`；点击"退出"进程真正结束（可取消退出被禁止：Task 6 的 quitters/quitEmitted 是进程级永久闩）。
- [ ] 单击托盘图标切换窗口：可见且聚焦时隐藏，否则唤起并聚焦。
- [ ] 关闭主窗口（点 X）后应用仍活在托盘里，再经托盘或快捷键唤起。
- [ ] 在别的应用（如记事本）里按 `Ctrl+Alt+D`：DeepSeek 窗口唤起；再按一次隐藏。
- [ ] 快捷键冲突通知：把与系统其他应用占用的键写进 `settings.json` 的 `toggleHotkey`
  （须是语法合法组合，如某个已被输入法/工具占用的 `CommandOrControl+Alt+X`），重启后
  应收到"快捷键不可用"系统通知而不是静默失灵。
  注意：把 `toggleHotkey` 写成 `"D"` 这类无修饰键值**不会**触发通知——设置层会把它
  规范化回默认值（单一语法 F4 裁决的既定行为）。
  Windows 通知依赖 AppUserModelID：开发态 `pnpm dev` 可见；打包 portable 后的表现留待
  Task 10 验收（探测记录：本机 Electron 44 `Notification.isSupported() === true`）。
