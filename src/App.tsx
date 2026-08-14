import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Channel, ViewMode, StreamCheckResult } from './types';
import MainView from './MainView';
import SettingsView from './SettingsView';

function initTheme() {
  document.documentElement.setAttribute('data-theme', 'dark');
}

export default function App() {
  const [allChannels, setAllChannels] = useState<Channel[]>([]);
  const [favouriteUrls, setFavouriteUrls] = useState<Set<string>>(new Set());
  const [markedUrls, setMarkedUrls] = useState<Set<string>>(new Set());
  const [checkResults, setCheckResults] = useState<Map<string, StreamCheckResult>>(new Map());
  const [checking, setChecking] = useState(false);
  // Channels currently found/filtered in MainView — the fallback check target
  // when nothing is marked. Empty while settings are open (MainView unmounted).
  const [visibleUrls, setVisibleUrls] = useState<string[]>([]);
  const [historyUrls, setHistoryUrls] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('channels');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stripSuperscript, setStripSuperscript] = useState(false);
  const [drillCategory, setDrillCategory] = useState<string | null>(null);
  const [debugText, setDebugText] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Search active in the categories view before drilling in, restored on drill-out
  const savedCategorySearchRef = useRef('');

  const loadChannels = useCallback(async () => {
    try {
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
    } catch (e) {
      window.electronAPI.logFromRenderer('error', `loadChannels: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    initTheme();
    let cancelled = false;

    const initialize = async () => {
      // Show cached channels immediately; playlist refreshes can take a while.
      await loadChannels();

      try {
        const autoRefresh = await window.electronAPI.getSetting('refresh_playlists_on_startup');
        // Missing settings use the default-on behaviour.
        if (autoRefresh === '0' || cancelled) return;

        const playlists = await window.electronAPI.getPlaylists();
        for (const playlist of playlists) {
          if (cancelled) return;
          try {
            await window.electronAPI.refreshPlaylist(playlist.id);
          } catch (e) {
            await window.electronAPI.logFromRenderer(
              'error',
              `startup playlist refresh (${playlist.name}): ${String(e)}`,
            );
          }
        }

        if (!cancelled && playlists.length > 0) await loadChannels();
      } catch (e) {
        await window.electronAPI.logFromRenderer('error', `startup playlist refresh: ${String(e)}`);
      }
    };

    void initialize();
    return () => { cancelled = true; };
  }, [loadChannels]);

  useEffect(() => {
    return window.electronAPI.onStreamCheckResult(r => {
      setCheckResults(prev => new Map(prev).set(r.streamUrl, r));
    });
  }, []);

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
        savedCategorySearchRef.current = '';
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [settingsOpen]);

  // Entering a category clears the search (to browse its channels); leaving it
  // restores whatever was searched in the categories view.
  const handleDrillCategory = useCallback((cat: string | null) => {
    if (cat !== null && drillCategory === null) {
      savedCategorySearchRef.current = searchQuery;
      setSearchQuery('');
    } else if (cat === null && drillCategory !== null) {
      setSearchQuery(savedCategorySearchRef.current);
    }
    setDrillCategory(cat);
  }, [drillCategory, searchQuery]);

  // Go back one level: leave settings, else drill out of a category.
  const goBack = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
    } else if (drillCategory !== null) {
      handleDrillCategory(null);
    }
  }, [settingsOpen, drillCategory, handleDrillCategory]);

  // Mouse "back" button (button 3) acts like clicking the Back button
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      }
    };
    document.addEventListener('mouseup', handler);
    return () => document.removeEventListener('mouseup', handler);
  }, [goBack]);

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

  const handleToggleMarked = useCallback((streamUrl: string) => {
    setMarkedUrls(prev => {
      const next = new Set(prev);
      if (next.has(streamUrl)) {
        next.delete(streamUrl);
      } else {
        next.add(streamUrl);
      }
      return next;
    });
  }, []);

  const handleStartCheck = useCallback(async () => {
    // Marked channels take priority; with none marked, check everything
    // currently found in the view. Dedupe — playlists can share stream URLs.
    const live = new Set(allChannels.map(ch => ch.stream_url));
    const urls = markedUrls.size > 0
      ? [...markedUrls].filter(u => live.has(u))
      : [...new Set(visibleUrls)];
    if (urls.length === 0) return;
    setChecking(true);
    setCheckResults(new Map(urls.map(u => [u, { streamUrl: u, status: 'pending' as const }])));
    try {
      await window.electronAPI.runStreamCheck(urls);
    } catch (e) {
      window.electronAPI.logFromRenderer('error', `streamcheck: ${String(e)}`);
    } finally {
      setChecking(false);
      // Drop entries left pending/checking by a cancel mid-run
      setCheckResults(prev => new Map([...prev].filter(([, r]) => r.status !== 'pending' && r.status !== 'checking')));
    }
  }, [markedUrls, allChannels, visibleUrls]);

  const handleCancelCheck = useCallback(() => {
    window.electronAPI.cancelStreamCheck();
  }, []);

  const handleClearCheck = useCallback(() => {
    setMarkedUrls(new Set());
    setCheckResults(new Map());
  }, []);

  const bestUrls = useMemo(() => {
    let bestH = 0;
    let bestF = 0;
    for (const r of checkResults.values()) {
      if (r.status !== 'ok' || !r.height) continue;
      if (r.height > bestH || (r.height === bestH && (r.fps ?? 0) > bestF)) {
        bestH = r.height;
        bestF = r.fps ?? 0;
      }
    }
    const best = new Set<string>();
    if (bestH > 0) {
      for (const r of checkResults.values()) {
        if (r.status === 'ok' && r.height === bestH && (r.fps ?? 0) === bestF) best.add(r.streamUrl);
      }
    }
    return best;
  }, [checkResults]);

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
    savedCategorySearchRef.current = '';
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
          {checking && (
            <span id="check-progress">
              {[...checkResults.values()].filter(r => r.status !== 'pending' && r.status !== 'checking').length}
              /{checkResults.size}
            </span>
          )}
          <button
            id="check-start"
            title={
              checking
                ? 'Stop checking'
                : markedUrls.size > 0
                  ? `Check ${markedUrls.size} marked stream${markedUrls.size === 1 ? '' : 's'}`
                  : `Check ${new Set(visibleUrls).size} visible channels`
            }
            disabled={!checking && markedUrls.size === 0 && visibleUrls.length === 0}
            onClick={checking ? handleCancelCheck : handleStartCheck}
          >
            {checking ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
            )}
            {!checking && markedUrls.size > 0 && <span className="check-count">{markedUrls.size}</span>}
          </button>
          {(markedUrls.size > 0 || checkResults.size > 0) && (
            <button
              id="check-clear"
              title="Clear marks and results"
              disabled={checking}
              onClick={handleClearCheck}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
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
            setDrillCategory={handleDrillCategory}
            markedUrls={markedUrls}
            checkResults={checkResults}
            bestUrls={bestUrls}
            onToggleMarked={handleToggleMarked}
            onVisibleChannels={setVisibleUrls}
            onToggleFavourite={handleToggleFavourite}
            onPlayChannel={handlePlayChannel}
            onDebugText={setDebugText}
          />
        )}
      </main>

    </>
  );
}
