import './index.css';

interface Channel {
  id: number;
  name: string;
  logo: string;
  group_title: string;
  stream_url: string;
}

interface Category {
  name: string;
  count: number;
}

declare global {
  interface Window {
    electronAPI: {
      openFile: () => Promise<{ canceled: boolean; count?: number }>;
      getChannels: () => Promise<Channel[]>;
      searchChannels: (query: string) => Promise<Channel[]>;
      playChannel: (url: string) => Promise<void>;
      getFavourites: () => Promise<string[]>;
      toggleFavourite: (streamUrl: string) => Promise<{ isFavourite: boolean }>;
      getCacheSize: () => Promise<number>;
      clearCache: () => Promise<number>;
    };
  }
}

const grid = document.getElementById('channel-grid') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const uploadBtn = document.getElementById('upload-btn') as HTMLElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const debugTimer = document.getElementById('debug-timer') as HTMLElement;
const toggleBtns = document.querySelectorAll<HTMLButtonElement>('.toggle-btn');
const themeToggle = document.getElementById('theme-toggle');

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

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });
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

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function channelCardHTML(ch: Channel): string {
  const isFav = favouriteUrls.has(ch.stream_url);
  return `
    <div class="channel-card" data-url="${escapeHtml(ch.stream_url)}">
      ${isFav ? '<span class="favourite-star">&#9733;</span>' : ''}
      <div class="channel-logo">
        <img src="${escapeHtml(ch.logo)}" alt="" loading="lazy"
             decoding="async" width="100" height="50"
             onerror="this.dataset.error=''" />
        <span class="logo-fallback">${escapeHtml(ch.name.charAt(0))}</span>
      </div>
      <div class="channel-name">${escapeHtml(ch.name)}</div>
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
  // Add/update drill header before the grid
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

  // Derive categories from group_title
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
    // Drill mode: filter channels within this category
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
    renderChannels(results);
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
    // Categories mode
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
  const [channels, favUrls] = await Promise.all([
    window.electronAPI.getChannels(),
    window.electronAPI.getFavourites(),
  ]);
  favouriteUrls = new Set(favUrls);
  buildIndex(channels);
  debugTimer.textContent = `${allChannels.length} channels loaded`;
  refresh();
}

// Toggle buttons
for (const btn of toggleBtns) {
  btn.addEventListener('click', () => {
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

uploadBtn.addEventListener('click', async () => {
  const result = await window.electronAPI.openFile();
  if (!result.canceled) {
    await loadChannels();
  }
});

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

// Update cache size every second
const cacheSizeText = document.getElementById('cache-size-text');
const clearCacheBtn = document.getElementById('clear-cache-btn') as HTMLButtonElement;

async function updateCacheSize() {
  if (!cacheSizeText) return;
  const sizeInBytes = await window.electronAPI.getCacheSize();
  const sizeInMB = (sizeInBytes / 1024 / 1024).toFixed(2);
  cacheSizeText.textContent = `Cache: ${sizeInMB} MB`;
}

if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    clearCacheBtn.textContent = '...';
    const newSize = await window.electronAPI.clearCache();
    const sizeInMB = (newSize / 1024 / 1024).toFixed(2);
    if (cacheSizeText) cacheSizeText.textContent = `Cache: ${sizeInMB} MB`;
    clearCacheBtn.textContent = 'Clear';
    clearCacheBtn.disabled = false;
  });
}

setInterval(updateCacheSize, 1000);
updateCacheSize();

loadChannels();