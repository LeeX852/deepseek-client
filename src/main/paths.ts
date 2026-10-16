import { app } from 'electron';

export function userDataDir(): string {
  return process.env.DS_SHELL_USER_DATA ?? app.getPath('userData');
}
