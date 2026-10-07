import { SignJWT, jwtVerify } from 'jose'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Database } from '../../db.js'
import type { Config } from '../../config.js'
import type { UserRow } from '../../db.js'

const COOKIE = 'foliovio_session'

export async function setSession(c: Context, userId: string, config: Config) {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30d')
    .sign(new TextEncoder().encode(config.jwtSecret))
  setCookie(c, COOKIE, token, {
    httpOnly: true, sameSite: config.cookieSameSite, secure: config.isProd,
    path: '/', maxAge: 60 * 60 * 24 * 30,
  })
}

export function clearSession(c: Context, config: Config) {
  deleteCookie(c, COOKIE, { path: '/', secure: config.isProd, sameSite: config.cookieSameSite })
}

export async function loadUser(c: Context, db: Database, config: Config): Promise<UserRow | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  let userId: string
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string') return null
    userId = payload.sub
  } catch {
    return null
  }
  return await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]) ?? null
}
