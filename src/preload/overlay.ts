import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ipcRenderer', {
  send: (channel: string) => {
    if (channel === 'overlay:retry') ipcRenderer.send(channel);
  },
});
