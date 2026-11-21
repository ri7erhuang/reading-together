import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
fs.mkdirSync(EXPORT_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS books (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  author      TEXT,
  source_type TEXT,
  file_name   TEXT,
  tag         TEXT,
  meta        TEXT,
  order_idx   INTEGER DEFAULT 0,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS chapters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  title      TEXT,
  para_start INTEGER NOT NULL,
  para_count INTEGER NOT NULL,
  legacy_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

CREATE TABLE IF NOT EXISTS paragraphs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     TEXT NOT NULL,
  para_idx    INTEGER NOT NULL,
  chapter_idx INTEGER NOT NULL,
  text        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  kind        TEXT DEFAULT 'para'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paragraphs_book_para ON paragraphs(book_id, para_idx);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL,
  para_idx   INTEGER NOT NULL,
  para_hash  TEXT,
  quote      TEXT DEFAULT '',
  offset     INTEGER,
  qlen       INTEGER,
  author     TEXT NOT NULL,
  type       TEXT NOT NULL,
  text       TEXT NOT NULL,
  answer     TEXT,
  source     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id, para_idx);

CREATE TABLE IF NOT EXISTS replies (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_note ON replies(note_id);

CREATE TABLE IF NOT EXISTS progress (
  user_id    TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  para_idx   INTEGER NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dict_cache (
  word       TEXT PRIMARY KEY,
  pinyin     TEXT,
  def        TEXT,
  source     TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  purpose    TEXT,
  model      TEXT,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  created_at TEXT
);
`);

export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

export function getSetting(key, fallback = null) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

let txDepth = 0;

/** 支持嵌套调用（内层直接复用外层事务）；只接受同步回调 */
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      // 异步回调会在 await 之前就被 COMMIT，导致「事务」形同虚设
      throw new Error('tx() 不支持异步回调');
    }
    db.exec('COMMIT');
    txDepth--;
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    txDepth--;
    throw e;
  }
}
