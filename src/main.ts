import { app, BrowserWindow, dialog, ipcMain, net, session } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import started from 'electron-squirrel-startup';

if (started) {
  app.quit();
}

// Set a limit of 200MB for the disk cache (in bytes)
app.commandLine.appendSwitch('disk-cache-size', '209715200');

interface Channel {
  name: string;
  logo: string;
  groupTitle: string;
  streamUrl: string;
}

interface XtreamAuthResponse {
  user_info: { auth: number; status: string };
  server_info: { url: string; port: string };
}

interface XtreamCategory {
  category_id: string;
  category_name: string;
}

interface XtreamStream {
  stream_id: number;
  name: string;
  stream_icon: string;
  category_id: string;
}

function parseM3U(content: string): Channel[] {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const channels: Channel[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF:')) continue;

    const nameMatch = line.match(/,(.+)$/);
    const logoMatch = line.match(/tvg-logo="([^"]*)"/);
    const groupMatch = line.match(/group-title="([^"]*)"/);

    let streamUrl = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].startsWith('#')) {
        streamUrl = lines[j];
        break;
      }
    }

    if (nameMatch && streamUrl) {
      channels.push({
        name: nameMatch[1].trim(),
        logo: logoMatch?.[1] || '',
        groupTitle: groupMatch?.[1] || '',
        streamUrl,
      });
    }
  }
  return channels;
}

