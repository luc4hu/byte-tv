# Plan: Replace logs modal popup with a native Electron BrowserWindow

## Overview

Replace the in-renderer `<LogsModal>` modal overlay with a separate Electron `BrowserWindow` for the log viewer. The new window has its own preload script, its own lightweight React renderer, and its own CSS. The main process manages its lifecycle and routes log entries to it.

---

## Prerequisites

- Understanding of the Electron Forge + Vite multi-entry build system (three build types: `main`, `preload`, `renderer`).
- The Vite plugin auto-generates per-renderer globals (`*_VITE_DEV_SERVER_URL`, `*_VITE_NAME`) at build time — a local `.d.ts` declaration is needed so TypeScript knows about the new ones.
- The logs window shares the renderer Vite config (React plugin) but has its own entry point and CSS, so it doesn't pull in the full app bundle.

---

## Architecture summary

```
main.ts ──► createLogsWindow() ──► new BrowserWindow
                                       │
                          ┌────────────┴────────────┐
                          │ preload: logs-preload.ts │
                          │ load: logs-index.html   │
                          └─────────────────────────┘
                                     │
                          src/logs-renderer.tsx
                          (minimal React, own CSS)

main.ts subscribeLogs callback ──► sends to BOTH mainWindow + logsWindow
```

---

## Files touched

| File | Change |
|---|---|
| `forge.config.ts` | Add `logs_window` renderer entry + `src/logs-preload.ts` build entry |
| `src/env.d.ts` | **new** — declare `LOGS_WINDOW_VITE_DEV_SERVER_URL` and `LOGS_WINDOW_VITE_NAME` |
| `logs-index.html` | **new** — HTML entry for the logs window |
| `src/logs-renderer.tsx` | **new** — React entry point for the logs window |
| `src/logs-preload.ts` | **new** — preload exposing `getLogs`, `clearLogs`, `openLogsFolder`, `onLogEntry`, `logFromRenderer` |
| `src/logs-index.css` | **new** — self-contained CSS for the logs window (includes CSS vars + log viewer styles) |
| `src/main.ts` | Add module-level `logsWindow`, `createLogsWindow()`, IPC handler `logs:openWindow`, dual-subscription for log entries, cleanup on window close |
| `src/preload.ts` | Remove `onLogEntry`, `openLogsFolder`; add `openLogsWindow` → `ipcRenderer.invoke('logs:openWindow')` |
| `src/types.ts` | Add `openLogsWindow` to `electronAPI`; remove `onLogEntry`; keep `LogEntry`/`LogLevel` |
| `src/SettingsView.tsx` | Change "View Logs" button to call `window.electronAPI.openLogsWindow()`; remove `onOpenLogs`, `onClearLogs`, `onOpenLogsFolder` props and the Diagnostics section's button wiring (but keep the section layout) |
| `src/App.tsx` | Remove `LogsModal` import, `logsOpen` state, `handleOpenLogs`/`handleCloseLogs`/`handleClearLogs`/`handleOpenLogsFolder`, `<LogsModal>` render, and prop passthroughs to `SettingsView` |
| `src/index.css` | Remove all `logs-*` and `.log-*` CSS classes (they move to `logs-index.css`) |
| `src/LogsModal.tsx` | **delete** — replaced by the native window |

Estimated diff: ~120 lines added (new files), ~80 lines removed/modified.

---

## Steps

### Step 1 — Declare new Vite globals

**File: `src/env.d.ts` (new)**

```ts
// Type declarations for Vite-plugin-generated globals
declare const LOGS_WINDOW_VITE_DEV_SERVER_URL: string;
declare const LOGS_WINDOW_VITE_NAME: string;
```

Without this, TypeScript will error on `LOGS_WINDOW_VITE_NAME` in `main.ts`. The plugin generates these at build time based on the renderer name in `forge.config.ts`.

---

### Step 2 — Register the logs renderer and preload in forge.config.ts

**File: `forge.config.ts` (modify)**

Two changes inside the `VitePlugin({...})` block:

