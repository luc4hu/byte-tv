import { useMemo, useEffect, useRef, useCallback } from 'react';
import type { Channel, Category, ViewMode } from './types';

const RENDER_LIMIT = 200;
const SUPERSCRIPT_RE = /[\u00AA\u00B2\u00B3\u00B9\u00BA\u02B0-\u02FF\u1D2C-\u1D6A\u1D78\u1D9B-\u1DBF\u2070-\u207F]/g;

function stripSuperscripts(s: string): string {
  return s.replace(SUPERSCRIPT_RE, '').replace(/\s{2,}/g, ' ').trim();
}

interface MainViewProps {
  allChannels: Channel[];
  favouriteUrls: Set<string>;
  historyUrls: string[];
  viewMode: ViewMode;
  searchQuery: string;
  stripSuperscript: boolean;
  drillCategory: string | null;
  setDrillCategory: (cat: string | null) => void;
  onToggleFavourite: (streamUrl: string) => void;
  onPlayChannel: (url: string, skipHistory?: boolean) => void;
  onDebugText: (text: string) => void;
}

export default function MainView({
  allChannels,
  favouriteUrls,
  historyUrls,
  viewMode,
  searchQuery,
  stripSuperscript,
  drillCategory,
  setDrillCategory,
  onToggleFavourite,
  onPlayChannel,
  onDebugText,
}: MainViewProps) {
  const gridRef = useRef<HTMLDivElement>(null);

  const { allCategories, channelNamesLower, categoryNamesLower } = useMemo(() => {
    const channelNamesLower = allChannels.map(ch => ch.name.toLowerCase());
    const catMap = new Map<string, number>();
    for (const ch of allChannels) {
      const group = ch.group_title || 'Uncategorized';
      catMap.set(group, (catMap.get(group) || 0) + 1);
    }
    const allCategories = Array.from(catMap, ([name, count]) => ({ name, count }));
    const categoryNamesLower = allCategories.map(c => c.name.toLowerCase());
    return { allCategories, channelNamesLower, categoryNamesLower };
  }, [allChannels]);

  const { items, totalCount, elapsed, renderMode } = useMemo(() => {
    const t0 = performance.now();
    const q = searchQuery.trim().toLowerCase();
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

    let channels: Channel[] | null = null;
    let categories: Category[] | null = null;

    if (drillCategory) {
      const catChannels = allChannels.filter(ch => (ch.group_title || 'Uncategorized') === drillCategory);
      if (tokens.length === 0) {
        channels = catChannels;
      } else {
        channels = catChannels.filter(ch => {
          const name = ch.name.toLowerCase();
          for (const tok of tokens) {
            if (!name.includes(tok)) return false;
          }
          return true;
        });
      }
    } else if (viewMode === 'history') {
      const historyChannels: Channel[] = [];
      const channelByUrl = new Map(allChannels.map(ch => [ch.stream_url, ch]));
      for (const url of historyUrls) {
        const ch = channelByUrl.get(url);
        if (ch) historyChannels.push(ch);
      }
      if (tokens.length === 0) {
        channels = historyChannels;
      } else {
        channels = historyChannels.filter(ch => {
          const name = ch.name.toLowerCase();
          for (const tok of tokens) {
            if (!name.includes(tok)) return false;
          }
          return true;
        });
      }
    } else if (viewMode === 'favourites') {
      const seen = new Set<string>();
      const favChannels = allChannels.filter(ch => {
        if (!favouriteUrls.has(ch.stream_url) || seen.has(ch.stream_url)) return false;
        seen.add(ch.stream_url);
        return true;
      });
      if (tokens.length === 0) {
        channels = favChannels;
      } else {
        channels = favChannels.filter(ch => {
          const name = ch.name.toLowerCase();
          for (const tok of tokens) {
            if (!name.includes(tok)) return false;
          }
          return true;
        });
      }
    } else if (viewMode === 'channels') {
      if (tokens.length === 0) {
        channels = allChannels;
      } else if (tokens.length === 1) {
        const tok = tokens[0];
        channels = allChannels.filter((_, i) => channelNamesLower[i].includes(tok));
      } else {
        channels = allChannels.filter((_, i) => {
          const name = channelNamesLower[i];
          for (const tok of tokens) {
            if (!name.includes(tok)) return false;
          }
          return true;
        });
      }
    } else {
      // categories view
      if (tokens.length === 0) {
        categories = allCategories;
      } else if (tokens.length === 1) {
        const tok = tokens[0];
        categories = allCategories.filter((_, i) => categoryNamesLower[i].includes(tok));
      } else {
        categories = allCategories.filter((_, i) => {
          const name = categoryNamesLower[i];
          for (const tok of tokens) {
            if (!name.includes(tok)) return false;
          }
          return true;
        });
      }
    }

    const elapsed = performance.now() - t0;
    if (categories) {
      const totalCount = categories.length;
      return { items: categories.slice(0, RENDER_LIMIT), totalCount, elapsed, renderMode: 'categories' as const };
    }
    const totalCount = channels!.length;
    return { items: channels!.slice(0, RENDER_LIMIT), totalCount, elapsed, renderMode: 'channels' as const };
  }, [allChannels, allCategories, channelNamesLower, categoryNamesLower, favouriteUrls, historyUrls, viewMode, drillCategory, searchQuery]);

  useEffect(() => {
    onDebugText(`${totalCount} results in ${elapsed.toFixed(1)}ms`);
  }, [totalCount, elapsed, onDebugText]);

  const handleGridClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    const catCard = target.closest('.category-card') as HTMLElement | null;
    if (catCard?.dataset.category) {
      setDrillCategory(catCard.dataset.category);
      return;
    }

    const card = target.closest('.channel-card') as HTMLElement | null;
    if (card?.dataset.url) {
      gridRef.current?.querySelector('.channel-card.loading')?.classList.remove('loading');
      card.classList.add('loading');
      onPlayChannel(card.dataset.url, viewMode === 'history');
    }
  }, [setDrillCategory, onPlayChannel, viewMode]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const card = (e.target as HTMLElement).closest('.channel-card') as HTMLElement | null;
    if (!card?.dataset.url) return;
    onToggleFavourite(card.dataset.url);
  }, [onToggleFavourite]);

  const displayName = (ch: Channel) =>
    stripSuperscript && viewMode === 'favourites' ? stripSuperscripts(ch.name) : ch.name;

  if (items.length === 0) {
    return (
      <div id="empty-state">
        <p>No channels loaded. Open Settings to add a playlist.</p>
      </div>
    );
  }

  return (
    <>
      {drillCategory && (
        <div className="drill-header">
          <button className="back-btn" onClick={() => setDrillCategory(null)}>&larr; Back</button>
          <span className="drill-title">{drillCategory}</span>
        </div>
      )}
      <div
        id="channel-grid"
        ref={gridRef}
        onClick={handleGridClick}
        onContextMenu={handleContextMenu}
      >
        {renderMode === 'categories'
          ? (items as Category[]).map(cat => (
              <div key={cat.name} className="category-card" data-category={cat.name}>
                <span className="category-name">{cat.name}</span>
                <span className="category-count">{cat.count} ch.</span>
              </div>
            ))
          : (items as Channel[]).map((ch, i) => {
              const name = displayName(ch);
              return (
                <div key={`${ch.id}-${i}`} className="channel-card" data-url={ch.stream_url} title={name}>
                  {favouriteUrls.has(ch.stream_url) && <span className="favourite-star">&#9733;</span>}
                  <div className="channel-logo">
                    <img
                      src={ch.logo}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width={100}
                      height={50}
                      onError={e => { (e.target as HTMLImageElement).dataset.error = ''; }}
                    />
                    <span className="logo-fallback">{name.charAt(0)}</span>
                  </div>
                  <div className="channel-name">{name}</div>
                  {ch.playlist_name && <div className="channel-playlist">{ch.playlist_name}</div>}
                </div>
              );
            })
        }
      </div>
    </>
  );
}
