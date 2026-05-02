export interface Channel {
  id: number;
  name: string;
  logo: string;
  group_title: string;
  stream_url: string;
  playlist_id: number;
  playlist_name: string;
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

export type ViewMode = 'channels' | 'categories' | 'history' | 'favourites';

export interface RefreshProgress {
  phase: 'downloading' | 'parsing' | 'inserting';
  percent?: number; // 0-100, only during downloading phase when Content-Length is known
}

declare global {
  interface Window {
    electronAPI: {
      addPlaylistFromURL: (name: string, url: string) => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
      addXtreamPlaylist: (name: string, serverUrl: string, username: string, password: string) => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
      getPlaylists: () => Promise<Playlist[]>;
      deletePlaylist: (id: number) => Promise<void>;
      refreshPlaylist: (id: number) => Promise<{ count: number }>;
      onRefreshProgress: (callback: (progress: RefreshProgress) => void) => () => void;
      getChannels: () => Promise<Channel[]>;
      searchChannels: (query: string) => Promise<Channel[]>;
      playChannel: (url: string, skipHistory?: boolean) => Promise<void>;
      getHistory: () => Promise<string[]>;
      getFavourites: () => Promise<string[]>;
      toggleFavourite: (streamUrl: string) => Promise<{ isFavourite: boolean }>;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<void>;
      getCacheSize: () => Promise<number>;
      clearCache: () => Promise<number>;
    };
  }
}
