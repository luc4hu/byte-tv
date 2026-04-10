export interface Channel {
  id: number;
  name: string;
  logo: string;
  group_title: string;
  stream_url: string;
  playlist_id: number;
}

export interface Category {
  name: string;
  count: number;
}

export interface Playlist {
  id: number;
  name: string;
  path: string | null;
  type: 'm3u' | 'xtream';
  added_date: string;
  channel_count: number;
}

export type ViewMode = 'channels' | 'categories' | 'favourites';

declare global {
  interface Window {
    electronAPI: {
      addPlaylist: () => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
      addPlaylistFromURL: (url: string) => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
      addXtreamPlaylist: (serverUrl: string, username: string, password: string) => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
      getPlaylists: () => Promise<Playlist[]>;
      deletePlaylist: (id: number) => Promise<void>;
      refreshPlaylist: (id: number) => Promise<{ count: number }>;
      getChannels: () => Promise<Channel[]>;
      searchChannels: (query: string) => Promise<Channel[]>;
      playChannel: (url: string) => Promise<void>;
      getFavourites: () => Promise<string[]>;
      toggleFavourite: (streamUrl: string) => Promise<{ isFavourite: boolean }>;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<void>;
      getCacheSize: () => Promise<number>;
      clearCache: () => Promise<number>;
    };
  }
}