**2a.** Add a second preload build entry:

```ts
build: [
  { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
  { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
  { entry: 'src/logs-preload.ts', config: 'vite.preload.config.ts', target: 'preload' }, // ← new
],
```

**2b.** Add a second renderer entry:

```ts
renderer: [
  { name: 'main_window', config: 'vite.renderer.config.ts' },
  { name: 'logs_window', config: 'vite.renderer.config.ts' }, // ← new
],
```

**Considerations:**
- Both preload scripts use the same Vite config (no plugins needed).
- Both renderers share the same Vite config (React plugin). The plugin will build separate entry points.
- The Vite plugin auto-generates `LOGS_WINDOW_VITE_DEV_SERVER_URL` and `LOGS_WINDOW_VITE_NAME` at build time.

---

### Step 3 — Create the logs window preload script

**File: `src/logs-preload.ts` (new)**

Exposes a minimal API for the logs window:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogsFolder: () => ipcRenderer.invoke('logs:openFolder'),
  onLogEntry: (callback: (entry: { ts: string; level: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: any) => callback(entry);
    ipcRenderer.on('logs:entry', handler);
    return () => { ipcRenderer.removeListener('logs:entry', handler); };
  },
  logFromRenderer: (level: string, message: string) =>
    ipcRenderer.invoke('logs:fromRenderer', level, message),
});
```

**Note:** This is intentionally minimal — only the log-related methods. No channel, playlist, or settings methods are exposed to this window.

---

### Step 4 — Create the logs window CSS

**File: `src/logs-index.css` (new)**

Self-contained styles. Includes the CSS variables (dark theme) and all log-viewer-specific styles extracted from `src/index.css` plus a few new ones for the standalone window layout:

```css
:root {
  --bg-app: #121212;
  --bg-card: #1e1e1e;
  --bg-hover: #2d2d2d;
  --bg-active: #d4d4d4;
  --text-main: #f8f8f8;
  --text-muted: #d0d0d0;
  --text-icon: #999;
  --text-on-active: #111;
  --border-color: #333;
  --border-hover: #444;
  --shadow-lg: 0 8px 24px 0 rgb(0 0 0 / 0.5);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg-app);
  color: var(--text-main);
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

#root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
```

Then include the log viewer styles (header, body, log lines, filter chips, buttons) — essentially what's currently in `src/index.css` under the `/* Logs modal */` section, but adapted for a standalone layout (no backdrop, no close button needed since the user closes the window via the OS chrome).

Key differences from the modal CSS:
- No `.logs-modal-backdrop` (the window IS the backdrop)
- `.logs-modal` → `.logs-window` (full-height flex column)
- The close button can be omitted (OS window management)
- No max-height/width constraints (the window is resizable)

---

### Step 5 — Create the logs window HTML entry

**File: `logs-index.html` (new, at project root)**

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>byte-tv Logs</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/logs-renderer.tsx"></script>
  </body>
</html>
```

---

### Step 6 — Create the logs window React renderer

**File: `src/logs-renderer.tsx` (new)**

This is a standalone React app. Extract the log-display logic from `LogsModal.tsx` into this standalone renderer.

Structure:
- Import `{ createRoot }` from `react-dom/client`
- Import `LogsViewer` component (defined in the same file or extracted)
- Import `./logs-index.css`
- Mount to `#root`

The `LogsViewer` component is essentially the current `LogsModal` body but:
- No `open`/`onClose` props (always visible while the window exists)
- No backdrop overlay
- The whole viewport is the log viewer
- Still has: level filter chips, Clear / Open Folder buttons, autoscroll, live tail via `onLogEntry`

Props: none (self-contained, uses `window.electronAPI` directly).

---

### Step 7 — Update main.ts: logs window lifecycle

**File: `src/main.ts` (modify)**

**7a.** Add module-level variable:

```ts
let logsWindow: BrowserWindow | null = null;
```

**7b.** Add `createLogsWindow()` function:

