import './index.css';

interface Channel {
  id: number;
  name: string;
  logo: string;
  group_title: string;
  stream_url: string;
  playlist_id: number;
}

interface Category {
  name: string;
  count: number;
}

interface Playlist {
  id: number;
  name: string;
  path: string | null;
  added_date: string;
  channel_count: number;
}

declare global {
  interface Window {
    electronAPI: {
      addPlaylist: () => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
      addPlaylistFromURL: (url: string) => Promise<{ canceled: boolean; playlistId?: number; count?: number }>;
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

const grid = document.getElementById('channel-grid') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const debugTimer = document.getElementById('debug-timer') as HTMLElement;
const toggleBtns = document.querySelectorAll<HTMLButtonElement>('.toggle-btn');
const settingsToggleBtn = document.getElementById('settings-toggle') as HTMLButtonElement;
const settingsPage = document.getElementById('settings-page') as HTMLElement;

// Theme management
function setTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
  if (savedTheme) {
    setTheme(savedTheme);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

initTheme();

// In-memory caches
let allChannels: Channel[] = [];
let channelNamesLower: string[] = [];
let allCategories: Category[] = [];
let categoryNamesLower: string[] = [];
let favouriteUrls: Set<string> = new Set();

const RENDER_LIMIT = 200;

// View state
let viewMode: 'channels' | 'categories' | 'favourites' = 'channels';
let drillCategory: string | null = null;
let settingsOpen = false;
let stripSuperscript = false;

const SUPERSCRIPT_RE = /[\u00AA\u00B2\u00B3\u00B9\u00BA\u02B0-\u02FF\u1D2C-\u1D6A\u1D78\u1D9B-\u1DBF\u2070-\u207F]/g;
function stripSuperscripts(s: string): string {
  return s.replace(SUPERSCRIPT_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function channelCardHTML(ch: Channel, strip = false): string {
  const isFav = favouriteUrls.has(ch.stream_url);
  const displayName = strip ? stripSuperscripts(ch.name) : ch.name;
  return `
    <div class="channel-card" data-url="${escapeHtml(ch.stream_url)}">
      ${isFav ? '<span class="favourite-star">&#9733;</span>' : ''}
      <div class="channel-logo">
        <img src="${escapeHtml(ch.logo)}" alt="" loading="lazy"
             decoding="async" width="100" height="50"
             onerror="this.dataset.error=''" />
        <span class="logo-fallback">${escapeHtml(displayName.charAt(0))}</span>
      </div>
      <div class="channel-name">${escapeHtml(displayName)}</div>
    </div>`;
}

function categoryCardHTML(cat: Category): string {
  return `
    <div class="category-card" data-category="${escapeHtml(cat.name)}">
      <span class="category-name">${escapeHtml(cat.name)}</span>
      <span class="category-count">${cat.count} ch.</span>
    </div>`;
}

function renderChannels(channels: Channel[]) {
  if (channels.length === 0) {
    grid.innerHTML = '';
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  grid.style.paddingTop = '';
  grid.style.paddingBottom = '';
  const itemsToRender = channels.slice(0, RENDER_LIMIT);
  grid.innerHTML = itemsToRender.map(channelCardHTML).join('');
}

function renderCategories(categories: Category[]) {
  document.querySelector('.drill-header')?.remove();

  if (categories.length === 0) {
    grid.innerHTML = '';
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  grid.style.paddingTop = '';
  grid.style.paddingBottom = '';
  const itemsToRender = categories.slice(0, RENDER_LIMIT);
  grid.innerHTML = itemsToRender.map(categoryCardHTML).join('');
}

function renderDrillView(category: string, channels: Channel[]) {
  let header = document.querySelector('.drill-header') as HTMLElement | null;
  if (!header) {
    header = document.createElement('div');
    header.className = 'drill-header';
    grid.parentElement?.insertBefore(header, grid);
  }
  if (header) {
    header.innerHTML = `
      <button class="back-btn" id="back-btn">&larr; Back</button>
      <span class="drill-title">${escapeHtml(category)}</span>
    `;
  }

  renderChannels(channels);
}

function buildIndex(channels: Channel[]) {
  allChannels = channels;
  channelNamesLower = channels.map(ch => ch.name.toLowerCase());

  const catMap = new Map<string, number>();
  for (const ch of channels) {
    const group = ch.group_title || 'Uncategorized';
    catMap.set(group, (catMap.get(group) || 0) + 1);
  }
  allCategories = Array.from(catMap, ([name, count]) => ({ name, count }));
  categoryNamesLower = allCategories.map(c => c.name.toLowerCase());
}

function search(query: string) {
  const t0 = performance.now();
  const q = query.toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  if (drillCategory) {
    const catChannels = allChannels.filter(ch => (ch.group_title || 'Uncategorized') === drillCategory);
    let results: Channel[];
    if (tokens.length === 0) {
      results = catChannels;
    } else {
      results = catChannels.filter(ch => {
        const name = ch.name.toLowerCase();
        for (const tok of tokens) {
          if (!name.includes(tok)) return false;
        }
        return true;
      });
    }
    const elapsed = performance.now() - t0;
    debugTimer.textContent = `${results.length} results in ${elapsed.toFixed(1)}ms`;
    renderDrillView(drillCategory, results);
  } else if (viewMode === 'favourites') {
    const seen = new Set<string>();
    const favChannels = allChannels.filter(ch => {
      if (!favouriteUrls.has(ch.stream_url) || seen.has(ch.stream_url)) return false;
      seen.add(ch.stream_url);
      return true;
    });
    let results: Channel[];
    if (tokens.length === 0) {
      results = favChannels;
    } else {
      results = favChannels.filter(ch => {
        const name = ch.name.toLowerCase();
        for (const tok of tokens) {
          if (!name.includes(tok)) return false;
        }
        return true;
      });
    }
    const elapsed = performance.now() - t0;
    debugTimer.textContent = `${results.length} results in ${elapsed.toFixed(1)}ms`;
    if (results.length === 0) {
      grid.innerHTML = '';
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
      const itemsToRender = results.slice(0, RENDER_LIMIT);
      grid.innerHTML = itemsToRender.map(ch => channelCardHTML(ch, stripSuperscript)).join('');
    }
  } else if (viewMode === 'channels') {
    let results: Channel[];
    if (tokens.length === 0) {
      results = allChannels;
    } else if (tokens.length === 1) {
      const tok = tokens[0];
      results = allChannels.filter((_, i) => channelNamesLower[i].includes(tok));
    } else {
      results = allChannels.filter((_, i) => {
        const name = channelNamesLower[i];
        for (const tok of tokens) {
          if (!name.includes(tok)) return false;
        }
        return true;
      });
    }
    const elapsed = performance.now() - t0;
    debugTimer.textContent = `${results.length} results in ${elapsed.toFixed(1)}ms`;
    renderChannels(results);
  } else {
    let results: Category[];
    if (tokens.length === 0) {
      results = allCategories;
    } else if (tokens.length === 1) {
      const tok = tokens[0];
      results = allCategories.filter((_, i) => categoryNamesLower[i].includes(tok));
    } else {
      results = allCategories.filter((_, i) => {
        const name = categoryNamesLower[i];
        for (const tok of tokens) {
          if (!name.includes(tok)) return false;
        }
        return true;
      });
    }
    const elapsed = performance.now() - t0;
    debugTimer.textContent = `${results.length} results in ${elapsed.toFixed(1)}ms`;
    renderCategories(results);
  }
}

function refresh() {
  searchInput.value = '';
  search('');
}

async function loadChannels() {
  const [channels, favUrls, stripSuperscriptSetting] = await Promise.all([
    window.electronAPI.getChannels(),
    window.electronAPI.getFavourites(),
    window.electronAPI.getSetting('strip_superscript'),
  ]);
  favouriteUrls = new Set(favUrls);
  stripSuperscript = stripSuperscriptSetting === '1';
  buildIndex(channels);
  debugTimer.textContent = `${allChannels.length} channels loaded`;
  refresh();
}

// Settings page
function showSettings() {
  settingsOpen = true;
  settingsToggleBtn.classList.add('active');
  settingsPage.style.display = 'block';
  grid.style.display = 'none';
  emptyState.style.display = 'none';
  document.querySelector('.drill-header')?.remove();
  renderSettings();
}

function hideSettings() {
  settingsOpen = false;
  settingsToggleBtn.classList.remove('active');
  settingsPage.style.display = 'none';
  grid.style.display = '';
  refresh();
}

async function renderSettings() {
  const [playlists, mpvFlags, cacheSize, stripSuperscriptSetting] = await Promise.all([
    window.electronAPI.getPlaylists(),
    window.electronAPI.getSetting('mpv_flags'),
    window.electronAPI.getCacheSize(),
    window.electronAPI.getSetting('strip_superscript'),
  ]);

  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const cacheMB = (cacheSize / 1024 / 1024).toFixed(2);

  settingsPage.innerHTML = `
    <div class="settings-section">
      <h2>Playlists</h2>
      <div id="playlist-list">
        ${playlists.length === 0 ? '<p class="settings-empty">No playlists added yet.</p>' : ''}
        ${playlists.map(p => `
          <div class="playlist-item" data-id="${p.id}">
            <div class="playlist-item-info">
              <span class="playlist-item-name">${escapeHtml(p.name)}</span>
              <span class="playlist-item-meta">${p.channel_count} channels${p.path ? ' &middot; ' + escapeHtml(p.path) : ''}</span>
            </div>
            <div class="playlist-item-actions">
              <button class="refresh-btn" data-id="${p.id}">Refresh</button>
              <button class="delete-btn" data-id="${p.id}">Delete</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="playlist-add-actions">
        <button id="add-playlist-btn">Add Playlist</button>
        <button id="add-url-btn">Add URL</button>
      </div>
      <div id="url-input-row" class="url-input-row" style="display:none">
        <input id="url-input" type="url" placeholder="https://example.com/playlist.m3u" />
        <button id="url-confirm-btn">Add</button>
        <button id="url-cancel-btn">Cancel</button>
      </div>
    </div>

    <div class="settings-section">
      <h2>mpv Flags</h2>
      <p class="settings-hint">Custom flags passed to mpv on playback (space-separated).</p>
      <textarea id="mpv-flags-input" placeholder="e.g. --vo=gpu --hwdec=auto">${escapeHtml(mpvFlags)}</textarea>
    </div>

    <div class="settings-section">
      <h2>Appearance</h2>
      <div class="theme-setting">
        <span>Theme</span>
        <div class="view-toggle">
          <button class="toggle-btn theme-btn ${currentTheme === 'light' ? 'active' : ''}" data-theme="light">Light</button>
          <button class="toggle-btn theme-btn ${currentTheme === 'dark' ? 'active' : ''}" data-theme="dark">Dark</button>
        </div>
      </div>
      <div class="theme-setting">
        <span>Strip superscript (favourites)</span>
        <div class="view-toggle">
          <button class="toggle-btn strip-super-btn ${stripSuperscriptSetting === '1' ? 'active' : ''}" data-strip-super="1">On</button>
          <button class="toggle-btn strip-super-btn ${stripSuperscriptSetting !== '1' ? 'active' : ''}" data-strip-super="0">Off</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Cache</h2>
      <div class="cache-setting">
        <span>Browser cache: ${cacheMB} MB</span>
        <button id="settings-clear-cache">Clear</button>
      </div>
    </div>
  `;

  // Wire up event listeners
  document.getElementById('add-playlist-btn')?.addEventListener('click', async () => {
    const result = await window.electronAPI.addPlaylist();
    if (!result.canceled) {
      await loadChannels();
      renderSettings();
    }
  });

  const urlInputRow = document.getElementById('url-input-row');
  const urlInput = document.getElementById('url-input') as HTMLInputElement;

  document.getElementById('add-url-btn')?.addEventListener('click', () => {
    if (urlInputRow) urlInputRow.style.display = '';
    if (urlInput) { urlInput.value = ''; urlInput.focus(); }
  });

  document.getElementById('url-cancel-btn')?.addEventListener('click', () => {
    if (urlInputRow) urlInputRow.style.display = 'none';
  });

  document.getElementById('url-confirm-btn')?.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const confirmBtn = document.getElementById('url-confirm-btn') as HTMLButtonElement;
    confirmBtn.textContent = '...';
    confirmBtn.disabled = true;
    try {
      const result = await window.electronAPI.addPlaylistFromURL(url);
      if (!result.canceled) {
        await loadChannels();
        renderSettings();
      }
    } catch {
      confirmBtn.textContent = 'Error';
      confirmBtn.disabled = false;
    }
  });

  for (const btn of settingsPage.querySelectorAll<HTMLButtonElement>('.refresh-btn')) {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      btn.textContent = '...';
      btn.disabled = true;
      try {
        await window.electronAPI.refreshPlaylist(id);
        await loadChannels();
      } catch (e) {
        btn.textContent = 'Error';
      }
      renderSettings();
    });
  }

  for (const btn of settingsPage.querySelectorAll<HTMLButtonElement>('.delete-btn')) {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      await window.electronAPI.deletePlaylist(id);
      await loadChannels();
      renderSettings();
    });
  }

  const mpvInput = document.getElementById('mpv-flags-input') as HTMLTextAreaElement;
  mpvInput?.addEventListener('blur', () => {
    window.electronAPI.setSetting('mpv_flags', mpvInput.value);
  });

  for (const btn of settingsPage.querySelectorAll<HTMLButtonElement>('.theme-btn')) {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme as 'light' | 'dark';
      setTheme(theme);
      for (const b of settingsPage.querySelectorAll<HTMLButtonElement>('.theme-btn')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }

  for (const btn of settingsPage.querySelectorAll<HTMLButtonElement>('.strip-super-btn')) {
    btn.addEventListener('click', () => {
      stripSuperscript = btn.dataset.stripSuper === '1';
      window.electronAPI.setSetting('strip_superscript', stripSuperscript ? '1' : '0');
      for (const b of settingsPage.querySelectorAll<HTMLButtonElement>('.strip-super-btn')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }

  document.getElementById('settings-clear-cache')?.addEventListener('click', async () => {
    const btn = document.getElementById('settings-clear-cache') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '...';
    const newSize = await window.electronAPI.clearCache();
    const newMB = (newSize / 1024 / 1024).toFixed(2);
    btn.textContent = 'Clear';
    btn.disabled = false;
    const cacheSpan = btn.parentElement?.querySelector('span');
    if (cacheSpan) cacheSpan.textContent = `Browser cache: ${newMB} MB`;
  });
}

settingsToggleBtn.addEventListener('click', () => {
  if (settingsOpen) {
    hideSettings();
  } else {
    showSettings();
  }
});

// Toggle buttons
for (const btn of toggleBtns) {
  btn.addEventListener('click', () => {
    if (settingsOpen) hideSettings();
    if (btn.dataset.view === viewMode && !drillCategory) return;
    for (const b of toggleBtns) b.classList.toggle('active', b === btn);
    viewMode = btn.dataset.view as 'channels' | 'categories' | 'favourites';
    drillCategory = null;
    document.querySelector('.drill-header')?.remove();
    searchInput.placeholder =
      viewMode === 'channels' ? 'Search channels...' :
      viewMode === 'categories' ? 'Search categories...' :
      'Search favourites...';
    refresh();
  });
}

let debounceTimer: number;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    search(searchInput.value.trim());
  }, 16);
});

// Grid clicks: channels play, categories drill in
grid.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  const catCard = target.closest('.category-card') as HTMLElement | null;
  if (catCard?.dataset.category) {
    drillCategory = catCard.dataset.category;
    searchInput.value = '';
    searchInput.placeholder = 'Search in category...';
    search('');
    return;
  }

  const card = target.closest('.channel-card') as HTMLElement | null;
  if (card?.dataset.url) {
    grid.querySelector('.channel-card.loading')?.classList.remove('loading');
    card.classList.add('loading');
    window.electronAPI.playChannel(card.dataset.url);
  }
});

// Right-click toggles favourite
grid.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const card = (e.target as HTMLElement).closest('.channel-card') as HTMLElement | null;
  if (!card?.dataset.url) return;
  const streamUrl = card.dataset.url;
  const { isFavourite } = await window.electronAPI.toggleFavourite(streamUrl);
  if (isFavourite) {
    favouriteUrls.add(streamUrl);
  } else {
    favouriteUrls.delete(streamUrl);
  }
  search(searchInput.value.trim());
});

// Back button (delegated since it's dynamically created)
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'back-btn') {
    drillCategory = null;
    document.querySelector('.drill-header')?.remove();
    searchInput.placeholder = 'Search categories...';
    refresh();
  }
});

// "/" to focus search
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

loadChannels();
