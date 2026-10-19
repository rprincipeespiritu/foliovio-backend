import { randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Database, UserRow } from '../../db.js'
import type { Config } from '../../config.js'
import type { AppEnv } from '../../types.js'

const COOKIE = 'foliovio_session'
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_SESSION_MS = 30 * 24 * 60 * 60 * 1000

async function claims(c: Context<AppEnv>, config: Config) {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), { algorithms: ['HS256'] })
    return typeof payload.sub === 'string' && typeof payload.jti === 'string' ? payload : null
  } catch { return null }
}

export async function createSession(db: Database, userId: string, config: Config) {
  const now = Date.now()
  const id = randomUUID()
  const token = await new SignJWT({ sub: userId }).setJti(id)
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(Math.floor((now + MAX_SESSION_MS) / 1000))
    .sign(new TextEncoder().encode(config.jwtSecret))
  await db.query('DELETE FROM auth_sessions WHERE user_id = $1 AND (last_activity_at <= $2 OR expires_at <= $3)', [userId, now - IDLE_TIMEOUT_MS, now])
  await db.query('INSERT INTO auth_sessions (id, user_id, last_activity_at, expires_at) VALUES ($1, $2, $3, $4)', [id, userId, now, now + MAX_SESSION_MS])
  return { token, session: { id, expiresAt: now + IDLE_TIMEOUT_MS } }
}

export function sessionInfo(c: Context<AppEnv>) {
  const session = c.get('session')
  return session ? { id: session.id, remainingMs: Math.max(0, session.expiresAt - Date.now()) } : null
}

export async function setSession(c: Context<AppEnv>, userId: string, db: Database, config: Config) {
  const previous = await claims(c, config)
  if (previous) await db.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [previous.jti, previous.sub])
  const { token, session } = await createSession(db, userId, config)
  c.set('session', session)
  setCookie(c, COOKIE, token, {
    httpOnly: true, sameSite: config.cookieSameSite, secure: config.isProd,
    path: '/', maxAge: MAX_SESSION_MS / 1000,
  })
}

export async function clearSession(c: Context<AppEnv>, db: Database, config: Config, expectedId?: string) {
  const payload = await claims(c, config)
  // An old tab must not log out a different session created in another tab.
  if (expectedId && payload?.jti !== expectedId) return
  if (payload) await db.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [payload.jti, payload.sub])
  deleteCookie(c, COOKIE, { path: '/', secure: config.isProd, sameSite: config.cookieSameSite })
}

export async function loadUser(c: Context<AppEnv>, db: Database, config: Config): Promise<UserRow | null> {
  const payload = await claims(c, config)
  if (!payload) return null
  const now = Date.now()
  const row = await db.one<UserRow & { session_id: string; session_expires: number }>(`
    SELECT u.*, s.id AS session_id, LEAST(s.last_activity_at + $3, s.expires_at) AS session_expires
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = $1 AND s.user_id = $2 AND s.last_activity_at > $4 AND s.expires_at > $5
      AND u.email_verified_at IS NOT NULL`, [payload.jti, payload.sub, IDLE_TIMEOUT_MS, now - IDLE_TIMEOUT_MS, now])
  if (!row) return null
  c.set('session', { id: row.session_id, expiresAt: row.session_expires })
  return row
}
