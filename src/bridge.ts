import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, confirm } from '@tauri-apps/plugin-dialog';

export const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> => invoke<T>(command, args);
export const pickFolder = (): Promise<string | null> => open({ directory: true, multiple: false, title: 'Open a Git repository' });
export const ask = (message: string): Promise<boolean> => confirm(message, { title: 'agentic-review', kind: 'warning' });
export async function handleClose(check: () => Promise<boolean>): Promise<void> {
  const window = getCurrentWindow();
  await window.onCloseRequested(async event => {
    event.preventDefault();
    if (await check()) await window.destroy();
  });
}