async function fetchXtreamChannels(
  serverUrl: string,
  username: string,
  password: string,
): Promise<Channel[]> {
  const base = serverUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  // Authenticate
  const authRes = await net.fetch(apiUrl);
  if (!authRes.ok) throw new Error(`Xtream server error: ${authRes.status}`);
  const auth = (await authRes.json()) as XtreamAuthResponse;
  if (auth.user_info?.auth !== 1) {
    throw new Error('Xtream authentication failed: invalid credentials or account inactive');
  }

  // Fetch live categories
  const catRes = await net.fetch(`${apiUrl}&action=get_live_categories`);
  if (!catRes.ok) throw new Error(`Failed to fetch categories: ${catRes.status}`);
  const categories = (await catRes.json()) as XtreamCategory[];
  const categoryMap = new Map<string, string>();
  for (const cat of categories) {
    categoryMap.set(String(cat.category_id), cat.category_name);
  }

  // Fetch live streams
  const streamRes = await net.fetch(`${apiUrl}&action=get_live_streams`);
  if (!streamRes.ok) throw new Error(`Failed to fetch streams: ${streamRes.status}`);
  const streams = (await streamRes.json()) as XtreamStream[];

  return streams.map((s) => ({
    name: s.name,
    logo: s.stream_icon || '',
    groupTitle: categoryMap.get(String(s.category_id)) || '',
    streamUrl: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`,
  }));
}

let db: DatabaseSync;

function initDB() {
  const dbPath = path.join(app.getPath('userData'), 'channels.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT,
      type TEXT NOT NULL DEFAULT 'm3u',
      xtream_username TEXT,
      xtream_password TEXT,
      added_date TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Migrations for existing installs
  try { db.exec("ALTER TABLE playlists ADD COLUMN type TEXT NOT NULL DEFAULT 'm3u'"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE playlists ADD COLUMN xtream_username TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE playlists ADD COLUMN xtream_password TEXT'); } catch { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      logo TEXT,
      group_title TEXT,
      stream_url TEXT NOT NULL,
      playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS favourites (
      stream_url TEXT PRIMARY KEY NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      stream_url TEXT PRIMARY KEY NOT NULL,
      last_played INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
}

function registerIPC() {
  // Playlist management
  ipcMain.handle('playlists:add', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const t0 = Date.now();
    const filePath = result.filePaths[0];
    const playlistName = path.basename(filePath, path.extname(filePath));
    const content = fs.readFileSync(filePath, 'utf-8');
    console.log(`[import:file] read file in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);

    const t1 = Date.now();
    const channels = parseM3U(content);
    console.log(`[import:file] parsed ${channels.length} channels in ${Date.now() - t1}ms`);

    const t2 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO playlists (name, path) VALUES (?, ?)').run(playlistName, filePath);
      const playlistId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      db.exec('COMMIT');
      console.log(`[import:file] inserted ${channels.length} rows in ${Date.now() - t2}ms`);
      console.log(`[import:file] total: ${Date.now() - t0}ms`);
      return { canceled: false, playlistId, count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle('playlists:addFromURL', async (_event, url: string) => {
    const t0 = Date.now();
    const response = await net.fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
    const content = await response.text();
    console.log(`[import:url] fetched in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);

    const t1 = Date.now();
    const channels = parseM3U(content);
    console.log(`[import:url] parsed ${channels.length} channels in ${Date.now() - t1}ms`);

    let playlistName: string;
    try {
      const parsed = new URL(url);
      const base = path.basename(parsed.pathname, path.extname(parsed.pathname));
      playlistName = base && base !== '/' ? base : parsed.hostname;
    } catch {
      playlistName = url;
    }

    const t2 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO playlists (name, path) VALUES (?, ?)').run(playlistName, url);
      const playlistId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      db.exec('COMMIT');
      console.log(`[import:url] inserted ${channels.length} rows in ${Date.now() - t2}ms`);
      console.log(`[import:url] total: ${Date.now() - t0}ms`);
      return { canceled: false, playlistId, count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle('playlists:addXtream', async (_event, serverUrl: string, username: string, password: string) => {
    const t0 = Date.now();
    const channels = await fetchXtreamChannels(serverUrl, username, password);
    console.log(`[import:xtream] fetched ${channels.length} channels in ${Date.now() - t0}ms`);

    const normalizedUrl = serverUrl.replace(/\/+$/, '');

    let playlistName: string;
    try {
      playlistName = new URL(normalizedUrl).hostname;
    } catch {
      playlistName = normalizedUrl;
    }

    const t1 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare(
        "INSERT INTO playlists (name, path, type, xtream_username, xtream_password) VALUES (?, ?, 'xtream', ?, ?)"
      ).run(playlistName, normalizedUrl, username, password);
      const playlistId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      db.exec('COMMIT');
      console.log(`[import:xtream] inserted ${channels.length} rows in ${Date.now() - t1}ms`);
      console.log(`[import:xtream] total: ${Date.now() - t0}ms`);
      return { canceled: false, playlistId, count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle('playlists:getAll', () => {
    return db.prepare(`
      SELECT p.id, p.name, p.path, p.type, p.added_date,
             COUNT(c.id) as channel_count
      FROM playlists p
      LEFT JOIN channels c ON c.playlist_id = p.id
      GROUP BY p.id
      ORDER BY p.id ASC
    `).all();
  });

  ipcMain.handle('playlists:delete', (_event, playlistId: number) => {
    db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
  });

  ipcMain.handle('playlists:refresh', async (_event, playlistId: number) => {
    const t0 = Date.now();
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
      { id: number; name: string; path: string | null; type: string; xtream_username: string | null; xtream_password: string | null } | undefined;
    if (!playlist) throw new Error('Playlist not found');
    if (!playlist.path) throw new Error('No path for playlist');

    let channels: Channel[];
    if (playlist.type === 'xtream') {
      channels = await fetchXtreamChannels(playlist.path, playlist.xtream_username!, playlist.xtream_password!);
      console.log(`[refresh:${playlist.name}] fetched ${channels.length} xtream channels in ${Date.now() - t0}ms`);
    } else {
      const isURL = /^https?:\/\//i.test(playlist.path);
      let content: string;
      if (isURL) {
        const response = await net.fetch(playlist.path);
        if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
        content = await response.text();
        console.log(`[refresh:${playlist.name}] fetched URL in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);
      } else {
        content = fs.readFileSync(playlist.path, 'utf-8');
        console.log(`[refresh:${playlist.name}] read file in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);
      }
      const t1 = Date.now();
      channels = parseM3U(content);
      console.log(`[refresh:${playlist.name}] parsed ${channels.length} channels in ${Date.now() - t1}ms`);
    }

    const t2 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM channels WHERE playlist_id = ?').run(playlistId);
      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      db.exec('COMMIT');
      console.log(`[refresh:${playlist.name}] deleted + inserted ${channels.length} rows in ${Date.now() - t2}ms`);
      console.log(`[refresh:${playlist.name}] total: ${Date.now() - t0}ms`);
      return { count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  // Settings
  ipcMain.handle('settings:get', (_event, key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? '';
  });

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  });

  // Channels
  ipcMain.handle('channels:getAll', () => {
    return db.prepare('SELECT * FROM channels ORDER BY id ASC').all();
  });

  ipcMain.handle('channels:search', (_event, query: string) => {
    return db.prepare(
      "SELECT * FROM channels WHERE name LIKE '%' || ? || '%' ORDER BY id ASC"
    ).all(query);
  });

  ipcMain.handle('channels:play', (_event, url: string) => {
    db.prepare(`
      INSERT INTO history (stream_url, last_played)
      VALUES (?, ?)
      ON CONFLICT(stream_url) DO UPDATE SET last_played = excluded.last_played
    `).run(url, Date.now());

    const flagsStr = (db.prepare('SELECT value FROM settings WHERE key = ?').get('mpv_flags') as { value: string } | undefined)?.value ?? '';
    const flags = flagsStr.trim() ? flagsStr.trim().split(/\s+/) : [];
    const args = [...flags, url];
    console.log('mpv', args.join(' '));
    const child = spawn('mpv', args, { detached: true, stdio: 'ignore' });
    child.unref();
  });

  // History
  ipcMain.handle('history:getAll', () => {
    const rows = db.prepare('SELECT stream_url FROM history ORDER BY last_played DESC').all() as { stream_url: string }[];
    return rows.map(r => r.stream_url);
  });

  // Favourites
  ipcMain.handle('favourites:getAll', () => {
    const rows = db.prepare('SELECT stream_url FROM favourites').all() as { stream_url: string }[];
    return rows.map(r => r.stream_url);
  });

  ipcMain.handle('favourites:toggle', (_event, streamUrl: string) => {
    const row = db.prepare('SELECT 1 FROM favourites WHERE stream_url = ?').get(streamUrl);
    if (row) {
      db.prepare('DELETE FROM favourites WHERE stream_url = ?').run(streamUrl);
      return { isFavourite: false };
    } else {
      db.prepare('INSERT INTO favourites (stream_url) VALUES (?)').run(streamUrl);
      return { isFavourite: true };
    }
  });

  // Cache
  ipcMain.handle('cache:getSize', async () => {
    return await session.defaultSession.getCacheSize();
  });

  ipcMain.handle('cache:clear', async () => {
    await session.defaultSession.clearCache();
    return await session.defaultSession.getCacheSize();
  });
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('zoom-changed', (_event, direction) => {
    const current = mainWindow.webContents.getZoomFactor();
    if (direction === 'in') {
      mainWindow.webContents.setZoomFactor(Math.min(current + 0.1, 3));
    } else {
      mainWindow.webContents.setZoomFactor(Math.max(current - 0.1, 0.3));
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

app.on('ready', () => {
  const t0 = Date.now();
  console.log('[startup] app ready');

  initDB();
  console.log(`[startup] initDB done in ${Date.now() - t0}ms`);

  registerIPC();
  console.log(`[startup] registerIPC done in ${Date.now() - t0}ms`);

  createWindow();
  console.log(`[startup] createWindow done in ${Date.now() - t0}ms`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
