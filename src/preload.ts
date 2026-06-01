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
  onRefreshProgress: (callback: (progress: { phase: string; percent?: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { phase: string; percent?: number }) => callback(progress);
    ipcRenderer.on('playlists:refreshProgress', handler);
    return () => { ipcRenderer.removeListener('playlists:refreshProgress', handler); };
  },

  // Channels
  getChannels: () => ipcRenderer.invoke('channels:getAll'),
  searchChannels: (query: string) => ipcRenderer.invoke('channels:search', query),
  playChannel: (url: string, skipHistory?: boolean) => ipcRenderer.invoke('channels:play', url, skipHistory),

  // History
  getHistory: () => ipcRenderer.invoke('history:getAll'),

  // Favourites
  getFavourites: () => ipcRenderer.invoke('favourites:getAll'),
  toggleFavourite: (streamUrl: string) => ipcRenderer.invoke('favourites:toggle', streamUrl),

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),

  });
