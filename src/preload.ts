import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  getChannels: () => ipcRenderer.invoke('channels:getAll'),
  searchChannels: (query: string) => ipcRenderer.invoke('channels:search', query),
  playChannel: (url: string) => ipcRenderer.invoke('channels:play', url),
  getFavourites: () => ipcRenderer.invoke('favourites:getAll'),
  toggleFavourite: (streamUrl: string) => ipcRenderer.invoke('favourites:toggle', streamUrl),
  getCacheSize: () => ipcRenderer.invoke('cache:getSize'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
});
