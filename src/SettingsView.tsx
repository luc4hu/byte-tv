import { useState, useEffect, useCallback } from 'react';
import type { Playlist } from './types';

interface SettingsViewProps {
  onReloadChannels: () => Promise<void>;
  stripSuperscript: boolean;
  setStripSuperscript: (value: boolean) => void;
  autoRefreshingIds: Set<number>;
}

export default function SettingsView({
  onReloadChannels,
  stripSuperscript,
  setStripSuperscript,
  autoRefreshingIds,
}: SettingsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [mpvFlags, setMpvFlags] = useState('');
  const [cacheSize, setCacheSize] = useState(0);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [showXtreamInput, setShowXtreamInput] = useState(false);
  const [xtreamServer, setXtreamServer] = useState('');
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamLoading, setXtreamLoading] = useState(false);
  const [xtreamError, setXtreamError] = useState('');
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(
    () => (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light'
  );
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadSettings = useCallback(async () => {
    const [pl, flags, cache, arSetting] = await Promise.all([
      window.electronAPI.getPlaylists(),
      window.electronAPI.getSetting('mpv_flags'),
      window.electronAPI.getCacheSize(),
      window.electronAPI.getSetting('auto_refresh'),
    ]);
    setPlaylists(pl);
    setMpvFlags(flags || '');
    setCacheSize(cache);
    setAutoRefresh(arSetting === '1');
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleAddPlaylist = async () => {
    const result = await window.electronAPI.addPlaylist();
    if (!result.canceled) {
      await onReloadChannels();
      loadSettings();
    }
  };

  const handleAddUrl = async () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlLoading(true);
    try {
      const result = await window.electronAPI.addPlaylistFromURL(url);
      if (!result.canceled) {
        setShowUrlInput(false);
        setUrlValue('');
        await onReloadChannels();
        loadSettings();
      }
    } catch {
      // error state handled by button text
    }
    setUrlLoading(false);
  };

  const handleAddXtream = async () => {
    const server = xtreamServer.trim();
    const user = xtreamUsername.trim();
    const pass = xtreamPassword.trim();
    if (!server || !user || !pass) return;

    setXtreamLoading(true);
    setXtreamError('');
    try {
      const result = await window.electronAPI.addXtreamPlaylist(server, user, pass);
      if (!result.canceled) {
        setShowXtreamInput(false);
        setXtreamServer('');
        setXtreamUsername('');
        setXtreamPassword('');
        await onReloadChannels();
        loadSettings();
      }
    } catch (err: unknown) {
      setXtreamError(err instanceof Error ? err.message : 'Failed to connect');
    }
    setXtreamLoading(false);
  };

  const handleRefresh = async (id: number) => {
    setRefreshingId(id);
    try {
      await window.electronAPI.refreshPlaylist(id);
      await onReloadChannels();
    } catch {
      // handled
    }
    setRefreshingId(null);
    loadSettings();
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI.deletePlaylist(id);
    await onReloadChannels();
    loadSettings();
  };

  const handleThemeChange = (theme: 'light' | 'dark') => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    setCurrentTheme(theme);
  };

  const handleAutoRefreshChange = (value: boolean) => {
    setAutoRefresh(value);
    window.electronAPI.setSetting('auto_refresh', value ? '1' : '0');
  };

  const handleStripSuperscriptChange = (value: boolean) => {
    setStripSuperscript(value);
    window.electronAPI.setSetting('strip_superscript', value ? '1' : '0');
  };

  const handleClearCache = async () => {
    const newSize = await window.electronAPI.clearCache();
    setCacheSize(newSize);
  };

  const cacheMB = (cacheSize / 1024 / 1024).toFixed(2);

  return (
    <div id="settings-page" style={{ display: 'block' }}>
      <div className="settings-section">
        <h2>Playlists</h2>
        <div id="playlist-list">
          {playlists.length === 0 && (
            <p className="settings-empty">No playlists added yet.</p>
          )}
          {playlists.map(p => {
            const isRefreshing = refreshingId === p.id || autoRefreshingIds.has(p.id);
            return (
              <div key={p.id} className="playlist-item" data-id={p.id}>
                <div className="playlist-item-info">
                  <span className="playlist-item-name">{p.name}</span>
                  <span className="playlist-item-meta">
                    {p.channel_count} channels{p.type === 'xtream' ? ' \u00B7 Xtream' : p.path ? ` \u00B7 ${p.path}` : ''}
                  </span>
                </div>
                <div className="playlist-item-actions">
                  <button
                    className="refresh-btn"
                    disabled={isRefreshing}
                    onClick={() => handleRefresh(p.id)}
                  >
                    {isRefreshing ? '...' : 'Refresh'}
                  </button>
                  <button className="delete-btn" onClick={() => handleDelete(p.id)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="playlist-add-actions">
          <button id="add-playlist-btn" onClick={handleAddPlaylist}>Add Playlist</button>
          <button id="add-url-btn" onClick={() => { setShowUrlInput(true); setShowXtreamInput(false); setUrlValue(''); }}>Add URL</button>
          <button id="add-xtream-btn" onClick={() => { setShowXtreamInput(true); setShowUrlInput(false); setXtreamError(''); }}>Add Xtream</button>
        </div>
        {showUrlInput && (
          <div className="url-input-row">
            <input
              id="url-input"
              type="url"
              placeholder="https://example.com/playlist.m3u"
              value={urlValue}
              onChange={e => setUrlValue(e.target.value)}
              autoFocus
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
              type="url"
              placeholder="http://server:port"
              value={xtreamServer}
              onChange={e => setXtreamServer(e.target.value)}
              autoFocus
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
      </div>

      <div className="settings-section">
        <h2>mpv Flags</h2>
        <p className="settings-hint">Custom flags passed to mpv on playback (space-separated).</p>
        <textarea
          id="mpv-flags-input"
          placeholder="e.g. --vo=gpu --hwdec=auto"
          value={mpvFlags}
          onChange={e => setMpvFlags(e.target.value)}
          onBlur={() => window.electronAPI.setSetting('mpv_flags', mpvFlags)}
        />
      </div>

      <div className="settings-section">
        <h2>Appearance</h2>
        <div className="theme-setting">
          <span>Theme</span>
          <div className="view-toggle">
            <button
              className={`toggle-btn${currentTheme === 'light' ? ' active' : ''}`}
              onClick={() => handleThemeChange('light')}
            >
              Light
            </button>
            <button
              className={`toggle-btn${currentTheme === 'dark' ? ' active' : ''}`}
              onClick={() => handleThemeChange('dark')}
            >
              Dark
            </button>
          </div>
        </div>
        <div className="theme-setting">
          <span>Auto refresh on startup</span>
          <div className="view-toggle">
            <button
              className={`toggle-btn${autoRefresh ? ' active' : ''}`}
              onClick={() => handleAutoRefreshChange(true)}
            >
              On
            </button>
            <button
              className={`toggle-btn${!autoRefresh ? ' active' : ''}`}
              onClick={() => handleAutoRefreshChange(false)}
            >
              Off
            </button>
          </div>
        </div>
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
        <h2>Cache</h2>
        <div className="cache-setting">
          <span>Browser cache: {cacheMB} MB</span>
          <button id="settings-clear-cache" onClick={handleClearCache}>Clear</button>
        </div>
      </div>
    </div>
  );
}
