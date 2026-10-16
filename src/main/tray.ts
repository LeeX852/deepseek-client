import { Menu, Tray, app, nativeImage } from 'electron';
import path from 'node:path';

export type TrayState = { unread: number; degraded: boolean };

export function buildTooltip(state: TrayState): string {
  if (state.degraded) return 'DeepSeek · 页面已改版，增强功能暂停';
  if (state.unread <= 0) return 'DeepSeek';
  return `DeepSeek · ${Math.min(state.unread, 99)}${state.unread > 99 ? '+' : ''} 条新回复`;
}

export type TrayActionId = 'show' | 'settings' | 'quit';

export function buildMenuActions(): Array<{ id: TrayActionId; label: string }> {
  return [
    { id: 'show', label: '显示 / 隐藏窗口' },
    { id: 'settings', label: '打开设置文件' },
    { id: 'quit', label: '退出（结束进程）' },
  ];
}

export function createTray(deps: { onToggle(): void; onShow(): void; onSettings(): void; onQuit(): void }) {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'out/resources/icon.png'));
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(buildTooltip({ unread: 0, degraded: false }));

  const template = buildMenuActions().map(a => ({
    label: a.label,
    click: () => (a.id === 'show' ? deps.onShow() : a.id === 'settings' ? deps.onSettings() : deps.onQuit()),
  }));
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('click', () => deps.onToggle());

  return {
    set(state: TrayState) { tray.setToolTip(buildTooltip(state)); },
    destroy() { tray.destroy(); },
  };
}

export type TrayHandle = ReturnType<typeof createTray>;
