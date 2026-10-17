import type { IpcMainEvent } from 'electron';

export const IPC = {
  PAGE_EVENT: 'shell:page-event',
  OBSERVER_DEGRADED: 'shell:observer-degraded',
  INJECT_TEXT: 'shell:inject-text',
  STATE_SNAPSHOT: 'shell:state-snapshot',
  SEARCH_QUERY: 'shell:search-query',
  SEARCH_JUMP: 'shell:search-jump',
  JUMP_TO_SESSION: 'shell:jump-to-session',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// 主进程只接受远端窗口发来的上报，其它 webContents 一律拒绝。
export function makeSenderGuard(expectedWebContentsId: number) {
  return (event: IpcMainEvent): boolean => event.sender.id === expectedWebContentsId;
}
