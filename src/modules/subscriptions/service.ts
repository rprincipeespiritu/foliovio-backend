import type { Database, SqlSession } from '../../db.js'
import type { AuthUser, Subscription } from '../../contracts/api.js'
import type { UserRow } from '../../db.js'

export interface SubscriptionRow {
  user_id: string
  status: Exclude<Subscription['status'], 'expired'>
  provider: NonNullable<Subscription['provider']>
  current_period_end: number
  cancel_at_period_end: boolean
  provider_subscription_id: string | null
  provider_updated_at: number
  provider_environment: string | null
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export class SubscriptionService {
  constructor(readonly db: Database, readonly paddleEnvironment?: 'sandbox' | 'production') {}

  row(userId: string, sql: SqlSession = this.db) {
    return sql.one<SubscriptionRow>('SELECT * FROM subscriptions WHERE user_id = $1', [userId])
  }

  async get(userId: string, sql: SqlSession = this.db): Promise<Subscription> {
    const row = await this.row(userId, sql)
    if (!row) return { plan: 'free', status: 'inactive', provider: null, currentPeriodEnd: 0, cancelAtPeriodEnd: false }
    const eligible = row.status === 'active' || row.status === 'canceled'
    const wrongEnvironment = row.provider === 'paddle' && this.paddleEnvironment && row.provider_environment !== this.paddleEnvironment
    const active = !wrongEnvironment && eligible && row.current_period_end > Date.now()
    return {
      plan: active ? 'pro' : 'free',
      status: wrongEnvironment ? 'inactive' : eligible && !active ? 'expired' : row.status,
      provider: row.provider,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    }
  }

  async publicUser(userId: string, sql: SqlSession = this.db): Promise<AuthUser> {
    const user = await sql.one<UserRow>('SELECT * FROM users WHERE id = $1', [userId])
    if (!user) throw new Error('Usuario no encontrado.')
    const subscription = await this.get(userId, sql)
    const premium = subscription.plan === 'pro'
    return {
      id: user.id, email: user.email, name: user.name,
      premium, premiumUntil: subscription.currentPeriodEnd,
      exportCount: user.export_count,
      remainingFree: premium ? -1 : Math.max(0, 1 - user.export_count),
      subscription,
    }
  }

  grant(userId: string, provider: 'manual' | 'local') {
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      if (['polar', 'paddle'].includes((await this.row(userId, sql))?.provider || '')) return null
      const current = await this.get(userId, sql)
      const until = (current.plan === 'pro' ? current.currentPeriodEnd : Date.now()) + MONTH_MS
      await sql.query(`INSERT INTO subscriptions (user_id, status, provider, current_period_end, updated_at)
        VALUES ($1, 'active', $2, $3, $4)
        ON CONFLICT(user_id) DO UPDATE SET status = 'active', provider = excluded.provider,
          current_period_end = excluded.current_period_end, cancel_at_period_end = FALSE, updated_at = excluded.updated_at`,
        [userId, provider, until, Date.now()])
      return this.publicUser(userId, sql)
    })
  }

  revoke(userId: string) {
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      if (['polar', 'paddle'].includes((await this.row(userId, sql))?.provider || '')) return null
      await sql.query(`UPDATE subscriptions SET status = 'revoked', current_period_end = $1,
        cancel_at_period_end = FALSE, updated_at = $2 WHERE user_id = $3`, [Date.now(), Date.now(), userId])
      return this.publicUser(userId, sql)
    })
  }

  consumeExport(userId: string) {
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      const user = await this.publicUser(userId, sql)
      if (!user.premium && user.remainingFree === 0) return { allowed: false, user }
      await sql.query('UPDATE users SET export_count = export_count + 1 WHERE id = $1', [userId])
      return { allowed: true, user: await this.publicUser(userId, sql) }
    })
  }
}
