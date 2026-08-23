import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // App
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Playlists
  addPlaylistFromURL: (name: string, url: string) => ipcRenderer.invoke('playlists:addFromURL', name, url),
  addXtreamPlaylist: (name: string, serverUrl: string, username: string, password: string) => ipcRenderer.invoke('playlists:addXtream', name, serverUrl, username, password),
  getXtreamPlaylistDetails: (id: number) => ipcRenderer.invoke('playlists:getXtreamDetails', id),
  updateXtreamPlaylist: (id: number, name: string, serverUrl: string, username: string, password: string) => ipcRenderer.invoke('playlists:updateXtream', id, name, serverUrl, username, password),
  getPlaylists: () => ipcRenderer.invoke('playlists:getAll'),
  deletePlaylist: (id: number) => ipcRenderer.invoke('playlists:delete', id),
  refreshPlaylist: (id: number) => ipcRenderer.invoke('playlists:refresh', id),
  onRefreshProgress: (callback: (progress: { playlistId: number; phase: string; percent?: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { playlistId: number; phase: string; percent?: number }) => callback(progress);
    ipcRenderer.on('playlists:refreshProgress', handler);
    return () => { ipcRenderer.removeListener('playlists:refreshProgress', handler); };
  },

  // Channels
  getChannels: () => ipcRenderer.invoke('channels:getAll'),
  playChannel: (url: string, skipHistory?: boolean) => ipcRenderer.invoke('channels:play', url, skipHistory),

  // History
  getHistory: () => ipcRenderer.invoke('history:getAll'),

  // Favourites
  getFavourites: () => ipcRenderer.invoke('favourites:getAll'),
  toggleFavourite: (streamUrl: string) => ipcRenderer.invoke('favourites:toggle', streamUrl),
  getFavouriteCategories: () => ipcRenderer.invoke('favourites:getCategories'),
  toggleFavouriteCategory: (categoryName: string) => ipcRenderer.invoke('favourites:toggleCategory', categoryName),

  // Stream check
  runStreamCheck: (urls: string[]) => ipcRenderer.invoke('streamcheck:run', urls),
  cancelStreamCheck: () => ipcRenderer.invoke('streamcheck:cancel'),
  onStreamCheckResult: (callback: (result: { streamUrl: string; status: string; width?: number; height?: number; fps?: number; hdr?: boolean; error?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: { streamUrl: string; status: string; width?: number; height?: number; fps?: number; hdr?: boolean; error?: string }) => callback(result);
    ipcRenderer.on('streamcheck:result', handler);
    return () => { ipcRenderer.removeListener('streamcheck:result', handler); };
  },

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),

  // Logging
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  logFromRenderer: (level: string, message: string) => ipcRenderer.invoke('logs:fromRenderer', level, message),
  openLogsWindow: () => ipcRenderer.invoke('logs:openWindow'),
});
