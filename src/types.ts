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
  exp_date?: string | null;
  last_refreshed?: string | null;
}

export interface XtreamUserInfo {
  username: string;
  status: string;
  expDate: string;
  isTrial: boolean;
  activeCons: number;
  createdAt: string;
  maxConnections: number;
}

export interface XtreamPlaylistDetails {
  id: number;
  name: string;
  serverUrl: string;
  username: string;
  password: string;
}

export type ViewMode = 'channels' | 'categories' | 'history' | 'favourites';

export type SearchMode = 'plain' | 'regex';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;        // ISO with second resolution, e.g. "2026-06-06T14:23:45Z"
  level: LogLevel;
  message: string;   // single-line, newlines collapsed to '\n'
}

export interface RefreshProgress {
  playlistId: number;
  phase: 'downloading' | 'parsing' | 'inserting';
  percent?: number; // 0-100, only during downloading phase when Content-Length is known
}

export type StreamCheckStatus = 'pending' | 'checking' | 'ok' | 'offline' | 'blank';

export interface StreamCheckResult {
  streamUrl: string;
  status: StreamCheckStatus;
  width?: number;   // set when status === 'ok'
  height?: number;
  fps?: number;     // may be undefined even when ok (streams reporting 0/0 frame rates)
  hdr?: boolean;    // true only when the stream signals a PQ/HLG transfer; absent means SDR *or* untagged
  error?: string;   // short reason for offline
}

declare global {
  interface Window {
    electronAPI: {
      getAppVersion: () => Promise<string>;
      addPlaylistFromURL: (name: string, url: string) => Promise<{ playlistId: number; count: number }>;
      addXtreamPlaylist: (name: string, serverUrl: string, username: string, password: string) => Promise<{ playlistId: number; count: number }>;
      getXtreamPlaylistDetails: (id: number) => Promise<XtreamPlaylistDetails>;
      updateXtreamPlaylist: (id: number, name: string, serverUrl: string, username: string, password: string) => Promise<{ count: number }>;
      getPlaylists: () => Promise<Playlist[]>;
      deletePlaylist: (id: number) => Promise<void>;
      refreshPlaylist: (id: number) => Promise<{ count: number }>;
      onRefreshProgress: (callback: (progress: RefreshProgress) => void) => () => void;
      getChannels: () => Promise<Channel[]>;
      playChannel: (url: string, skipHistory?: boolean) => Promise<void>;
      getHistory: () => Promise<string[]>;
      getFavourites: () => Promise<string[]>;
      toggleFavourite: (streamUrl: string) => Promise<{ isFavourite: boolean }>;
      getFavouriteCategories: () => Promise<string[]>;
      toggleFavouriteCategory: (categoryName: string) => Promise<{ isFavourite: boolean }>;
      showFavouriteMenu: (opts: { isFavourite: boolean; isCategory?: boolean }) => Promise<boolean>;
      runStreamCheck: (urls: string[]) => Promise<void>;
      cancelStreamCheck: () => Promise<void>;
      onStreamCheckResult: (callback: (result: StreamCheckResult) => void) => () => void;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<void>;
      getLogs: () => Promise<LogEntry[]>;
      clearLogs: () => Promise<void>;
      logFromRenderer: (level: LogLevel, message: string) => Promise<void>;
      openLogsWindow: () => Promise<void>;
    };
  }
}
