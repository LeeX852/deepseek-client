import { app, BrowserWindow } from 'electron';
import { createShellWindow } from './shellWindow';

if (process.env.DS_SHELL_USER_DATA) {
  app.setPath('userData', process.env.DS_SHELL_USER_DATA);
}

void app.whenReady().then(() => {
  createShellWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createShellWindow();
  });
});
