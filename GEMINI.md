# GEMINI.md - IPTV Player Project

This document provides instructional context for AI agents and developers working on this project.

## Project Overview
This is an **Electron**-based IPTV player application that allows users to import and manage M3U/M3U8 playlists. It is built with **TypeScript**, **Vite**, and **Electron Forge**, using **SQLite** (`node:sqlite`) for local persistence and **mpv** for external stream playback.

### Main Technologies
- **Electron**: Desktop application framework.
- **Vite**: Build tool and dev server.
- **TypeScript**: Typed JavaScript for all processes.
- **SQLite (`node:sqlite`)**: Local database for channel and category management.
- **mpv**: External player spawned via `node:child_process` for streaming.
- **Electron Forge**: Packaging and distribution tool.

### Architecture
- **Main Process (`src/main.ts`)**:
  - Handles system-level operations (file dialogs, spawning `mpv`).
  - Manages the SQLite database (`channels.db` in user data directory).
  - Parses M3U playlists into structured channel data.
  - Implements IPC handlers for the renderer.
- **Renderer Process (`src/renderer.ts`)**:
  - Implements the UI logic using vanilla DOM APIs.
  - Uses a **virtualized grid** for efficient rendering of large channel lists (thousands of items).
  - Manages view states (Channels, Categories, Favourites).
  - Handles client-side search and filtering.
- **Preload Script (`src/preload.ts`)**:
  - Exposes a secure IPC bridge via `contextBridge.exposeInMainWorld`.

## Building and Running

### Key Commands
- **`npm start`**: Launch the application in development mode with hot-reloading.
- **`npm run lint`**: Run ESLint to check for code quality and style issues.
- **`npm run package`**: Package the application for the current platform.
- **`npm run make`**: Create platform-specific installers (DEB, RPM, EXE, ZIP).

### Prerequisites
- **Node.js**: Requires a version compatible with the project's `node:sqlite` usage.
- **mpv**: Must be installed on the system path for playback to work.

## Development Conventions

### Coding Style
- **IPC Safety**: Always use the `contextBridge` in `src/preload.ts`. Do not enable `nodeIntegration` in the renderer.
- **Performance**: The project uses a **hard limit of 200 rendered items** in `src/renderer.ts` to ensure UI responsiveness. When modifying the grid or card styles, ensure this limit is maintained for optimal performance.
- **Styling**: Prefer vanilla CSS in `src/index.css`. The layout uses CSS Grid for the channel displays.

### Database Schema
- **`channels` table**: Stores `id`, `name`, `logo`, `group_title`, and `stream_url`.
- **`favourites` table**: Stores `stream_url` for channels marked as favourites.

### File Structure
- `src/main.ts`: Entry point for the Electron main process.
- `src/renderer.ts`: Entry point for the frontend UI.
- `src/preload.ts`: IPC bridge between main and renderer.
- `forge.config.ts`: Configuration for Electron Forge and Vite integration.
- `index.html`: Main HTML template for the renderer process.
