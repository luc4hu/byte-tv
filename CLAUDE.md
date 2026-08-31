# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

byte-tv is an Electron desktop app for browsing and playing IPTV channels from M3U playlists and Xtream Codes servers. Channels are stored in SQLite, searched in-memory, and played via mpv.

## Commands

```bash
npm start          # Run dev (sets ELECTRON_DISABLE_SANDBOX=1)
npm run lint       # ESLint on .ts/.tsx files
npm run typecheck  # tsc --noEmit (strict mode)
npm run make       # Build platform installers (DEB, RPM, Squirrel, ZIP)
npm run package    # Package without creating installers
```

No test framework is configured.

Do NOT launch the app (`npm start`) to smoke-test changes — the user runs it themselves. Verify changes with `npm run typecheck` and `npm run lint` only.

## Architecture

Multi-process Electron app built with Electron Forge + Vite:

- **Main process** (`src/main.ts`) — SQLite database (node:sqlite `DatabaseSync`), M3U parser, Xtream Codes API client, IPC handlers, spawns/controls mpv for playback (JSON IPC over a Unix socket / named pipe)
- **Logger** (`src/logger.ts`) — Ring buffer + rotating file log in `userData/logs`, live-tailed by renderers via `logs:entry` events
- **Preload** (`src/preload.ts`) — Context bridge exposing `window.electronAPI` with typed IPC methods (`src/logs-preload.ts` exposes a smaller API for the logs window)
- **Renderer** — React 19 UI:
  - `src/renderer.tsx` — Entry point, mounts `<App />`
  - `src/App.tsx` — Root component with lifted state, toolbar, view routing
  - `src/MainView.tsx` — Channel/category/history/favourites grid, search filtering via `useMemo`, category drill-down, infinite scroll
  - `src/SettingsView.tsx` — Playlists CRUD (URL + Xtream), mpv flags, superscript-strip toggle, logs window
  - `src/logs-renderer.tsx` — Separate logs viewer window with level filters and live tail
  - `src/types.ts` — Shared interfaces (`Channel`, `Category`, `Playlist`, ...) and the `window.electronAPI` type declaration

Styling in `src/index.css` uses CSS custom properties (dark theme is hardcoded via `data-theme` on `<html>`); Tailwind is imported for its base layer only.

## Key Patterns

- **IPC protocol**: Handlers registered in `registerIPC()` in main.ts, invoked through preload bridge methods. Channel names follow `domain:action` convention (e.g., `channels:getAll`, `favourites:toggle`).
- **Database**: Five tables — `playlists`, `channels` (FK to playlists, ON DELETE CASCADE), `favourites` (stream_url PK), `history` (stream_url PK, last_played), `settings` (key/value). DB file (`channels.db`) lives in Electron's `userData` directory. Schema is defined and versioned via migrations (see below).
- **Search**: Client-side multi-token AND matching against pre-built lowercase name arrays. Rendered in batches of 200 via IntersectionObserver infinite scroll.
- **Favourites**: Right-click pops a native one-entry menu (`favourites:contextMenu` in main.ts) whose label reflects current state; the renderer toggles only if it's chosen. The card star is a read-only indicator. Stored as stream_url set in both SQLite and renderer memory. On Xtream refresh, favourite/history URLs are remapped by stream id (`remapStreamUrlReferences`) so credential changes don't lose them.
- **M3U parsing**: Extracts `tvg-logo`, `group-title` attributes and channel name from `#EXTINF:` lines.
- **Playback**: Reuses a running mpv instance via `loadfile ... replace` over the IPC socket; spawns a new detached mpv otherwise. User-configurable flags come from the `mpv_flags` setting.

## Database Migrations

Schema lives in `src/migrations.ts` as an ordered `migrations` array and is versioned with SQLite's `PRAGMA user_version`. Index `i` in the array upgrades the DB from `user_version` `i` to `i + 1`.

- `runMigrations(db)` — called from `initDB()` in `main.ts` — reads `user_version` and applies every not-yet-run migration in order, each in its own transaction, bumping `user_version` by one. A failed migration rolls back and leaves `user_version` untouched.
- **Migration 1** is the consolidated baseline: `CREATE TABLE IF NOT EXISTS` for the five tables (the full canonical column set). On a database that already has the tables it's a no-op that simply stamps `user_version = 1`.
- **Rules**: append new migrations only — never edit, reorder, or delete one that has shipped, since installed databases are already stamped past it. New schema changes (new tables, `ALTER TABLE`, indexes) go in a new array entry.
- `initDB()` keeps `PRAGMA foreign_keys = ON` outside the migration runner (PRAGMA is a no-op inside a transaction).
- Legacy local databases may carry unused EPG/FTS orphan tables from an abandoned experiment; current code ignores them — the code schema is authoritative.

## Build Configuration

- Electron Forge with Vite plugin (entries: main, two preloads; renderers: main_window, logs_window)
- TypeScript (strict) targeting ESNext with CommonJS modules; no emit — Vite builds, `npm run typecheck` validates
- Electron Fuses enabled for security hardening (ASAR integrity, cookie encryption, RunAsNode disabled)
- Vite dev server URLs injected as `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `LOGS_WINDOW_VITE_DEV_SERVER_URL` globals
