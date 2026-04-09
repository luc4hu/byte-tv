import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
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

let db: DatabaseSync;

function initDB() {
  const dbPath = path.join(app.getPath('userData'), 'channels.db');
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      logo TEXT,
      group_title TEXT,
      stream_url TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS favourites (
      stream_url TEXT PRIMARY KEY NOT NULL
    )
  `);
}

function registerIPC() {
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const content = fs.readFileSync(result.filePaths[0], 'utf-8');
    const channels = parseM3U(content);

    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM channels');
      const insert = db.prepare(
        'INSERT INTO channels (name, logo, group_title, stream_url) VALUES (?, ?, ?, ?)'
      );
      for (const ch of channels) {
        insert.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return { canceled: false, count: channels.length };
  });

  ipcMain.handle('channels:getAll', () => {
    return db.prepare('SELECT * FROM channels ORDER BY id ASC').all();
  });

  ipcMain.handle('channels:search', (_event, query: string) => {
    return db.prepare(
      "SELECT * FROM channels WHERE name LIKE '%' || ? || '%' ORDER BY id ASC"
    ).all(query);
  });

  ipcMain.handle('channels:play', (_event, url: string) => {
    const child = spawn('mpv', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  });

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
  initDB();
  registerIPC();
  createWindow();
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