```ts
function createLogsWindow() {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.focus();
    return;
  }

  logsWindow = new BrowserWindow({
    width: 900,
    height: 600,
    autoHideMenuBar: true,
    title: 'byte-tv Logs',
    webPreferences: {
      preload: path.join(__dirname, 'logs-preload.js'),
    },
  });

  logsWindow.on('closed', () => { logsWindow = null; });

  if (LOGS_WINDOW_VITE_DEV_SERVER_URL) {
    // Vite dev server serves from the project root; reference the specific HTML entry.
    logsWindow.loadURL(`${LOGS_WINDOW_VITE_DEV_SERVER_URL}/logs-index.html`);
  } else {
    // Each renderer build outputs to its own directory under .vite/renderer/.
    // Both renderer builds process all HTML files from the project root, so
    // logs-index.html is available inside the logs_window output dir.
    logsWindow.loadFile(
      path.join(__dirname, `../renderer/${LOGS_WINDOW_VITE_NAME}/logs-index.html`),
    );
  }
}
```

**7c.** Add IPC handler in `registerIPC()`:

```ts
ipcMain.handle('logs:openWindow', () => { createLogsWindow(); });
```

**7d.** Modify the `subscribeLogs` callback (currently only sends to `mainWindow`) to also forward to `logsWindow`:

```ts
subscribeLogs((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('logs:entry', entry);
  }
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.webContents.send('logs:entry', entry);
  }
});
```

**Considerations:**
- Each renderer gets its own Vite dev server on a different port. The Vite plugin discovers all `.html` files at the project root, so both `index.html` and `logs-index.html` are available in each build output.
- The dev server URL is an `http://localhost:PORT` base URL (no path suffix). Append `logs-index.html` to load the correct entry.
- In production, each renderer's build output goes to `.vite/renderer/<name>/`. Load `logs-index.html` from the logs_window output directory.
- The window should be a normal, resizable window (not maximized like the main window).

---

### Step 8 — Update preload.ts: remove log viewer methods, add openLogsWindow

**File: `src/preload.ts` (modify)**

- Remove `onLogEntry` (moved to `logs-preload.ts`)
- Remove `openLogsFolder` (moved to `logs-preload.ts`)
- Remove `clearLogs` (not needed in the main window anymore, but could keep for convenience — keep it)
- Add `openLogsWindow: () => ipcRenderer.invoke('logs:openWindow')`

The remaining log-related methods (`getLogs`, `clearLogs`, `logFromRenderer`) can stay since they're still used by the main window for the "Clear Log Buffer" button and renderer error forwarding.

---

### Step 9 — Update types.ts for the main window's electronAPI

**File: `src/types.ts` (modify)**

