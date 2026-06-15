import { useState, useEffect, useCallback } from 'react';
import type { Playlist, RefreshProgress } from './types';

interface SettingsViewProps {
  onReloadChannels: () => Promise<void>;
  stripSuperscript: boolean;
  setStripSuperscript: (value: boolean) => void;
}

function formatLastRefreshed(value: string | null | undefined): string | null {
  if (!value) return null;
  // SQLite datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS"
  const date = new Date(value.replace(' ', 'T') + 'Z');
  if (isNaN(date.getTime())) return null;
  // ISO-style, but in the user's local timezone
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatExpiry(expDate: string | null | undefined): string | null {
  if (!expDate) return null;
  const exp = parseInt(expDate, 10);
  if (!exp || exp === 0) return null;
  const date = new Date(exp * 1000);
  return date.toISOString().split('T')[0];
}

function logToMain(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  window.electronAPI.logFromRenderer(level, args.map(String).join(' '));
}

export default function SettingsView({
  onReloadChannels,
  stripSuperscript,
  setStripSuperscript,
}: SettingsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [videoPlayer, setVideoPlayer] = useState<'mpv' | 'vlc'>('mpv');
  const [mpvFlags, setMpvFlags] = useState('');
  const [vlcFlags, setVlcFlags] = useState('');
  const [appVersion, setAppVersion] = useState('');
  
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [progressById, setProgressById] = useState<Map<number, RefreshProgress>>(new Map());
  const [showXtreamInput, setShowXtreamInput] = useState(false);
  const [xtreamServer, setXtreamServer] = useState('');
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamLoading, setXtreamLoading] = useState(false);
  const [xtreamError, setXtreamError] = useState('');
  const [editingXtreamId, setEditingXtreamId] = useState<number | null>(null);
  const [editXtreamName, setEditXtreamName] = useState('');
  const [editXtreamServer, setEditXtreamServer] = useState('');
  const [editXtreamUsername, setEditXtreamUsername] = useState('');
  const [editXtreamPassword, setEditXtreamPassword] = useState('');
  const [editXtreamLoading, setEditXtreamLoading] = useState(false);
  const [editXtreamError, setEditXtreamError] = useState('');

  const loadSettings = useCallback(async () => {
    const [pl, player, flags, vlc, version] = await Promise.all([
      window.electronAPI.getPlaylists(),
      window.electronAPI.getSetting('video_player'),
      window.electronAPI.getSetting('mpv_flags'),
      window.electronAPI.getSetting('vlc_flags'),
      window.electronAPI.getAppVersion(),
    ]);
    setPlaylists(pl);
    setVideoPlayer(player === 'vlc' ? 'vlc' : 'mpv');
    setMpvFlags(flags || '');
    setVlcFlags(vlc || '');
    setAppVersion(version);
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // One subscription for all refreshes, keyed by playlist
  useEffect(() => {
    return window.electronAPI.onRefreshProgress((progress) => {
      setProgressById(prev => new Map(prev).set(progress.playlistId, progress));
    });
  }, []);


  const handleAddUrl = async () => {
    const url = urlValue.trim();
    const name = playlistName.trim();
    if (!url || !name) return;
    setUrlLoading(true);
    try {
      await window.electronAPI.addPlaylistFromURL(name, url);
      setShowUrlInput(false);
      setUrlValue('');
      setPlaylistName('');
      await onReloadChannels();
      loadSettings();
    } catch (e) {
      logToMain('error', 'handleAddUrl:', String(e));
    }
    setUrlLoading(false);
  };

  const handleAddXtream = async () => {
    const server = xtreamServer.trim();
    const user = xtreamUsername.trim();
    const pass = xtreamPassword.trim();
    const name = playlistName.trim();
    if (!server || !user || !pass || !name) return;

    setXtreamLoading(true);
    setXtreamError('');
    try {
      await window.electronAPI.addXtreamPlaylist(name, server, user, pass);
      setShowXtreamInput(false);
      setXtreamServer('');
      setXtreamUsername('');
      setXtreamPassword('');
      setPlaylistName('');
      await onReloadChannels();
      loadSettings();
    } catch (err: unknown) {
      logToMain('error', 'handleAddXtream:', err instanceof Error ? err.message : String(err));
      setXtreamError(err instanceof Error ? err.message : 'Failed to connect');
    }
    setXtreamLoading(false);
  };

  const closeEditXtream = () => {
    setEditingXtreamId(null);
    setEditXtreamName('');
    setEditXtreamServer('');
    setEditXtreamUsername('');
    setEditXtreamPassword('');
    setEditXtreamError('');
  };

  const handleEditXtream = async (id: number) => {
    setShowUrlInput(false);
    setShowXtreamInput(false);
    setXtreamError('');
    setEditingXtreamId(id);
    setEditXtreamLoading(true);
    setEditXtreamError('');
    try {
      const details = await window.electronAPI.getXtreamPlaylistDetails(id);
      setEditXtreamName(details.name);
      setEditXtreamServer(details.serverUrl);
      setEditXtreamUsername(details.username);
      setEditXtreamPassword(details.password);
    } catch (err: unknown) {
      logToMain('error', 'handleEditXtream:', err instanceof Error ? err.message : String(err));
      setEditXtreamError(err instanceof Error ? err.message : 'Failed to load playlist');
    }
    setEditXtreamLoading(false);
  };

  const handleSaveXtream = async () => {
    if (editingXtreamId == null) return;

    const name = editXtreamName.trim();
    const server = editXtreamServer.trim();
    const user = editXtreamUsername.trim();
    const pass = editXtreamPassword.trim();
    if (!name || !server || !user || !pass) return;

    setEditXtreamLoading(true);
    setEditXtreamError('');
    try {
      await window.electronAPI.updateXtreamPlaylist(editingXtreamId, name, server, user, pass);
      closeEditXtream();
      await onReloadChannels();
      loadSettings();
    } catch (err: unknown) {
      logToMain('error', 'handleSaveXtream:', err instanceof Error ? err.message : String(err));
      setEditXtreamError(err instanceof Error ? err.message : 'Failed to save playlist');
    }
    setEditXtreamLoading(false);
  };

  const handleRefresh = async (id: number) => {
    setRefreshingIds(prev => new Set(prev).add(id));
    try {
      await window.electronAPI.refreshPlaylist(id);
      await onReloadChannels();
    } catch (e) {
      logToMain('error', 'handleRefresh:', String(e));
    } finally {
      setRefreshingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setProgressById(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      loadSettings();
    }
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI.deletePlaylist(id);
    await onReloadChannels();
    loadSettings();
  };

  const handleVideoPlayerChange = (value: 'mpv' | 'vlc') => {
    setVideoPlayer(value);
    window.electronAPI.setSetting('video_player', value);
  };

  const handleStripSuperscriptChange = (value: boolean) => {
    setStripSuperscript(value);
    window.electronAPI.setSetting('strip_superscript', value ? '1' : '0');
  };

  return (
    <div id="settings-page" style={{ display: 'block' }}>
      <div className="settings-section">
        <h2>Playlists</h2>
        <div id="playlist-list">
          {playlists.length === 0 && (
            <p className="settings-empty">No playlists added yet.</p>
          )}
          {playlists.map(p => {
            const isRefreshing = refreshingIds.has(p.id);
            const refreshProgress = isRefreshing ? progressById.get(p.id) : undefined;
            const lastRefreshed = formatLastRefreshed(p.last_refreshed);
            const expiry = p.type === 'xtream' ? formatExpiry(p.exp_date) : null;
            return (
              <div key={p.id} className="playlist-item" data-id={p.id}>
                <div className="playlist-item-info">
                  <span className="playlist-item-name">{p.name}</span>
                  <div className="playlist-item-meta">
                    <span>{p.channel_count} channels</span>
                    {p.type === 'xtream'
                      ? <span>Xtream{expiry ? ` \u00B7 expires ${expiry}` : ''}</span>
                      : p.path ? <span>{p.path}</span> : null}
                    {lastRefreshed && <span>Refreshed {lastRefreshed}</span>}
                  </div>
                  {refreshProgress && (
                    <div className="refresh-progress">
                      <span className="refresh-spinner" />
                      <span className="refresh-progress-label">
                        {refreshProgress.phase === 'downloading' && 'Downloading...'}
                        {refreshProgress.phase === 'parsing' && 'Parsing...'}
                        {refreshProgress.phase === 'inserting' && 'Inserting...'}
                      </span>
                    </div>
                  )}
                </div>
                <div className="playlist-item-actions">
                  <button
                    className="refresh-btn"
                    disabled={isRefreshing}
                    onClick={() => handleRefresh(p.id)}
                  >
                    {isRefreshing ? '...' : 'Refresh'}
                  </button>
                  {p.type === 'xtream' && (
                    <button
                      className="edit-btn"
                      disabled={isRefreshing || editXtreamLoading}
                      onClick={() => handleEditXtream(p.id)}
                    >
                      Edit
                    </button>
                  )}
                  <button className="delete-btn" onClick={() => handleDelete(p.id)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="playlist-add-actions">
          <button id="add-url-btn" onClick={() => { setShowUrlInput(true); setShowXtreamInput(false); closeEditXtream(); setUrlValue(''); setPlaylistName(''); }}>Add URL</button>
          <button id="add-xtream-btn" onClick={() => { setShowXtreamInput(true); setShowUrlInput(false); closeEditXtream(); setXtreamError(''); setPlaylistName(''); }}>Add Xtream</button>
        </div>
        {showUrlInput && (
          <div className="url-input-row">
            <input
              id="playlist-name-input"
              type="text"
              placeholder="Playlist name"
              value={playlistName}
              onChange={e => setPlaylistName(e.target.value)}
              autoFocus
            />
            <input
              id="url-input"
              type="url"
              placeholder="https://example.com/playlist.m3u"
              value={urlValue}
              onChange={e => setUrlValue(e.target.value)}
            />
            <button
              id="url-confirm-btn"
              disabled={urlLoading}
              onClick={handleAddUrl}
            >
              {urlLoading ? '...' : 'Add'}
            </button>
            <button id="url-cancel-btn" onClick={() => setShowUrlInput(false)}>Cancel</button>
          </div>
        )}
        {showXtreamInput && (
          <div className="xtream-input-form">
            <input
              type="text"
              placeholder="Playlist name"
              value={playlistName}
              onChange={e => setPlaylistName(e.target.value)}
              autoFocus
            />
            <input
              type="url"
              placeholder="http://server:port"
              value={xtreamServer}
              onChange={e => setXtreamServer(e.target.value)}
            />
            <input
              type="text"
              placeholder="Username"
              value={xtreamUsername}
              onChange={e => setXtreamUsername(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              value={xtreamPassword}
              onChange={e => setXtreamPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddXtream(); }}
            />
            {xtreamError && <span className="xtream-error">{xtreamError}</span>}
            <div className="xtream-input-actions">
              <button
                className="xtream-confirm-btn"
                disabled={xtreamLoading}
                onClick={handleAddXtream}
              >
                {xtreamLoading ? 'Connecting...' : 'Connect'}
              </button>
              <button onClick={() => setShowXtreamInput(false)}>Cancel</button>
            </div>
          </div>
        )}
        {editingXtreamId != null && (
          <div className="xtream-input-form">
            <input
              type="text"
              placeholder="Playlist name"
              value={editXtreamName}
              onChange={e => setEditXtreamName(e.target.value)}
              autoFocus
            />
            <input
              type="url"
              placeholder="http://server:port"
              value={editXtreamServer}
              onChange={e => setEditXtreamServer(e.target.value)}
            />
            <input
              type="text"
              placeholder="Username"
              value={editXtreamUsername}
              onChange={e => setEditXtreamUsername(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              value={editXtreamPassword}
              onChange={e => setEditXtreamPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveXtream(); }}
            />
            {editXtreamError && <span className="xtream-error">{editXtreamError}</span>}
            <div className="xtream-input-actions">
              <button
                className="xtream-confirm-btn"
                disabled={editXtreamLoading}
                onClick={handleSaveXtream}
              >
                {editXtreamLoading ? 'Saving...' : 'Save'}
              </button>
              <button disabled={editXtreamLoading} onClick={closeEditXtream}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h2>Player</h2>
        <div className="theme-setting">
          <span>Open streams with</span>
          <div className="view-toggle">
            <button
              className={`toggle-btn${videoPlayer === 'mpv' ? ' active' : ''}`}
              onClick={() => handleVideoPlayerChange('mpv')}
            >
              mpv
            </button>
            <button
              className={`toggle-btn${videoPlayer === 'vlc' ? ' active' : ''}`}
              onClick={() => handleVideoPlayerChange('vlc')}
            >
              VLC
            </button>
          </div>
        </div>
        <p className="settings-hint">Custom flags passed to mpv on playback (space-separated).</p>
        <textarea
          id="mpv-flags-input"
          placeholder="e.g. --vo=gpu --hwdec=auto"
          value={mpvFlags}
          onChange={e => setMpvFlags(e.target.value)}
          onBlur={() => window.electronAPI.setSetting('mpv_flags', mpvFlags)}
        />
        <p className="settings-hint">Custom flags passed to VLC on playback (space-separated).</p>
        <textarea
          id="vlc-flags-input"
          placeholder="e.g. --fullscreen --no-video-title-show"
          value={vlcFlags}
          onChange={e => setVlcFlags(e.target.value)}
          onBlur={() => window.electronAPI.setSetting('vlc_flags', vlcFlags)}
        />
      </div>

      <div className="settings-section">
        <h2>Appearance</h2>
        <div className="theme-setting">
          <span>Strip superscript (favourites)</span>
          <div className="view-toggle">
            <button
              className={`toggle-btn${stripSuperscript ? ' active' : ''}`}
              onClick={() => handleStripSuperscriptChange(true)}
            >
              On
            </button>
            <button
              className={`toggle-btn${!stripSuperscript ? ' active' : ''}`}
              onClick={() => handleStripSuperscriptChange(false)}
            >
              Off
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>Diagnostics</h2>
        <div className="settings-row">
          <button onClick={() => window.electronAPI.openLogsWindow()}>View Logs</button>
        </div>
      </div>

      {appVersion && <div className="settings-version">byte-tv v{appVersion}</div>}
    </div>
  );
}
