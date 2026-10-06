import { randomUUID } from 'node:crypto'
import { hash, compare } from 'bcryptjs'
import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import type { Config } from '../../config.js'
import type { UserRow } from '../../db.js'
import type { AppEnv } from '../../types.js'
import type { SubscriptionService } from '../subscriptions/service.js'
import { clearSession, setSession } from './session.js'

export function authRoutes(db: Database.Database, config: Config, subscriptions: SubscriptionService) {
  const routes = new Hono<AppEnv>()
  routes.post('/register', async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Escribe un email válido.' }, 400)
    if (password.length < 8 || Buffer.byteLength(password) > 72) {
      return c.json({ error: 'La contraseña debe tener al menos 8 caracteres y como máximo 72 bytes.' }, 400)
    }
    const passwordHash = await hash(password, 12)
    const id = randomUUID()
    const result = db.prepare(`INSERT INTO users (id, email, password_hash, name, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`).run(id, email, passwordHash, name, Date.now())
    if (!result.changes) return c.json({ error: 'Ese email ya tiene cuenta.' }, 409)
    await setSession(c, id, config)
    return c.json({ user: subscriptions.publicUser(id) })
  })
  routes.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined
    if (!user || !(await compare(password, user.password_hash))) {
      return c.json({ error: 'Email o contraseña incorrectos.' }, 401)
    }
    await setSession(c, user.id, config)
    return c.json({ user: subscriptions.publicUser(user.id) })
  })
  routes.post('/logout', (c) => {
    clearSession(c, config)
    return c.json({ ok: true })
  })
  routes.get('/me', (c) => {
    const user = c.get('user')
    return c.json({ user: user ? subscriptions.publicUser(user.id) : null })
  })
  return routes
}