- Remove `onLogEntry` from the `Window['electronAPI']` interface
- Add `openLogsWindow: () => Promise<void>`
- Keep `LogEntry`, `LogLevel`, `getLogs`, `clearLogs`, `openLogsFolder`, `logFromRenderer` (they're still used from the main window)

---

### Step 10 — Update SettingsView.tsx: button wiring

**File: `src/SettingsView.tsx` (modify)**

- Change "View Logs" button from `onClick={onOpenLogs}` to `onClick={() => window.electronAPI.openLogsWindow()}`
- Remove `onOpenLogs`, `onClearLogs`, `onOpenLogsFolder` from `SettingsViewProps`
- Remove the `onClearLogs` and `onOpenLogsFolder` buttons from the Diagnostics section (they stay in the logs window itself)
- Update destructuring in the component signature

The Diagnostics section now looks like:

```tsx
<div className="settings-section">
  <h2>Diagnostics</h2>
  <div className="settings-row">
    <button onClick={() => window.electronAPI.openLogsWindow()}>View Logs</button>
  </div>
</div>
```

---

### Step 11 — Update App.tsx: remove modal wiring

**File: `src/App.tsx` (modify)**

- Remove `import LogsModal from './LogsModal'`
- Remove `const [logsOpen, setLogsOpen] = useState(false)`
- Remove `handleOpenLogs`, `handleCloseLogs`, `handleClearLogs`, `handleOpenLogsFolder` callbacks
- Remove `<LogsModal open={logsOpen} onClose={handleCloseLogs} />` from the JSX
- Remove `onOpenLogs`, `onClearLogs`, `onOpenLogsFolder` from the `<SettingsView>` props

---

### Step 12 — Remove obsolete CSS from index.css

**File: `src/index.css` (modify)**

Delete all the log-viewer-specific CSS that was added in the previous PR:
- All `.logs-modal-*` classes
- All `.log-line`, `.log-*` classes
- All `.log-filter-*` classes
- All `.log-level-*` classes
- All `.logs-modal-btn`, `.logs-modal-close` classes
- The `.settings-row` class (still used by the single "View Logs" button — **keep** it)

---

### Step 13 — Delete LogsModal.tsx

**File: `src/LogsModal.tsx` (delete)**

The component is no longer referenced anywhere.

---

## Testing

### Manual
1. `npm start` — app boots normally with no errors or warnings.
2. Open Settings → "View Logs" — a new native window opens showing the log viewer with the same level filters, autoscroll, and Clear/Open Folder buttons.
3. The logs window is independent: moving the main window doesn't affect it.
4. While the logs window is open, watch new log entries stream in (play a channel, refresh a playlist, etc.).
5. Click "View Logs" again while the window is already open — the existing window gets focused (no duplicate).
6. Close the logs window, click "View Logs" again — a fresh window opens.
7. Click "Clear" in the logs window — buffer empties, file on disk unchanged.
8. Click "Open Folder" — OS file manager opens the logs directory.
9. Use level filter chips — only matching entries are shown.
10. Close the app (main window) — the logs window also closes (Electron default behavior for `quit`).
11. `npm run lint` — zero new errors or warnings.
12. `npm run make` — published build still works correctly (logs window opens in packaged app).

### Edge cases
- Rapid double-click on "View Logs" — only one window is created (the guard `if (logsWindow && !logsWindow.isDestroyed())` prevents duplicates).
- Logs window dev URL in dev vs production — verify the loadURL/loadFile path resolves correctly in both modes. In dev, the Vite plugin serves each renderer at a sub-path of the dev server; test the exact URL the plugin generates.
- The logs window's `preload` path: `path.join(__dirname, 'logs-preload.js')` — verify `__dirname` resolves to `.vite/build/` where the preload is output.

---

## Risks

1. **Vite multi-HTML output** — Both renderer builds process ALL `.html` files at the project root. This means the main_window build output will also contain `logs-index.html` and its js bundle, slightly increasing the main app's package size. This is harmless but worth noting. **Mitigation:** If bundle size becomes a concern, each renderer can be given a separate `root` directory with its own `index.html`, but that requires more Vite config changes. For now the overhead is negligible.
2. **Preload path resolution in production** — `__dirname` in the main process after packaging may differ from the dev build. The preload file must be unpacked (not inside ASAR) or the path must resolve correctly. Currently `preload.js` works via `path.join(__dirname, 'preload.js')`, so `path.join(__dirname, 'logs-preload.js')` should work identically. Verify in testing.
3. **Window lifecycle** — If the main window is closed but the logs window stays open, the app shouldn't quit prematurely. Electron's `window-all-closed` event only fires when ALL windows are closed, so this is safe. The existing `app.on('window-all-closed', ...)` handler calls `app.quit()` only on non-macOS, which is correct.
4. **CSS duplication** — The logs window CSS (`logs-index.css`) duplicates the CSS variable definitions from `index.css`. If the theme system is extended (e.g., light/dark toggle), the logs window won't be in sync. **Mitigation:** This is acceptable for now since the theme toggle only affects the main window. A future improvement could extract theme variables into a shared file.
5. **Log entry subscription in the logs window** — The live tail works via the main process broadcasting to all windows. If the logs window isn't open, entries are still sent to the (non-existent) window, which is harmless since we check `isDestroyed()`.
