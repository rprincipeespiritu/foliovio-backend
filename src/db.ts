import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export interface UserRow {
  id: string
  email: string
  password_hash: string
  name: string
  created_at: number
  export_count: number
}

export function migrate(db: Database.Database) {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      premium_until INTEGER NOT NULL DEFAULT 0,
      export_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
  `)
  db.transaction(() => {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) return
    db.exec(`
      CREATE TABLE subscriptions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('active', 'canceled', 'past_due', 'revoked', 'inactive')),
        provider TEXT NOT NULL CHECK(provider IN ('manual', 'local', 'legacy', 'polar')),
        current_period_end INTEGER NOT NULL,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        provider_subscription_id TEXT UNIQUE,
        provider_updated_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE webhook_events (id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
      INSERT INTO subscriptions (user_id, status, provider, current_period_end, updated_at)
        SELECT id, 'active', 'legacy', premium_until, created_at FROM users WHERE premium_until > 0;
      INSERT INTO schema_migrations (version) VALUES (1);
    `)
  })()
}

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}
