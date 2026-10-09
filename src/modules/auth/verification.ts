import { createHash, randomBytes } from 'node:crypto'
import type { Database, UserRow } from '../../db.js'
import type { VerificationMailer } from './mail.js'

const HOUR = 60 * 60 * 1000
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

interface VerificationRow {
  last_attempt_at: number
  window_started_at: number
  attempts: number
}

export class EmailVerification {
  constructor(private db: Database, private appOrigin: string, private mailer: VerificationMailer) {}

  async send(email: string) {
    // Reserve the attempt first so provider failures also count against the limit.
    const userId = await this.db.transaction(async (sql) => {
      const user = await sql.one<UserRow>('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email])
      if (!user || user.email_verified_at !== null) return null
      const now = Date.now()
      const previous = await sql.one<VerificationRow>('SELECT * FROM email_verifications WHERE user_id = $1', [user.id])
      if (previous && now - previous.last_attempt_at < 60000) return null
      const sameWindow = previous && now - previous.window_started_at < HOUR
      if (sameWindow && previous.attempts >= 5) return null
      await sql.query(`INSERT INTO email_verifications (user_id, last_attempt_at, window_started_at, attempts)
        VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET
        last_attempt_at = EXCLUDED.last_attempt_at, window_started_at = EXCLUDED.window_started_at, attempts = EXCLUDED.attempts`,
      [user.id, now, sameWindow ? previous.window_started_at : now, sameWindow ? previous.attempts + 1 : 1])
      return user.id
    })
    if (!userId) return

    await this.db.transaction(async (sql) => {
      // Serialize sending and activation; preserve the last valid link if delivery fails.
      const user = await sql.one<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])
      if (!user || user.email_verified_at !== null) return
      const token = randomBytes(32).toString('hex')
      const link = new URL('/', this.appOrigin)
      link.hash = `verify-email=${token}`
      await this.mailer({ email: user.email, url: link.href })
      await sql.query('UPDATE email_verifications SET token_hash = $1, expires_at = $2 WHERE user_id = $3',
        [hashToken(token), Date.now() + 24 * HOUR, userId])
    })
  }

  async verify(token: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(token)) return false
    const digest = hashToken(token)
    const found = await this.db.one<{ user_id: string }>('SELECT user_id FROM email_verifications WHERE token_hash = $1', [digest])
    if (!found) return false
    return this.db.transaction(async (sql) => {
      const user = await sql.one<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [found.user_id])
      if (!user || user.email_verified_at !== null) return false
      const now = Date.now()
      const consumed = await sql.query('DELETE FROM email_verifications WHERE user_id = $1 AND token_hash = $2 AND expires_at > $3 RETURNING user_id', [user.id, digest, now])
      if (!consumed.rowCount) return false
      await sql.query('UPDATE users SET email_verified_at = $1 WHERE id = $2', [now, user.id])
      return true
    })
  }
}
