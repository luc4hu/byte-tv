import { app, BrowserWindow, ipcMain, Menu, net, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import started from 'electron-squirrel-startup';
import { runMigrations } from './migrations';
import type { StreamCheckResult } from './types';
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

  // Fire all three requests concurrently — they are independent, and the
  // categories/streams responses are only consumed after auth has been
  // validated. This hides the auth round-trip behind the big streams download
  // (worth 75–300ms per refresh); the only cost is wasted bandwidth in the
  // failed-auth case.
  let t = Date.now();
  const [authRes, catRes, streamRes] = await Promise.all([
    net.fetch(apiUrl),
    net.fetch(`${apiUrl}&action=get_live_categories`),
    net.fetch(`${apiUrl}&action=get_live_streams`),
  ]);
  logDebug(`[xtream:fetch] auth+categories+streams HTTP done in ${Date.now() - t}ms`);

  // Report auth problems first — with bad credentials the other two requests
  // fail too, but "authentication failed" is the actionable error.
  if (!authRes.ok) throw new Error(`Xtream server error: ${authRes.status}`);
  const auth = (await authRes.json()) as XtreamAuthResponse;
  if (auth.user_info?.auth !== 1) {
    throw new Error('Xtream authentication failed: invalid credentials or account inactive');
  }

  const expDate = auth.user_info?.exp_date ?? '';

  if (!catRes.ok) throw new Error(`Failed to fetch categories: ${catRes.status}`);
  if (!streamRes.ok) throw new Error(`Failed to fetch streams: ${streamRes.status}`);

  t = Date.now();
  const [categories, streams] = await Promise.all([
    catRes.json() as Promise<XtreamCategory[]>,
    streamRes.json() as Promise<XtreamStream[]>,
  ]);
  logDebug(`[xtream:parse] categories (${categories.length}) + streams (${streams.length}) JSON parsed in ${Date.now() - t}ms`);

  t = Date.now();
  const categoryMap = new Map<string, string>();
  for (const cat of categories) {
    categoryMap.set(String(cat.category_id), cat.category_name);
  }

  const channels: Channel[] = streams.map((s) => ({
    name: s.name,
    logo: s.stream_icon || '',
    groupTitle: categoryMap.get(String(s.category_id)) || '',
    streamUrl: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`,
  }));
  logDebug(`[xtream:build] built ${channels.length} channels in ${Date.now() - t}ms`);

  return { channels, expDate };
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

// Insert channels 100 rows per statement — measured ~2x faster than one
// .run() per row for 55k-channel playlists (per-statement overhead dominates).
const INSERT_BATCH_ROWS = 100;

function insertChannels(channels: Channel[], playlistId: number) {
  let i = 0;
  if (channels.length >= INSERT_BATCH_ROWS) {
    const batch = db.prepare(
      `INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES ${new Array(INSERT_BATCH_ROWS).fill('(?, ?, ?, ?, ?)').join(', ')}`
    );
    const params = new Array(INSERT_BATCH_ROWS * 5);
    for (; i + INSERT_BATCH_ROWS <= channels.length; i += INSERT_BATCH_ROWS) {
      for (let j = 0; j < INSERT_BATCH_ROWS; j++) {
        const ch = channels[i + j];
        const o = j * 5;
        params[o] = ch.name;
        params[o + 1] = ch.logo;
        params[o + 2] = ch.groupTitle;
        params[o + 3] = ch.streamUrl;
        params[o + 4] = playlistId;
      }
      batch.run(...params);
    }
  }
  const single = db.prepare(
    'INSERT INTO channels (name, logo, group_title, stream_url, playlist_id) VALUES (?, ?, ?, ?, ?)'
  );
  for (; i < channels.length; i++) {
    const ch = channels[i];
    single.run(ch.name, ch.logo, ch.groupTitle, ch.streamUrl, playlistId);
  }
}

let db: DatabaseSync;
let mpvChild: ChildProcess | null = null;
let streamCheckActive = false;
let streamCheckCancelled = false;
let streamCheckChild: ChildProcess | null = null;
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

function settingFlags(key: string): string[] {
  const flagsStr = (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';
  return flagsStr.trim() ? flagsStr.trim().split(/\s+/) : [];
}

async function playMpv(url: string) {
  const flags = settingFlags('mpv_flags');

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
}

function playVlc(url: string) {
  const flags = settingFlags('vlc_flags');
  // '--one-instance' forwards the URL to a running VLC, replacing the current
  // item (--playlist-enqueue defaults off). '--' stops option parsing so a URL
  // starting with '-' can't inject options. With one-instance this spawned
  // child is short-lived (it hands off and exits), so there's no persistent
  // process to track — VLC runs as an independent app and is not managed on quit.
  const args = [...flags, '--one-instance', '--', url];
  logInfo('[vlc]', args.join(' '));
  const child = spawn('vlc', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (d) => logWarn('[vlc:stderr]', d.toString().trimEnd()));
  child.on('error', (e) => logError('[vlc:spawn]', e.message));
  child.on('exit', (code, signal) => logInfo('[vlc:exit]', `code=${code} signal=${signal ?? 'none'}`));
  child.unref();
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Spawn a short-lived process, buffer its output, and resolve when it exits.
// Unlike the mpv/vlc spawns this child is managed: it's tracked in
// streamCheckChild so cancel/quit can kill it, and SIGKILLed after killAfterMs
// (ffmpeg ignores SIGTERM while blocked in a network read).
function runCheckProcess(cmd: string, args: string[], killAfterMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    streamCheckChild = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, killAfterMs);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    // 'error' (e.g. ENOENT) is not followed by 'close' when the spawn itself
    // failed, hence the settled guard covering both paths.
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (streamCheckChild === child) streamCheckChild = null;
      logDebug('[streamcheck:proc]', `${cmd} exit code=${code ?? 'spawn-failed'}${timedOut ? ' (killed: timeout)' : ''} in ${Date.now() - t0}ms`);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('error', () => finish(null));
    child.on('close', finish);
  });
}

interface StreamBanner {
  width: number;
  height: number;
  fps?: number;
  hdr?: boolean;
}

// ffmpeg has no ffprobe-style structured output, but at loglevel 'info' it
// prints an "Input #0 ... / Stream #0:0: Video: ..., WxH ..., FF fps, ..."
// banner before decoding starts. Undocumented/unversioned (unlike ffprobe's
// JSON), but stable in practice and lets one ffmpeg call replace ffprobe +
// ffmpeg entirely. The banner repeats for the (remuxed) output stream, which
// is distinguished by an always-present "q=" (encoder quantizer range) — take
// the first Video line that lacks it. The same line also carries the colour
// tags, which is where HDR comes from.
function parseStreamBanner(stderr: string): StreamBanner | null {
  const inputSection = stderr.split(/\r?\nOutput #\d+/)[0];
  for (const line of inputSection.split(/\r?\n/)) {
    if (!/Stream #\d+:\d+.*Video:/.test(line) || line.includes('q=')) continue;
    // {2,5} digits excludes the mpegts PID marker some inputs prepend, e.g.
    // "Stream #0:0[0x100]: Video: ..." — "0x100" would otherwise match first.
    const dims = line.match(/(\d{2,5})x(\d{2,5})/);
    if (!dims) continue;
    const fpsMatch = line.match(/([\d.]+)\s*fps/);
    // Colour tags live in the pix_fmt parens, e.g. "yuv420p10le(tv,
    // bt2020nc/bt2020/smpte2084)" — often absent entirely ("yuv420p(progressive)").
    // Only the transfer function is conclusive: smpte2084 = PQ/HDR10,
    // arib-std-b67 = HLG. bt2020 primaries and 10-bit depth are not used, since
    // real feeds ship 10-bit HEVC tagged bt709 (SDR) and would false-positive.
    const hdr = /\b(?:smpte2084|arib-std-b67)\b/.test(line);
    return {
      width: Number(dims[1]),
      height: Number(dims[2]),
      fps: fpsMatch ? Number(fpsMatch[1]) : undefined,
      hdr: hdr || undefined,
    };
  }
  return null;
}

// One ffmpeg call does the whole check: read the stream banner for
// resolution/fps, then decode a handful of frames and check whether the
// picture is a uniform black/gray screen. signalstats YLOW/YHIGH are the
// 10th/90th-percentile luma per frame: a dead feed has a tiny spread even
// with compression noise, real content is well above 10.
async function checkStream(url: string): Promise<StreamCheckResult> {
  // ffmpeg has no '--' end-of-options terminator, so refuse anything that
  // isn't plainly http(s) — this is the option-injection guard.
  if (!/^https?:\/\//i.test(url)) return { streamUrl: url, status: 'offline', error: 'unsupported url' };
  const args = [
    '-hide_banner', '-v', 'info', '-nostats',
    '-rw_timeout', '2500000',
    '-analyzeduration', '3000000',
    '-probesize', '5000000',
    // Deblocking only improves visual quality, which is irrelevant to a
    // stats-only check — skipping it cuts decode cost for free.
    '-skip_loop_filter', 'all',
    '-i', url,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '5',
    // Downscale before signalstats: decode cost is fixed (the encoded frame
    // must be fully decoded regardless), but signalstats scans every pixel,
    // so shrinking first cuts that cost with no measurable loss of accuracy
    // (verified against real detailed content and a blank feed down to 80px;
    // below ~320px timing stops improving and can even regress).
    '-vf', 'scale=640:-2,signalstats,metadata=mode=print:file=-',
    '-f', 'null', '-',
  ];
  const t0 = Date.now();
  const res = await runCheckProcess('ffmpeg', args, 30_000);
  const ms = Date.now() - t0;
  let result: StreamCheckResult;
  if (res.timedOut) {
    result = { streamUrl: url, status: 'offline', error: 'timeout' };
  } else if (res.code !== 0) {
    result = { streamUrl: url, status: 'offline', error: `ffmpeg exit ${res.code ?? 'spawn-failed'}` };
  } else {
    const banner = parseStreamBanner(res.stderr);
    if (!banner) {
      result = { streamUrl: url, status: 'offline', error: 'no video stream' };
    } else {
      const lows: number[] = [];
      const highs: number[] = [];
      for (const m of res.stdout.matchAll(/lavfi\.signalstats\.(YLOW|YHIGH)=([\d.]+)/g)) {
        (m[1] === 'YLOW' ? lows : highs).push(Number(m[2]));
      }
      const frames = Math.min(lows.length, highs.length);
      const blank = frames > 0
        ? Array.from({ length: frames }, (_, i) => highs[i] - lows[i]).every(spread => spread <= 10)
        : true; // connected and decoded nothing usable — treat as blank, not a false "ok"
      result = { streamUrl: url, status: blank ? 'blank' : 'ok', width: banner.width, height: banner.height, fps: banner.fps, hdr: banner.hdr };
    }
  }
  logInfo('[streamcheck]', `${url} -> ${result.status}${result.height ? ` ${result.height}p${result.fps ? ' ' + Math.round(result.fps) + 'fps' : ''}${result.hdr ? ' HDR' : ''}` : ''}${result.error ? ` (${result.error})` : ''} in ${ms}ms`);
  return result;
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

      insertChannels(channels, playlistId);
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
      const t_pl = Date.now();
      db.prepare(
        "INSERT INTO playlists (name, path, type, xtream_username, xtream_password, exp_date, last_refreshed) VALUES (?, ?, 'xtream', ?, ?, ?, datetime('now'))"
      ).run(name, normalizedUrl, username, password, expDate || null);
      const playlistId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
      logDebug(`[import:xtream] playlist row inserted in ${Date.now() - t_pl}ms`);

      const t_ins = Date.now();
      insertChannels(channels, playlistId);
      logDebug(`[import:xtream] inserted ${channels.length} channel rows in ${Date.now() - t_ins}ms`);

      const t_commit = Date.now();
      db.exec('COMMIT');
      logDebug(`[import:xtream] commit in ${Date.now() - t_commit}ms`);

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

    const t_old = Date.now();
    const oldRows = db.prepare('SELECT stream_url FROM channels WHERE playlist_id = ?').all(playlistId) as { stream_url: string }[];
    const oldByStreamId = new Map<string, string>();
    for (const row of oldRows) {
      const streamId = xtreamStreamIdFromUrl(row.stream_url);
      if (streamId) oldByStreamId.set(streamId, row.stream_url);
    }
    logDebug(`[update:xtream:${playlist.name}] read ${oldRows.length} old rows + built stream id map in ${Date.now() - t_old}ms`);

    const t1 = Date.now();
    db.exec('BEGIN');
    try {
      const t_upd = Date.now();
      db.prepare(`
        UPDATE playlists
        SET name = ?, path = ?, xtream_username = ?, xtream_password = ?, exp_date = ?, last_refreshed = datetime('now')
        WHERE id = ?
      `).run(name, normalizedUrl, username, password, expDate || null, playlistId);
      logDebug(`[update:xtream:${playlist.name}] playlist update in ${Date.now() - t_upd}ms`);

      const t_del = Date.now();
      db.prepare('DELETE FROM channels WHERE playlist_id = ?').run(playlistId);
      logDebug(`[update:xtream:${playlist.name}] delete old channels in ${Date.now() - t_del}ms`);

      const t_ins = Date.now();
      insertChannels(channels, playlistId);
      logDebug(`[update:xtream:${playlist.name}] inserted ${channels.length} channels in ${Date.now() - t_ins}ms`);

      const t_remap = Date.now();
      remapStreamUrlReferences(oldByStreamId, channels);
      logDebug(`[update:xtream:${playlist.name}] remap references in ${Date.now() - t_remap}ms`);

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
      const t_del = Date.now();
      db.prepare('DELETE FROM channels WHERE playlist_id = ?').run(playlistId);
      logDebug(`[refresh:${playlist.name}] delete old channels in ${Date.now() - t_del}ms`);

      const t_ins = Date.now();
      insertChannels(channels, playlistId);
      logDebug(`[refresh:${playlist.name}] inserted ${channels.length} channels in ${Date.now() - t_ins}ms`);

      const t_upd = Date.now();
      db.prepare("UPDATE playlists SET exp_date = ?, last_refreshed = datetime('now') WHERE id = ?").run(expDate || null, playlistId);
      logDebug(`[refresh:${playlist.name}] update playlist row in ${Date.now() - t_upd}ms`);

      const t_commit = Date.now();
      db.exec('COMMIT');
      logDebug(`[refresh:${playlist.name}] commit in ${Date.now() - t_commit}ms`);

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

    const player = (db.prepare('SELECT value FROM settings WHERE key = ?').get('video_player') as { value: string } | undefined)?.value || 'mpv';
    if (player === 'vlc') {
      playVlc(url);
    } else {
      await playMpv(url);
    }
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

  ipcMain.handle('favourites:getCategories', () => {
    const rows = db.prepare('SELECT category_name FROM favourite_categories').all() as { category_name: string }[];
    return rows.map(r => r.category_name);
  });

  ipcMain.handle('favourites:toggleCategory', (_event, categoryName: string) => {
    const row = db.prepare('SELECT 1 FROM favourite_categories WHERE category_name = ?').get(categoryName);
    if (row) {
      db.prepare('DELETE FROM favourite_categories WHERE category_name = ?').run(categoryName);
      return { isFavourite: false };
    } else {
      db.prepare('INSERT INTO favourite_categories (category_name) VALUES (?)').run(categoryName);
      return { isFavourite: true };
    }
  });

  // Native right-click menu with the single favourite toggle. Resolves true if
  // the entry was chosen, false if the menu was dismissed; the renderer owns
  // the actual toggle so it stays on the existing favourites:toggle path.
  ipcMain.handle('favourites:contextMenu', (event, opts: { isFavourite: boolean; isCategory?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    return new Promise<boolean>(resolve => {
      let settled = false;
      const done = (chosen: boolean) => {
        if (settled) return;
        settled = true;
        resolve(chosen);
      };
      const what = opts.isCategory ? 'favourite categories' : 'favourites';
      const menu = Menu.buildFromTemplate([{
        label: opts.isFavourite ? `Remove from ${what}` : `Add to ${what}`,
        click: () => done(true),
      }]);
      // The close callback can run before the item's click handler, so the
      // dismissal answer is deferred a tick to let a real click win.
      menu.popup({ window: win, callback: () => setTimeout(() => done(false), 0) });
    });
  });

  // Stream check
  ipcMain.handle('streamcheck:run', async (event, urls: string[]) => {
    if (streamCheckActive) throw new Error('A stream check is already running');
    streamCheckActive = true;
    streamCheckCancelled = false;
    const t0 = Date.now();
    logInfo('[streamcheck]', `run started: ${urls.length} channel${urls.length === 1 ? '' : 's'}`);
    const sender = event.sender;
    const push = (r: StreamCheckResult) => {
      if (!sender.isDestroyed()) sender.send('streamcheck:result', r);
    };
    let done = 0;
    try {
      for (const url of urls) {
        if (streamCheckCancelled || sender.isDestroyed()) break;
        push({ streamUrl: url, status: 'checking' });
        push(await checkStream(url));
        done++;
      }
    } finally {
      streamCheckActive = false;
      streamCheckChild = null;
      logInfo('[streamcheck]', `run finished: ${done}/${urls.length} checked in ${Date.now() - t0}ms${streamCheckCancelled ? ' (cancelled)' : ''}`);
    }
  });

  ipcMain.handle('streamcheck:cancel', () => {
    streamCheckCancelled = true;
    streamCheckChild?.kill('SIGKILL');
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
  // ffprobe/ffmpeg children aren't detached but would still outlive the parent
  // on Linux — kill any in-flight check explicitly.
  streamCheckCancelled = true;
  streamCheckChild?.kill('SIGKILL');
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
