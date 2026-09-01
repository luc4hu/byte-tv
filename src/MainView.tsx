import { useMemo, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import type { Channel, Category, ViewMode, SearchMode, StreamCheckResult } from './types';

const RENDER_BATCH_SIZE = 200;
const SUPERSCRIPT_RE = /[\u00AA\u00B2\u00B3\u00B9\u00BA\u02B0-\u02FF\u1D2C-\u1D6A\u1D78\u1D9B-\u1DBF\u2070-\u207F]/g;

function stripSuperscripts(s: string): string {
  return s.replace(SUPERSCRIPT_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// These IPA small-cap letters do not have Unicode compatibility decompositions,
// so NFKD alone leaves e.g. "ᴜʜᴅ" unchanged. Fold the Latin forms commonly used
// in channel names before applying the normal compatibility normalization.
const SMALL_CAP_LATIN_FOLDS: Record<string, string> = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f',
  'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l',
  'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ꜱ': 's',
  'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

// Search-only normalization makes stylized Latin and superscript/modifier-letter
// forms match plain-text tokens. Display still uses ch.name.
// NFKD splits accented letters into base + combining mark, so the marks are
// stripped afterwards: "BARÇA" becomes "barca" rather than "barc\u0327a".
function searchNormalize(s: string): string {
  return s.replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, char => SMALL_CAP_LATIN_FOLDS[char])
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase();
}

// Builds the predicate used to filter names in every view. A null matcher means
// "no filter" (empty query, or a query that failed to compile).
function buildMatcher(query: string, mode: SearchMode): {
  matcher: ((name: string) => boolean) | null;
  regexError: string | null;
} {
  if (!query) return { matcher: null, regexError: null };
  if (mode === 'regex') {
    try {
      // The pattern is used verbatim — searchNormalize would lowercase it and
      // silently flip \D/\W/\S. The `i` flag covers case instead, and the names
      // it is tested against are already normalized.
      const re = new RegExp(query, 'i');
      return { matcher: name => re.test(name), regexError: null };
    } catch (e) {
      return { matcher: null, regexError: e instanceof Error ? e.message : String(e) };
    }
  }
  const tokens = searchNormalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { matcher: null, regexError: null };
  return { matcher: name => tokens.every(tok => name.includes(tok)), regexError: null };
}

function checkBadgeLabel(r: StreamCheckResult): string {
  if (r.status === 'offline') return 'OFF';
  if (r.status === 'blank') return 'BLANK';
  const parts = [`${r.height}p`];
  if (r.fps) parts.push(`${Math.round(r.fps)}fps`);
  if (r.hdr) parts.push('HDR');
  return parts.join(' ');
}

// Badge color is by resolution tier for healthy streams, and a single
// error color for blank/offline regardless of resolution.
function checkBadgeColorClass(r: StreamCheckResult): string {
  if (r.status === 'offline' || r.status === 'blank') return 'error';
  if (r.height && r.height >= 2160) return 'uhd';
  if (r.height && r.height >= 1080) return 'hd';
  return 'sd';
}

interface MainViewProps {
  allChannels: Channel[];
  favouriteUrls: Set<string>;
  favouriteCategories: Set<string>;
  historyUrls: string[];
  viewMode: ViewMode;
  searchQuery: string;
  searchMode: SearchMode;
  stripSuperscript: boolean;
  drillCategory: string | null;
  markedUrls: Set<string>;
  checkResults: Map<string, StreamCheckResult>;
  bestUrls: Set<string>;
  setDrillCategory: (cat: string | null) => void;
  onToggleMarked: (streamUrl: string) => void;
  onVisibleChannels: (urls: string[]) => void;
  onToggleFavourite: (streamUrl: string) => void;
  onToggleFavouriteCategory: (categoryName: string) => void;
  onPlayChannel: (url: string, skipHistory?: boolean) => void;
  onDebugText: (text: string) => void;
}

export default function MainView({
  allChannels,
  favouriteUrls,
  favouriteCategories,
  historyUrls,
  viewMode,
  searchQuery,
  searchMode,
  stripSuperscript,
  drillCategory,
  markedUrls,
  checkResults,
  bestUrls,
  setDrillCategory,
  onToggleMarked,
  onVisibleChannels,
  onToggleFavourite,
  onToggleFavouriteCategory,
  onPlayChannel,
  onDebugText,
}: MainViewProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(RENDER_BATCH_SIZE);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);

  const { allCategories, channelNamesLower, categoryNamesLower } = useMemo(() => {
    const channelNamesLower = allChannels.map(ch => searchNormalize(ch.name));
    const catMap = new Map<string, number>();
    for (const ch of allChannels) {
      const group = ch.group_title || 'Uncategorized';
      catMap.set(group, (catMap.get(group) || 0) + 1);
    }
    const allCategories = Array.from(catMap, ([name, count]) => ({ name, count }));
    const categoryNamesLower = allCategories.map(c => searchNormalize(c.name));
    return { allCategories, channelNamesLower, categoryNamesLower };
  }, [allChannels]);

  const { items, totalCount, elapsed, renderMode, regexError } = useMemo(() => {
    const t0 = performance.now();
    const { matcher, regexError } = buildMatcher(searchQuery.trim(), searchMode);

    // An incomplete pattern (typed mid-edit) shows the error rather than an
    // unfiltered grid.
    if (regexError) {
      return { items: [], totalCount: 0, elapsed: performance.now() - t0, renderMode: 'channels' as const, regexError };
    }

    let channels: Channel[] | null = null;
    let categories: Category[] | null = null;

    if (drillCategory) {
      const catChannels = allChannels.filter(ch => (ch.group_title || 'Uncategorized') === drillCategory);
      channels = matcher ? catChannels.filter(ch => matcher(searchNormalize(ch.name))) : catChannels;
    } else if (viewMode === 'history') {
      const historyChannels: Channel[] = [];
      const channelByUrl = new Map(allChannels.map(ch => [ch.stream_url, ch]));
      for (const url of historyUrls) {
        const ch = channelByUrl.get(url);
        if (ch) historyChannels.push(ch);
      }
      channels = matcher ? historyChannels.filter(ch => matcher(searchNormalize(ch.name))) : historyChannels;
    } else if (viewMode === 'favourites') {
      const favCategories = allCategories.filter(cat => favouriteCategories.has(cat.name));
      const seen = new Set<string>();
      const favChannels = allChannels.filter(ch => {
        if (!favouriteUrls.has(ch.stream_url) || seen.has(ch.stream_url)) return false;
        seen.add(ch.stream_url);
        return true;
      }).sort((a, b) => {
        const byPlaylist = (a.playlist_name || '').localeCompare(b.playlist_name || '');
        if (byPlaylist !== 0) return byPlaylist;
        return a.name.localeCompare(b.name);
      });
      const matchingChannels = matcher ? favChannels.filter(ch => matcher(searchNormalize(ch.name))) : favChannels;
      const matchingCategories = matcher ? favCategories.filter(cat => matcher(searchNormalize(cat.name))) : favCategories;
      const items = [...matchingCategories, ...matchingChannels];
      return { items, totalCount: items.length, elapsed: performance.now() - t0, renderMode: 'favourites' as const, regexError };
    } else if (viewMode === 'channels') {
      channels = matcher ? allChannels.filter((_, i) => matcher(channelNamesLower[i])) : allChannels;
    } else {
      // categories view
      categories = matcher ? allCategories.filter((_, i) => matcher(categoryNamesLower[i])) : allCategories;
    }

    const elapsed = performance.now() - t0;
    if (categories) {
      const totalCount = categories.length;
      return { items: categories, totalCount, elapsed, renderMode: 'categories' as const, regexError };
    }
    const totalCount = channels!.length;
    return { items: channels!, totalCount, elapsed, renderMode: 'channels' as const, regexError };
  }, [allChannels, allCategories, channelNamesLower, categoryNamesLower, favouriteUrls, favouriteCategories, historyUrls, viewMode, drillCategory, searchQuery, searchMode]);

  // Reset only when the query identity changes — never on `items` reference
  // changes, since favourite/history updates rebuild the array and would
  // collapse the list back to one batch mid-scroll.
  useLayoutEffect(() => {
    setVisibleCount(RENDER_BATCH_SIZE);
    setLoadingUrl(null);
    gridRef.current?.closest('main')?.scrollTo({ top: 0 });
  }, [viewMode, drillCategory, searchQuery, searchMode, allChannels]);

  const visibleItems = items.slice(0, visibleCount);
  const hasMore = visibleCount < totalCount;

  const totalCountRef = useRef(totalCount);
  totalCountRef.current = totalCount;

  // Re-created per batch: a fresh observe() always delivers an initial entry,
  // so loading chains when a new batch still leaves the sentinel within the
  // rootMargin instead of stalling until the next scroll.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setVisibleCount(prev => Math.min(prev + RENDER_BATCH_SIZE, totalCountRef.current));
    }, {
      root: gridRef.current?.closest('main') ?? null,
      rootMargin: '1200px 0px',
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  useEffect(() => {
    const renderedCount = Math.min(visibleCount, totalCount);
    onDebugText(`${renderedCount} / ${totalCount} results in ${elapsed.toFixed(1)}ms`);
  }, [visibleCount, totalCount, elapsed, onDebugText]);

  // Report the currently found channels up for the check-all fallback; cleared
  // on unmount (settings open) so the toolbar button can't target a stale list.
  useEffect(() => {
    onVisibleChannels(renderMode === 'channels'
      ? (items as Channel[]).map(ch => ch.stream_url)
      : renderMode === 'favourites'
        ? (items as Array<Category | Channel>).filter((item): item is Channel => 'stream_url' in item).map(ch => ch.stream_url)
        : []);
    return () => onVisibleChannels([]);
  }, [items, renderMode, onVisibleChannels]);

  const handleGridClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    const catCard = target.closest('.category-card') as HTMLElement | null;
    if (catCard?.dataset.category) {
      setDrillCategory(catCard.dataset.category);
      return;
    }

    const card = target.closest('.channel-card') as HTMLElement | null;
    if (card?.dataset.url) {
      setLoadingUrl(card.dataset.url);
      onPlayChannel(card.dataset.url, viewMode === 'history');
    }
  }, [setDrillCategory, onPlayChannel, viewMode]);

  // Right-click opens a native menu with the single favourite toggle, so a
  // stray click can't silently change anything.
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;

    const catCard = target.closest('.category-card') as HTMLElement | null;
    if (catCard?.dataset.category) {
      const name = catCard.dataset.category;
      if (await window.electronAPI.showFavouriteMenu({ isFavourite: favouriteCategories.has(name), isCategory: true })) {
        onToggleFavouriteCategory(name);
      }
      return;
    }

    const card = target.closest('.channel-card') as HTMLElement | null;
    if (!card?.dataset.url) return;
    const url = card.dataset.url;
    if (await window.electronAPI.showFavouriteMenu({ isFavourite: favouriteUrls.has(url) })) {
      onToggleFavourite(url);
    }
  }, [favouriteUrls, favouriteCategories, onToggleFavourite, onToggleFavouriteCategory]);

  // Middle click marks a channel for the stream checker. auxclick also fires
  // for the right button, which contextmenu owns — hence the button guard.
  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const card = (e.target as HTMLElement).closest('.channel-card') as HTMLElement | null;
    if (card?.dataset.url) onToggleMarked(card.dataset.url);
  }, [onToggleMarked]);

  // Middle-click autoscroll is armed at mousedown time, so it can only be
  // suppressed here, not in auxclick.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  }, []);

  const displayName = (ch: Channel) =>
    stripSuperscript && viewMode === 'favourites' ? stripSuperscripts(ch.name) : ch.name;

  const emptyMessage = regexError
    ? `Invalid regex: ${regexError}`
    : allChannels.length === 0
      ? 'No channels loaded. Open Settings to add a playlist.'
      : searchQuery.trim()
        ? `No results for "${searchQuery.trim()}".`
        : viewMode === 'history' && !drillCategory
          ? 'No channels played yet.'
          : viewMode === 'favourites' && !drillCategory
            ? 'No favourites yet. Right-click a channel or category to add one.'
            : 'Nothing here.';

  return (
    <>
      {drillCategory && (
        <div className="drill-header">
          <button className="back-btn" onClick={() => setDrillCategory(null)}>&larr; Back</button>
          <span className="drill-title">{drillCategory}</span>
        </div>
      )}
      {visibleItems.length === 0 && (
        <div id="empty-state">
          <p>{emptyMessage}</p>
        </div>
      )}
      <div
        id="channel-grid"
        ref={gridRef}
        onClick={handleGridClick}
        onContextMenu={handleContextMenu}
        onAuxClick={handleAuxClick}
        onMouseDown={handleMouseDown}
      >
        {renderMode === 'categories' || renderMode === 'favourites'
          ? (visibleItems as Array<Category | Channel>).map(item => 'stream_url' in item ? (() => {
              const ch = item;
              const name = displayName(ch);
              const res = checkResults.get(ch.stream_url);
              const classes = ['channel-card'];
              if (loadingUrl === ch.stream_url) classes.push('loading');
              if (markedUrls.has(ch.stream_url)) classes.push('marked');
              if (res?.status === 'checking') classes.push('checking');
              if (res?.status === 'ok' && bestUrls.has(ch.stream_url)) classes.push('best');
              return (
                <div key={`channel-${ch.id}`} className={classes.join(' ')} data-url={ch.stream_url} title={name}>
                  {favouriteUrls.has(ch.stream_url) && <span className="favourite-star">&#9733;</span>}
                  <div className="channel-logo">
                    <img src={ch.logo} alt="" loading="lazy" decoding="async" width={100} height={50} onError={e => { (e.target as HTMLImageElement).dataset.error = ''; }} />
                    <span className="logo-fallback">{name.charAt(0)}</span>
                  </div>
                  <div className="channel-name">{name}</div>
                  {ch.playlist_name && <div className="channel-playlist">{ch.playlist_name}</div>}
                  {res && res.status !== 'pending' && res.status !== 'checking' && <span className={`check-badge ${checkBadgeColorClass(res)}`}>{checkBadgeLabel(res)}</span>}
                </div>
              );
            })() : (
              <div key={`category-${item.name}`} className="category-card" data-category={item.name}>
                {favouriteCategories.has(item.name) && <span className="favourite-star">&#9733;</span>}
                <span className="category-name">{item.name}</span>
                <span className="category-count">{item.count} ch.</span>
              </div>
            ))
          : (visibleItems as Channel[]).map(ch => {
              const name = displayName(ch);
              const res = checkResults.get(ch.stream_url);
              const classes = ['channel-card'];
              if (loadingUrl === ch.stream_url) classes.push('loading');
              if (markedUrls.has(ch.stream_url)) classes.push('marked');
              if (res?.status === 'checking') classes.push('checking');
              if (res?.status === 'ok' && bestUrls.has(ch.stream_url)) classes.push('best');
              return (
                <div
                  key={ch.id}
                  className={classes.join(' ')}
                  data-url={ch.stream_url}
                  title={name}
                >
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
                  {res && res.status !== 'pending' && res.status !== 'checking' && (
                    <span className={`check-badge ${checkBadgeColorClass(res)}`}>{checkBadgeLabel(res)}</span>
                  )}
                </div>
              );
            })
        }
      </div>
      {hasMore && <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
    </>
  );
}
