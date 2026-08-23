import type { DatabaseSync } from 'node:sqlite';
import { logInfo } from './logger';

// Schema is defined as an ordered list of migrations. Index `i` upgrades the
// database from user_version `i` to `i + 1`. The DB's PRAGMA user_version tracks
// how many have been applied.
//
// Rules: append new migrations only. Never edit, reorder, or delete a migration
// that has already shipped — that would desync installed databases.
const migrations: Array<(db: DatabaseSync) => void> = [
  // --- v1: consolidated baseline — the full canonical schema, CREATE TABLE only ---
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT,
      type TEXT NOT NULL DEFAULT 'm3u',
      xtream_username TEXT,
      xtream_password TEXT,
      exp_date TEXT,
      last_refreshed TEXT,
      added_date TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      logo TEXT,
      group_title TEXT,
      stream_url TEXT NOT NULL,
      playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS favourites (
      stream_url TEXT PRIMARY KEY NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS history (
      stream_url TEXT PRIMARY KEY NOT NULL,
      last_played INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL DEFAULT ''
    )`);
  },
  // --- v2: favourite categories, keyed by their displayed group name ---
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS favourite_categories (
      category_name TEXT PRIMARY KEY NOT NULL
    )`);
  },
  // --- future migrations append here as v3, v4, ... ---
];

// Applies every migration the database hasn't seen yet, each in its own
// transaction so a failure rolls back cleanly and user_version never advances
// past a partially-applied migration.
export function runMigrations(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const latest = migrations.length;

  logInfo(`[migrations] schema at user_version ${current}, latest ${latest}`);

  if (current >= latest) {
    logInfo('[migrations] schema up to date, nothing to run');
    return;
  }

  for (let i = current; i < latest; i++) {
    const target = i + 1;
    const t0 = Date.now();
    logInfo(`[migrations] applying migration ${target}/${latest}`);
    db.exec('BEGIN');
    try {
      migrations[i](db);
      // user_version can't be parameterized; `target` is a trusted integer.
      db.exec(`PRAGMA user_version = ${target}`);
      db.exec('COMMIT');
      logInfo(`[migrations] migration ${target} done in ${Date.now() - t0}ms`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  logInfo(`[migrations] schema now at user_version ${latest}`);
}
