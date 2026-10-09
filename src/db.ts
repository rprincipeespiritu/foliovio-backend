import { Pool, types, type PoolClient, type QueryResultRow } from 'pg'

// API dates remain epoch milliseconds (numbers), including PostgreSQL BIGINTs.
types.setTypeParser(20, (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('BIGINT fuera del rango seguro de JavaScript.')
  return number
})

export interface UserRow {
  id: string
  email: string
  password_hash: string
  name: string
  created_at: number
  export_count: number
  email_verified_at: number | null
}

export class SqlSession {
  constructor(private readonly connection: Pool | PoolClient) {}

  query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    return this.connection.query<T>(sql, values)
  }

  async one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, values)).rows[0]
  }
}

export class Database extends SqlSession {
  constructor(private readonly pool: Pool) { super(pool) }

  async transaction<T>(run: (sql: SqlSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(new SqlSession(client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  close() { return this.pool.end() }
}

export async function migrate(db: Database) {
  await db.transaction(async (sql) => {
    // Serializes schema changes when several API instances start together.
    await sql.query('SELECT pg_advisory_xact_lock(1718578281, 1)')
    await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
    if (!(await sql.one('SELECT version FROM schema_migrations WHERE version = 1'))) {
      await sql.query(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        export_count INTEGER NOT NULL DEFAULT 0 CHECK (export_count >= 0)
      );
      CREATE TABLE subscriptions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('active', 'canceled', 'past_due', 'revoked', 'inactive')),
        provider TEXT NOT NULL CHECK(provider IN ('manual', 'local', 'legacy', 'polar')),
        current_period_end BIGINT NOT NULL,
        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        provider_subscription_id TEXT UNIQUE,
        provider_updated_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE webhook_events (id TEXT PRIMARY KEY, processed_at BIGINT NOT NULL);
      INSERT INTO schema_migrations (version) VALUES (1);
      `)
    }
    if (!(await sql.one('SELECT version FROM schema_migrations WHERE version = 2'))) {
      await sql.query(`
        ALTER TABLE users ADD COLUMN email_verified_at BIGINT;
        -- Preserve access for accounts created before email activation was introduced.
        UPDATE users SET email_verified_at = created_at;
        CREATE TABLE email_verifications (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT UNIQUE,
          expires_at BIGINT NOT NULL DEFAULT 0,
          last_attempt_at BIGINT NOT NULL,
          window_started_at BIGINT NOT NULL,
          attempts INTEGER NOT NULL
        );
        INSERT INTO schema_migrations (version) VALUES (2);
      `)
    }
    if (!(await sql.one('SELECT version FROM schema_migrations WHERE version = 3'))) {
      await sql.query(`
        ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_provider_check;
        ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_provider_check
          CHECK(provider IN ('manual', 'local', 'legacy', 'polar', 'paddle'));
        ALTER TABLE subscriptions ADD COLUMN provider_environment TEXT;
        CREATE TABLE paddle_customers (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          environment TEXT NOT NULL CHECK(environment IN ('sandbox', 'production')),
          customer_id TEXT NOT NULL,
          checkout_transaction_id TEXT,
          PRIMARY KEY(user_id, environment), UNIQUE(customer_id, environment)
        );
        INSERT INTO schema_migrations (version) VALUES (3);
      `)
    }
  })
}

export async function openDatabase(connectionString: string, options: { schema?: string; max?: number } = {}) {
  if (options.schema && !/^[a-z_][a-z0-9_]*$/.test(options.schema)) throw new Error('Schema inválido.')
  const pool = new Pool({
    connectionString, max: options.max ?? 10,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    options: options.schema ? `-c search_path=${options.schema}` : undefined,
  })
  pool.on('error', (error) => console.error('Conexión PostgreSQL inactiva:', error.message))
  const db = new Database(pool)
  try {
    await migrate(db)
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}
