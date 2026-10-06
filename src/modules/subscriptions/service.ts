import type Database from 'better-sqlite3'
import type { AuthUser, Subscription } from '../../contracts/api.js'
import type { UserRow } from '../../db.js'

export interface SubscriptionRow {
  user_id: string
  status: Exclude<Subscription['status'], 'expired'>
  provider: NonNullable<Subscription['provider']>
  current_period_end: number
  cancel_at_period_end: number
  provider_subscription_id: string | null
  provider_updated_at: number
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export class SubscriptionService {
  constructor(readonly db: Database.Database) {}

  row(userId: string) {
    return this.db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) as SubscriptionRow | undefined
  }

  get(userId: string): Subscription {
    const row = this.row(userId)
    if (!row) return { plan: 'free', status: 'inactive', provider: null, currentPeriodEnd: 0, cancelAtPeriodEnd: false }
    const eligible = row.status === 'active' || row.status === 'canceled'
    const active = eligible && row.current_period_end > Date.now()
    return {
      plan: active ? 'pro' : 'free',
      status: eligible && !active ? 'expired' : row.status,
      provider: row.provider,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    }
  }

  publicUser(userId: string): AuthUser {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow
    const subscription = this.get(userId)
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
    return this.db.transaction(() => {
      if (this.row(userId)?.provider === 'polar') return null
      const current = this.get(userId)
      const until = (current.plan === 'pro' ? current.currentPeriodEnd : Date.now()) + MONTH_MS
      this.db.prepare(`INSERT INTO subscriptions (user_id, status, provider, current_period_end, updated_at)
        VALUES (?, 'active', ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET status = 'active', provider = excluded.provider,
          current_period_end = excluded.current_period_end, cancel_at_period_end = 0, updated_at = excluded.updated_at`
      ).run(userId, provider, until, Date.now())
      return this.publicUser(userId)
    })()
  }

  revoke(userId: string) {
    if (this.row(userId)?.provider === 'polar') return null
    this.db.prepare(`UPDATE subscriptions SET status = 'revoked', current_period_end = ?,
      cancel_at_period_end = 0, updated_at = ? WHERE user_id = ?`).run(Date.now(), Date.now(), userId)
    return this.publicUser(userId)
  }

  consumeExport(userId: string) {
    return this.db.transaction(() => {
      const user = this.publicUser(userId)
      if (!user.premium && user.remainingFree === 0) return { allowed: false, user }
      this.db.prepare('UPDATE users SET export_count = export_count + 1 WHERE id = ?').run(userId)
      return { allowed: true, user: this.publicUser(userId) }
    })()
  }
}
