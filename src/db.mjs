import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError } from './security.mjs';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const secretPath = join(dataDir, 'hmac.key');
  try { writeFileSync(secretPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  chmodSync(secretPath, 0o600);
  const secret = readFileSync(secretPath);
  if (secret.length !== 32) throw new Error('Invalid HMAC key file');
  const dbPath = join(dataDir, 'gateway.sqlite');
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS owners (id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
      created INTEGER NOT NULL, revoked INTEGER
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, phone TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES api_keys(id), device_id TEXT NOT NULL,
      phone TEXT NOT NULL, idempotency TEXT NOT NULL, code_mac TEXT,
      state TEXT NOT NULL DEFAULT 'active', delivery TEXT NOT NULL DEFAULT 'sending',
      message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, expires INTEGER NOT NULL,
      UNIQUE(key_id, idempotency)
    );
    CREATE INDEX IF NOT EXISTS challenges_phone_created ON challenges(phone, created);
    CREATE INDEX IF NOT EXISTS challenges_message ON challenges(message_id);
    CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  // A crash may have happened after sending but before recording the ACK. Never retry it.
  db.prepare("UPDATE challenges SET delivery='delivery_unknown' WHERE delivery='sending'").run();
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const limit = (bucket, max, period, now = Date.now()) => {
    const row = get('SELECT * FROM limits WHERE bucket=?', bucket);
    if (row && row.expires > now && row.count >= max) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try later.', Math.ceil((row.expires - now) / 1000));
    if (!row || row.expires <= now) run('INSERT OR REPLACE INTO limits(bucket,count,expires) VALUES(?,1,?)', bucket, now + period);
    else run('UPDATE limits SET count=count+1 WHERE bucket=?', bucket);
  };
  const cleanup = (now = Date.now()) => {
    run('DELETE FROM sessions WHERE expires <= ?', now);
    run('DELETE FROM limits WHERE expires <= ?', now);
    // Remove verifier material promptly; metadata (including recipient) retained for at most 24h.
    run("UPDATE challenges SET code_mac=NULL, state='expired' WHERE state='active' AND expires<=?", now);
    run('DELETE FROM challenges WHERE created < ?', now - 86400_000);
  };
  return { db, secret, get, all, run, transaction, limit, cleanup, close: () => db.close() };
}
