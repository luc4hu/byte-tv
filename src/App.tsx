import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, ViewMode } from './types';
import MainView from './MainView';
import SettingsView from './SettingsView';

function initTheme() {
  const saved = localStorage.getItem('theme') as 'light' | 'dark' | null;
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
}

export default function App() {
  const [allChannels, setAllChannels] = useState<Channel[]>([]);
  const [favouriteUrls, setFavouriteUrls] = useState<Set<string>>(new Set());
  const [historyUrls, setHistoryUrls] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('channels');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stripSuperscript, setStripSuperscript] = useState(false);
  const [drillCategory, setDrillCategory] = useState<string | null>(null);
  const [debugText, setDebugText] = useState('');
  const [autoRefreshingIds, setAutoRefreshingIds] = useState<Set<number>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadChannels = useCallback(async () => {
    const t0 = performance.now();
    const [channels, favUrls, histUrls, stripSetting] = await Promise.all([
      window.electronAPI.getChannels(),
      window.electronAPI.getFavourites(),
      window.electronAPI.getHistory(),
      window.electronAPI.getSetting('strip_superscript'),
    ]);
    console.log(`[renderer] getChannels + getFavourites + getHistory: ${performance.now() - t0}ms`);

    setAllChannels(channels);
    setFavouriteUrls(new Set(favUrls));
    setHistoryUrls(histUrls);
    setStripSuperscript(stripSetting === '1');
    setDebugText(`${channels.length} channels loaded`);
    console.log(`[renderer] total loadChannels: ${performance.now() - t0}ms`);
  }, []);

  useEffect(() => {
    initTheme();
    const init = async () => {
      await loadChannels();

      const autoRefreshSetting = await window.electronAPI.getSetting('auto_refresh');
      if (autoRefreshSetting !== '1') return;

      const playlists = await window.electronAPI.getPlaylists();
      const promises = playlists.map(async (p) => {
        setAutoRefreshingIds(prev => new Set([...prev, p.id]));
        try {
          await window.electronAPI.refreshPlaylist(p.id);
        } finally {
          setAutoRefreshingIds(prev => {
            const next = new Set(prev);
            next.delete(p.id);
            return next;
          });
        }
      });
      await Promise.all(promises);
      if (playlists.length > 0) await loadChannels();
    };
    init();
  }, [loadChannels]);

  // "/" to focus search, Tab to cycle views
  useEffect(() => {
    const views: ViewMode[] = ['channels', 'categories', 'history', 'favourites'];
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const inInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (e.key === '/' && active !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Tab' && !inInput && !settingsOpen) {
        e.preventDefault();
        setViewMode(prev => {
          const idx = views.indexOf(prev);
          return views[(idx + 1) % views.length];
        });
        setDrillCategory(null);
        setSearchQuery('');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [settingsOpen]);

  useEffect(() => {
    if (drillCategory) {
      setSearchQuery('');
    }
  }, [drillCategory]);

  useEffect(() => {
    if (drillCategory) {
      setSearchQuery('');
    }
  }, [drillCategory]);

  const handleToggleFavourite = useCallback(async (streamUrl: string) => {
    const { isFavourite } = await window.electronAPI.toggleFavourite(streamUrl);
    setFavouriteUrls(prev => {
      const next = new Set(prev);
      if (isFavourite) {
        next.add(streamUrl);
      } else {
        next.delete(streamUrl);
      }
      return next;
    });
  }, []);

  const handlePlayChannel = useCallback((streamUrl: string, skipHistory = false) => {
    window.electronAPI.playChannel(streamUrl, skipHistory);
    if (!skipHistory) {
      setHistoryUrls(prev => {
        const next = prev.filter(u => u !== streamUrl);
        next.unshift(streamUrl);
        return next;
      });
    }
  }, []);

  const handleViewChange = (mode: ViewMode) => {
    if (settingsOpen) setSettingsOpen(false);
    if (mode === viewMode && !drillCategory) return;
    setViewMode(mode);
    setDrillCategory(null);
    setSearchQuery('');
  };

  const handleSettingsToggle = () => {
    setSettingsOpen(prev => !prev);
  };

  const searchPlaceholder = drillCategory
    ? 'Search in category...'
    : viewMode === 'channels'
      ? 'Search channels...'
      : viewMode === 'categories'
        ? 'Search categories...'
        : viewMode === 'history'
          ? 'Search history...'
          : 'Search favourites...';

  return (
    <>
      <header className="toolbar">
        <div className="nav-left">
          <div className="view-toggle">
            {(['channels', 'categories', 'history', 'favourites'] as const).map(mode => (
              <button
                key={mode}
                className={`toggle-btn${viewMode === mode && !settingsOpen ? ' active' : ''}`}
                onClick={() => handleViewChange(mode)}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="search-bar">
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            id="search-input"
            ref={searchInputRef}
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="nav-right">
          <span id="debug-timer">{debugText}</span>
          <button
            id="settings-toggle"
            title="Settings"
            className={settingsOpen ? 'active' : ''}
            onClick={handleSettingsToggle}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>
      <main>
        {settingsOpen ? (
          <SettingsView
            onReloadChannels={loadChannels}
            stripSuperscript={stripSuperscript}
            setStripSuperscript={setStripSuperscript}
            autoRefreshingIds={autoRefreshingIds}
          />
        ) : (
          <MainView
            allChannels={allChannels}
            favouriteUrls={favouriteUrls}
            historyUrls={historyUrls}
            viewMode={viewMode}
            searchQuery={searchQuery}
            stripSuperscript={stripSuperscript}
            drillCategory={drillCategory}
            setDrillCategory={setDrillCategory}
            onToggleFavourite={handleToggleFavourite}
            onPlayChannel={handlePlayChannel}
            onDebugText={setDebugText}
          />
        )}
      </main>
    </>
  );
}
