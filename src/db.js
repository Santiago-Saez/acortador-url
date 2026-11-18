import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS links (
  code TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NULL,
  password_hash TEXT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'unknown',
  referrer TEXT NOT NULL DEFAULT 'direct',
  FOREIGN KEY (code) REFERENCES links(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(code);
CREATE INDEX IF NOT EXISTS idx_clicks_code_day ON clicks(code, day);
CREATE INDEX IF NOT EXISTS idx_clicks_code_country ON clicks(code, country);
CREATE INDEX IF NOT EXISTS idx_clicks_code_referrer ON clicks(code, referrer);
`);

export function insertClicksBatch(rows) {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO clicks (code, ts, day, country, referrer) VALUES (?, ?, ?, ?, ?)"
  );
  // Una sola transacción para el lote completo.
  db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(r.code, r.ts, r.day, r.country, r.referrer);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* noop */ }
    throw err;
  }
}
