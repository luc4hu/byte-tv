import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogsFolder: () => ipcRenderer.invoke('logs:openFolder'),
  onLogEntry: (callback: (entry: { ts: string; level: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: { ts: string; level: string; message: string }) => callback(entry);
    ipcRenderer.on('logs:entry', handler);
    return () => { ipcRenderer.removeListener('logs:entry', handler); };
  },
  logFromRenderer: (level: string, message: string) =>
    ipcRenderer.invoke('logs:fromRenderer', level, message),
});
