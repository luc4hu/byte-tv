# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

byte-tv is an Electron desktop app for browsing and playing IPTV channels from M3U playlists. Channels are stored in SQLite, searched in-memory, and played via mpv.

## Commands

```bash
npm start          # Run dev (sets ELECTRON_DISABLE_SANDBOX=1, opens DevTools)
npm run lint       # ESLint on .ts/.tsx files
npm run make       # Build platform installers (DEB, RPM, Squirrel, ZIP)
npm run package    # Package without creating installers
```

No test framework is configured.

## Architecture

Three-process Electron app built with Electron Forge + Vite:

- **Main process** (`src/main.ts`) — SQLite database (node:sqlite `DatabaseSync`), M3U parser, IPC handlers, spawns mpv for playback
- **Preload** (`src/preload.ts`) — Context bridge exposing `window.electronAPI` with typed IPC methods
- **Renderer** — React 18 UI with two view components:
  - `src/renderer.tsx` — Entry point, mounts `<App />`
  - `src/App.tsx` — Root component with lifted state, toolbar, view routing
  - `src/MainView.tsx` — Channel/category/favourites grid, search filtering via `useMemo`, drill-down
  - `src/SettingsView.tsx` — Playlists CRUD, MPV flags, theme toggle, cache management
  - `src/types.ts` — Shared interfaces (`Channel`, `Category`, `Playlist`) and `window.electronAPI` type declarations

Styling in `src/index.css` uses CSS custom properties for light/dark theming (toggled via `data-theme` attribute on `<html>`).

## Key Patterns

- **IPC protocol**: Handlers registered in `registerIPC()` in main.ts, invoked through preload bridge methods. Channel names follow `domain:action` convention (e.g., `channels:getAll`, `favourites:toggle`).
- **Database**: Two tables — `channels` (id, name, logo, group_title, stream_url) and `favourites` (stream_url PK). DB file lives in Electron's `userData` directory.
- **Search**: Client-side multi-token AND matching against pre-built lowercase name arrays. Render capped at 200 items.
- **Favourites**: Right-click context menu toggles. Stored as stream_url set in both SQLite and renderer memory.
- **M3U parsing**: Extracts `tvg-logo`, `group-title` attributes and channel name from `#EXTINF:` lines.

## Build Configuration

- Electron Forge with Vite plugin (three configs: main, preload, renderer — renderer uses `@vitejs/plugin-react`)
- TypeScript targeting ESNext with CommonJS modules
- Electron Fuses enabled for security hardening (ASAR integrity, cookie encryption, RunAsNode disabled)
- Vite dev server URL injected as `MAIN_WINDOW_VITE_DEV_SERVER_URL` global
