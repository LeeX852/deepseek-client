import { createRequire } from 'node:module';
import type { IpcMain, IpcMainEvent } from 'electron';
import { IPC } from '../shared/ipc';
import { pageEventSchema, type PageEvent } from '../shared/pageEvent';

// 纯 handler 的入参契约：只依赖发送方 id 与待校验负载，不引用 Electron 的 IpcMainEvent
// （其上没有 payload —— 真实 IPC 里负载是监听器的位置参数，不是事件属性）。
// 因此单测（node 环境）可原样 import buildPageEventHandler 而不加载 Electron。
export type PageEventSource = {
  readonly sender: { readonly id: number };
  readonly payload: unknown;
};

// 拆两层：buildPageEventHandler 纯、可测；registerPageEvents 才接线 ipcMain。
// 同 hotkeys.ts —— electron 在纯 Node 下主导出是二进制路径字符串，命名 ESM 绑定拿不到
// ipcMain，故用 createRequire 惰性取，只在主进程真正调用 registerPageEvents 时加载。
export function buildPageEventHandler(deps: {
  expectedId(): number;
  onEvent(e: PageEvent): void;
  onDegraded(): void;
}) {
  return (source: PageEventSource): void => {
    // 只接受远端窗口当前 webContents 的上报；id 每次现取，窗口重载后仍跟手。
    if (source.sender.id !== deps.expectedId()) return;
    const parsed = pageEventSchema.safeParse(source.payload);
    if (!parsed.success) return;
    // I-1（spec §8）：下游 onEvent 会触达归档落盘等 fs 操作。任何一次处理抛错都
    // 绝不能冒到 ipcMain 监听器把主进程打死——记日志后吞掉，聊天与后续事件照常。
    try {
      deps.onEvent(parsed.data);
    } catch (err) {
      console.error('[ds-shell] page-event 处理抛错（已隔离，主进程不受影响）:', err);
    }
  };
}

export function registerPageEvents(deps: {
  expectedWebContentsId(): number;
  onEvent(e: PageEvent): void;
  onDegraded(): void;
}) {
  const { ipcMain } = createRequire(import.meta.url)('electron') as { ipcMain: IpcMain };
  // deps 对外契约名 expectedWebContentsId，内部 handler 契约名 expectedId：显式适配而非透传，
  // 避免两处字段名不一致导致类型检查失败。
  const handler = buildPageEventHandler({
    expectedId: () => deps.expectedWebContentsId(),
    onEvent: (e) => deps.onEvent(e),
    onDegraded: () => deps.onDegraded(),
  });
  // Electron IPC：payload 是监听器第二个位置参数，组装成纯 handler 的 PageEventSource 入参。
  const pageListener = (event: IpcMainEvent, payload: unknown): void => {
    handler({ sender: { id: event.sender.id }, payload });
  };
  const degradedListener = (event: IpcMainEvent): void => {
    if (event.sender.id === deps.expectedWebContentsId()) deps.onDegraded();
  };
  ipcMain.on(IPC.PAGE_EVENT, pageListener);
  ipcMain.on(IPC.OBSERVER_DEGRADED, degradedListener);
  return {
    dispose() {
      ipcMain.removeListener(IPC.PAGE_EVENT, pageListener);
      ipcMain.removeListener(IPC.OBSERVER_DEGRADED, degradedListener);
    },
  };
}
