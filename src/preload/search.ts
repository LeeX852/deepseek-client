import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
contextBridge.exposeInMainWorld('searchApi', {
  query: (q: string) => ipcRenderer.invoke(IPC.SEARCH_QUERY, { query: q }),
  jump: (title: string) => ipcRenderer.send(IPC.SEARCH_JUMP, { title }),
});
