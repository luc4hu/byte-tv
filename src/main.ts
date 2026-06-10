import { app, BrowserWindow, ipcMain, net, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import started from 'electron-squirrel-startup';
import { runMigrations } from './migrations';
import {
  logInfo,
  logWarn,
  logError,
  logDebug,
  initLogger,
  getLogs,
  clearLogs,
  subscribeLogs,
} from './logger';

if (started) {
  app.quit();
}

// Global error handlers — must be registered early
process.on('uncaughtException', (err) => {
  try { logError('[uncaughtException]', err); } catch { /* last resort */ }
});
process.on('unhandledRejection', (reason) => {
  try { logError('[unhandledRejection]', String(reason)); } catch { /* last resort */ }
});

interface Channel {
  name: string;
  logo: string;
  groupTitle: string;
  streamUrl: string;
}

interface XtreamAuthResponse {
  user_info: {
    auth: number;
    status: string;
    exp_date: string;
    is_trial: string;
    active_cons: string;
    created_at: string;
    max_connections: string;
    username: string;
    password: string;
    message: string;
    allowed_output_formats: string[];
  };
  server_info: {
    url: string;
    port: string;
    https_port: string;
    server_protocol: string;
    rtmp_port: string;
    timezone: string;
    timestamp_now: number;
    time_now: string;
  };
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

interface PlaylistRow {
  id: number;
  name: string;
  path: string | null;
  type: string;
  xtream_username: string | null;
  xtream_password: string | null;
  exp_date: string | null;
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
      // Stop at the next entry so a channel without a URL doesn't steal the following one's
      if (lines[j].startsWith('#EXTINF:')) break;
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

async function readResponseBody(
  response: Awaited<ReturnType<typeof net.fetch>>,
  onProgress: (percent: number) => void,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length')) || 0;
  const body = response.body;
  if (!body) return response.text();

  const reader = body.getReader();
  // One decoder for the whole stream — multi-byte UTF-8 sequences can span chunks
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
    received += value.byteLength;
    if (contentLength > 0) {
      onProgress(Math.round((received / contentLength) * 100));
    }
  }
  chunks.push(decoder.decode());

  return chunks.join('');
}

async function fetchXtreamChannels(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ channels: Channel[]; expDate: string }> {
  const base = serverUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  // Authenticate
  const authRes = await net.fetch(apiUrl);
  if (!authRes.ok) throw new Error(`Xtream server error: ${authRes.status}`);
  const auth = (await authRes.json()) as XtreamAuthResponse;
  if (auth.user_info?.auth !== 1) {
    throw new Error('Xtream authentication failed: invalid credentials or account inactive');
  }

  const expDate = auth.user_info?.exp_date ?? '';

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

  return {
    channels: streams.map((s) => ({
      name: s.name,
      logo: s.stream_icon || '',
      groupTitle: categoryMap.get(String(s.category_id)) || '',
      streamUrl: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`,
    })),
    expDate,
  };
}

function xtreamStreamIdFromUrl(streamUrl: string): string | null {
  const match = streamUrl.match(/\/live\/[^/]+\/[^/]+\/(\d+)\.ts(?:[?#].*)?$/);
  return match?.[1] ?? null;
}

function remapStreamUrlReferences(oldByStreamId: Map<string, string>, channels: Channel[]) {
  const getHistory = db.prepare('SELECT last_played FROM history WHERE stream_url = ?');
  const moveFavourite = db.prepare('INSERT OR IGNORE INTO favourites (stream_url) SELECT ? WHERE EXISTS (SELECT 1 FROM favourites WHERE stream_url = ?)');
  const deleteFavourite = db.prepare('DELETE FROM favourites WHERE stream_url = ?');
  const upsertHistory = db.prepare(`
    INSERT INTO history (stream_url, last_played)
    VALUES (?, ?)
    ON CONFLICT(stream_url) DO UPDATE SET last_played =
      CASE
        WHEN history.last_played > excluded.last_played THEN history.last_played
        ELSE excluded.last_played
      END
  `);
  const deleteHistory = db.prepare('DELETE FROM history WHERE stream_url = ?');

  for (const ch of channels) {
    const streamId = xtreamStreamIdFromUrl(ch.streamUrl);
    if (!streamId) continue;

    const oldUrl = oldByStreamId.get(streamId);
    if (!oldUrl || oldUrl === ch.streamUrl) continue;

    const history = getHistory.get(oldUrl) as { last_played: number } | undefined;

    moveFavourite.run(ch.streamUrl, oldUrl);
    deleteFavourite.run(oldUrl);

    if (history) {
      upsertHistory.run(ch.streamUrl, history.last_played);
      deleteHistory.run(oldUrl);
    }
  }
}

let db: DatabaseSync;
let mpvChild: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let logsWindow: BrowserWindow | null = null;

// mpv uses Unix domain sockets on Linux/macOS, named pipes on Windows.
// Node's net.createConnection needs the \\\\.\\pipe\\ prefix on Windows.
const mpvSocketPath = () =>
  process.platform === 'win32'
    ? '\\\\.\\pipe\\byte-tv-mpv'
    : path.join(app.getPath('userData'), 'mpv-socket');

function mpvCommand(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(mpvSocketPath());
    let buf = '';
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => {
      const msg = JSON.stringify({ command: args, request_id: 1 }) + '\n';
      socket.write(msg);
    });
    socket.on('data', (data) => {
      buf += data.toString();
      // Process complete lines
      let nlIdx: number;
      while ((nlIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nlIdx).trim();
        buf = buf.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { request_id?: number; error?: string };
          if (parsed.request_id === 1) {
            done(parsed.error === 'success');
            return;
          }
        } catch {
          logDebug('[mpv:event]', line);
        }
      }
    });
    socket.on('error', (e) => {
      logDebug('[mpv:socket]', e);
      done(false);
    });
    socket.setTimeout(2000, () => {
      logWarn('[mpv:socket] timeout');
      done(false);
    });
  });
}

async function stopMpv() {
  if (mpvChild && !mpvChild.killed) {
    try { mpvChild.kill(); } catch (e) { logWarn('[mpv:kill]', e); }
  }
  mpvChild = null;
}

function initDB() {
  const dbPath = path.join(app.getPath('userData'), 'channels.db');
  db = new DatabaseSync(dbPath);
  // foreign_keys must be set outside a transaction, so it stays here rather than
  // in a migration.
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
}

function registerIPC() {
  // App
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Playlist management
  ipcMain.handle('playlists:addFromURL', async (_event, name: string, url: string) => {
    const t0 = Date.now();
    const response = await net.fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
    const content = await response.text();
    logInfo(`[import:url] fetched in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);

    const t1 = Date.now();
    const channels = parseM3U(content);
    logInfo(`[import:url] parsed ${channels.length} channels in ${Date.now() - t1}ms`);

    const t2 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare("INSERT INTO playlists (name, path, last_refreshed) VALUES (?, ?, datetime('now'))").run(name, url);
      const playlistId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      db.exec('COMMIT');
      logInfo(`[import:url] inserted ${channels.length} rows in ${Date.now() - t2}ms`);
      logInfo(`[import:url] total: ${Date.now() - t0}ms`);
      return { playlistId, count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      logError('[import:url]', e);
      throw e;
    }
  });

  ipcMain.handle('playlists:addXtream', async (_event, name: string, serverUrl: string, username: string, password: string) => {
    const t0 = Date.now();
    const { channels, expDate } = await fetchXtreamChannels(serverUrl, username, password);
    logInfo(`[import:xtream] fetched ${channels.length} channels in ${Date.now() - t0}ms`);

    const normalizedUrl = serverUrl.replace(/\/+$/, '');

    const t1 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare(
        "INSERT INTO playlists (name, path, type, xtream_username, xtream_password, exp_date, last_refreshed) VALUES (?, ?, 'xtream', ?, ?, ?, datetime('now'))"
      ).run(name, normalizedUrl, username, password, expDate || null);
      const playlistId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      db.exec('COMMIT');
      logInfo(`[import:xtream] inserted ${channels.length} rows in ${Date.now() - t1}ms`);
      logInfo(`[import:xtream] total: ${Date.now() - t0}ms`);
      return { playlistId, count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      logError('[import:xtream]', e);
      throw e;
    }
  });

  ipcMain.handle('playlists:getXtreamDetails', (_event, playlistId: number) => {
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as PlaylistRow | undefined;
    if (!playlist) throw new Error('Playlist not found');
    if (playlist.type !== 'xtream') throw new Error('Playlist is not an Xtream playlist');

    return {
      id: playlist.id,
      name: playlist.name,
      serverUrl: playlist.path ?? '',
      username: playlist.xtream_username ?? '',
      password: playlist.xtream_password ?? '',
    };
  });

  ipcMain.handle('playlists:updateXtream', async (_event, playlistId: number, name: string, serverUrl: string, username: string, password: string) => {
    const t0 = Date.now();
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as PlaylistRow | undefined;
    if (!playlist) throw new Error('Playlist not found');
    if (playlist.type !== 'xtream') throw new Error('Playlist is not an Xtream playlist');

    const { channels, expDate } = await fetchXtreamChannels(serverUrl, username, password);
    logInfo(`[update:xtream:${playlist.name}] fetched ${channels.length} channels in ${Date.now() - t0}ms`);

    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    const oldRows = db.prepare('SELECT stream_url FROM channels WHERE playlist_id = ?').all(playlistId) as { stream_url: string }[];
    const oldByStreamId = new Map<string, string>();
    for (const row of oldRows) {
      const streamId = xtreamStreamIdFromUrl(row.stream_url);
      if (streamId) oldByStreamId.set(streamId, row.stream_url);
    }

    const t1 = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE playlists
        SET name = ?, path = ?, xtream_username = ?, xtream_password = ?, exp_date = ?, last_refreshed = datetime('now')
        WHERE id = ?
      `).run(name, normalizedUrl, username, password, expDate || null, playlistId);
      db.prepare('DELETE FROM channels WHERE playlist_id = ?').run(playlistId);

      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
      }
      remapStreamUrlReferences(oldByStreamId, channels);
      db.exec('COMMIT');
      logInfo(`[update:xtream:${name}] updated ${channels.length} rows in ${Date.now() - t1}ms`);
      return { count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      logError('[update:xtream]', e);
      throw e;
    }
  });

  ipcMain.handle('playlists:getAll', () => {
    return db.prepare(`
      SELECT p.id, p.name, p.path, p.type, p.added_date, p.exp_date, p.last_refreshed,
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

  ipcMain.handle('playlists:refresh', async (event, playlistId: number) => {
    const t0 = Date.now();
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as PlaylistRow | undefined;
    if (!playlist) throw new Error('Playlist not found');
    if (!playlist.path) throw new Error('No path for playlist');

    const sender = event.sender;
    let lastReport = 0;
    const report = (phase: string, percent?: number) => {
      if (!sender.isDestroyed()) {
        // Throttle percentage updates to avoid flooding the renderer with IPC
        // and causing cascading re-renders. Phase transitions always go through.
        const now = Date.now();
        if (percent != null && now - lastReport < 200) return;
        lastReport = now;
        sender.send('playlists:refreshProgress', { playlistId, phase, percent });
      }
    };

    let channels: Channel[];
    let expDate = '';
    if (playlist.type === 'xtream') {
      report('downloading');
      const result = await fetchXtreamChannels(playlist.path, playlist.xtream_username!, playlist.xtream_password!);
      channels = result.channels;
      expDate = result.expDate;
      logInfo(`[refresh:${playlist.name}] fetched ${channels.length} xtream channels in ${Date.now() - t0}ms`);
    } else {
      const isURL = /^https?:\/\//i.test(playlist.path);
      let content: string;
      if (isURL) {
        report('downloading');
        const response = await net.fetch(playlist.path);
        if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
        content = await readResponseBody(response, (pct) => report('downloading', pct));
        logInfo(`[refresh:${playlist.name}] fetched URL in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);
      } else {
        content = await fs.promises.readFile(playlist.path, 'utf-8');
        logInfo(`[refresh:${playlist.name}] read file in ${Date.now() - t0}ms (${(content.length / 1024).toFixed(0)} KB)`);
      }
      report('parsing');
      const t1 = Date.now();
      channels = parseM3U(content);
      logInfo(`[refresh:${playlist.name}] parsed ${channels.length} channels in ${Date.now() - t1}ms`);
    }

    report('inserting');
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
      db.prepare("UPDATE playlists SET exp_date = ?, last_refreshed = datetime('now') WHERE id = ?").run(expDate || null, playlistId);
      db.exec('COMMIT');
      logInfo(`[refresh:${playlist.name}] deleted + inserted ${channels.length} rows in ${Date.now() - t2}ms`);
      logInfo(`[refresh:${playlist.name}] total: ${Date.now() - t0}ms`);
      return { count: channels.length };
    } catch (e) {
      db.exec('ROLLBACK');
      logError('[refresh]', e);
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
    return db.prepare(`
      SELECT c.*, p.name as playlist_name
      FROM channels c
      LEFT JOIN playlists p ON c.playlist_id = p.id
      ORDER BY c.id ASC
    `).all();
  });

  ipcMain.handle('channels:play', async (_event, url: string, skipHistory = false) => {
    if (!skipHistory) {
      db.prepare(`
        INSERT INTO history (stream_url, last_played)
        VALUES (?, ?)
        ON CONFLICT(stream_url) DO UPDATE SET last_played = excluded.last_played
      `).run(url, Date.now());
    }

    const flagsStr = (db.prepare('SELECT value FROM settings WHERE key = ?').get('mpv_flags') as { value: string } | undefined)?.value ?? '';
    const flags = flagsStr.trim() ? flagsStr.trim().split(/\s+/) : [];

    // Try to replace the stream in the running mpv instance via IPC
    const replaced = await mpvCommand(['loadfile', url, 'replace']);
    if (replaced) {
      logInfo('[mpv] replaced stream via IPC');
      return;
    }

    // mpv not running or IPC failed — spawn a new instance.
    // '--' stops option parsing so a stream URL starting with '-' can't inject mpv options.
    await stopMpv();
    const args = [...flags, '--input-ipc-server=' + mpvSocketPath(), '--', url];
    logInfo('[mpv]', args.join(' '));
    mpvChild = spawn('mpv', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    mpvChild.stdout?.on('data', (d) => {
      // mpv outputs playback status lines like "AV: 00:00:13 / 00:00:32 (41%)..."
      // multiple times per second. Filter them out to avoid flooding the logs.
      const lines = d.toString().split(/\r?\n|\r/).map((l: string) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (!/^(AV:|\s*\(Paused\) AV:)/.test(line)) {
          logInfo('[mpv:stdout]', line);
        }
      }
    });
    mpvChild.stderr?.on('data', (d) => logWarn('[mpv:stderr]', d.toString().trimEnd()));
    mpvChild.on('error', (e) => logError('[mpv:spawn]', e.message));
    mpvChild.on('exit', (code, signal) => logInfo('[mpv:exit]', `code=${code} signal=${signal ?? 'none'}`));
    mpvChild.unref();
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

  // Logging
  ipcMain.handle('logs:get', () => getLogs());
  ipcMain.handle('logs:clear', () => clearLogs());
  ipcMain.handle('logs:openFolder', () => {
    shell.openPath(path.join(app.getPath('userData'), 'logs'));
  });
  ipcMain.handle('logs:fromRenderer', (_event, level: string, message: string) => {
    if (level === 'warn') logWarn('[renderer]', message);
    else if (level === 'error') logError('[renderer]', message);
    else logInfo('[renderer]', message);
  });
  ipcMain.handle('logs:openWindow', () => { createLogsWindow(); });
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;

  win.maximize();

  win.webContents.on('zoom-changed', (_event, direction) => {
    const current = win.webContents.getZoomFactor();
    if (direction === 'in') {
      win.webContents.setZoomFactor(Math.min(current + 0.1, 3));
    } else {
      win.webContents.setZoomFactor(Math.max(current - 0.1, 0.3));
    }
  });

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools();
      }
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

function createLogsWindow() {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    autoHideMenuBar: true,
    title: 'byte-tv Logs',
    webPreferences: {
      preload: path.join(__dirname, 'logs-preload.js'),
    },
  });
  logsWindow = win;

  win.on('closed', () => { logsWindow = null; });

  if (LOGS_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${LOGS_WINDOW_VITE_DEV_SERVER_URL}/logs-index.html`);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${LOGS_WINDOW_VITE_NAME}/logs-index.html`),
    );
  }
}

app.on('ready', () => {
  const t0 = Date.now();

  initLogger(path.join(app.getPath('userData'), 'logs'));
  logInfo('[startup] app ready');

  initDB();
  logInfo(`[startup] initDB done in ${Date.now() - t0}ms`);

  registerIPC();
  logInfo(`[startup] registerIPC done in ${Date.now() - t0}ms`);

  createWindow();
  logInfo(`[startup] createWindow done in ${Date.now() - t0}ms`);

  // Subscribe once — createWindow can run again on macOS 'activate', and
  // subscribers are never removed, so subscribing there duplicates entries.
  subscribeLogs((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('logs:entry', entry);
    }
    if (logsWindow && !logsWindow.isDestroyed()) {
      logsWindow.webContents.send('logs:entry', entry);
    }
  });
});

app.on('window-all-closed', () => {
  mainWindow = null;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Electron doesn't await async 'before-quit' listeners, so block the first
// quit, run the mpv shutdown, then quit for real.
let mpvShutdownDone = false;
app.on('before-quit', (event) => {
  if (mpvShutdownDone) return;
  event.preventDefault();
  (async () => {
    // Try graceful IPC shutdown first, then fall back to kill
    const sent = await mpvCommand(['quit']).catch(() => false);
    if (!sent) {
      await stopMpv();
    }
  })().finally(() => {
    mpvShutdownDone = true;
    app.quit();
  });
});
