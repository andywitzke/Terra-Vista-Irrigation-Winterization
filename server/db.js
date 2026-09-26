const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS work_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,              -- YYYY-MM-DD
  capacity INTEGER NOT NULL DEFAULT 25,   -- always am_capacity + pm_capacity
  am_capacity INTEGER NOT NULL DEFAULT 10,
  pm_capacity INTEGER NOT NULL DEFAULT 15,
  is_open INTEGER NOT NULL DEFAULT 1,     -- accepting public sign-ups
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_progress | done
  route_locked INTEGER NOT NULL DEFAULT 0,  -- 1 once the tech starts or reorders
  started_at TEXT,
  ended_at TEXT,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  phone TEXT NOT NULL,                    -- E.164
  notes TEXT NOT NULL DEFAULT '',
  sms_opt_in INTEGER NOT NULL DEFAULT 1,
  lat REAL,
  lng REAL,
  formatted_address TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | completed | unscheduled | cancelled
  assigned_day_id INTEGER REFERENCES work_days(id) ON DELETE SET NULL,
  time_pref TEXT NOT NULL DEFAULT 'ANY',  -- AM | PM | ANY for the assigned day
  route_order INTEGER,
  route_session TEXT,
  completed_at TEXT,
  tech_notes TEXT NOT NULL DEFAULT '',
  notified_second_at TEXT,
  notified_next_at TEXT,
  notified_complete_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signups_day ON signups(assigned_day_id, status);
CREATE INDEX IF NOT EXISTS idx_signups_phone ON signups(phone);

-- Every day a neighbor said works for them, with their AM/PM/ANY preference for that day.
CREATE TABLE IF NOT EXISTS signup_prefs (
  signup_id INTEGER NOT NULL REFERENCES signups(id) ON DELETE CASCADE,
  day_id INTEGER NOT NULL REFERENCES work_days(id) ON DELETE CASCADE,
  time_pref TEXT NOT NULL DEFAULT 'ANY',
  PRIMARY KEY (signup_id, day_id)
);

CREATE TABLE IF NOT EXISTS tech_location (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signup_id INTEGER,
  to_phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,                   -- sent | failed | simulated
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- migrations for databases created by earlier versions
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('work_days', 'am_capacity')) {
  // Split each existing day's total into a morning and afternoon limit (10 AM, rest PM).
  db.exec(`
    ALTER TABLE work_days ADD COLUMN am_capacity INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE work_days ADD COLUMN pm_capacity INTEGER NOT NULL DEFAULT 15;
    UPDATE work_days SET am_capacity = MIN(10, capacity), pm_capacity = MAX(0, capacity - MIN(10, capacity));
  `);
}
if (!hasColumn('signups', 'route_session')) {
  // Which half of the day the route planner put this stop in: AM | PM
  db.exec('ALTER TABLE signups ADD COLUMN route_session TEXT');
}

let txDepth = 0;
/** Run fn inside a transaction (nested calls join the outer transaction). */
function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

const all = (sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const get = (sql, ...params) => {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : undefined;
};
const run = (sql, ...params) => db.prepare(sql).run(...params);

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value)
  );
}

module.exports = { db, tx, all, get, run, getSetting, setSetting };
