import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Playlists
  addPlaylist: () => ipcRenderer.invoke('playlists:add'),
  addPlaylistFromURL: (url: string) => ipcRenderer.invoke('playlists:addFromURL', url),
  addXtreamPlaylist: (serverUrl: string, username: string, password: string) => ipcRenderer.invoke('playlists:addXtream', serverUrl, username, password),
  getPlaylists: () => ipcRenderer.invoke('playlists:getAll'),
  deletePlaylist: (id: number) => ipcRenderer.invoke('playlists:delete', id),
  refreshPlaylist: (id: number) => ipcRenderer.invoke('playlists:refresh', id),

  // Channels
  getChannels: () => ipcRenderer.invoke('channels:getAll'),
  searchChannels: (query: string) => ipcRenderer.invoke('channels:search', query),
  playChannel: (url: string) => ipcRenderer.invoke('channels:play', url),

  // History
  getHistory: () => ipcRenderer.invoke('history:getAll'),

  // Favourites
  getFavourites: () => ipcRenderer.invoke('favourites:getAll'),
  toggleFavourite: (streamUrl: string) => ipcRenderer.invoke('favourites:toggle', streamUrl),

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),

  // Cache
  getCacheSize: () => ipcRenderer.invoke('cache:getSize'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
});
