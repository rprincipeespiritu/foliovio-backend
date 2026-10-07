import { randomUUID } from 'node:crypto'
import { hash, compare } from 'bcryptjs'
import { Hono } from 'hono'
import type { Database } from '../../db.js'
import type { Config } from '../../config.js'
import type { UserRow } from '../../db.js'
import type { AppEnv } from '../../types.js'
import type { SubscriptionService } from '../subscriptions/service.js'
import { clearSession, setSession } from './session.js'

export function authRoutes(db: Database, config: Config, subscriptions: SubscriptionService) {
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
    const result = await db.query(`INSERT INTO users (id, email, password_hash, name, created_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT(email) DO NOTHING`, [id, email, passwordHash, name, Date.now()])
    if (!result.rowCount) return c.json({ error: 'Ese email ya tiene cuenta.' }, 409)
    await setSession(c, id, config)
    return c.json({ user: await subscriptions.publicUser(id) })
  })
  routes.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [email])
    if (!user || !(await compare(password, user.password_hash))) {
      return c.json({ error: 'Email o contraseña incorrectos.' }, 401)
    }
    await setSession(c, user.id, config)
    return c.json({ user: await subscriptions.publicUser(user.id) })
  })
  routes.post('/logout', (c) => {
    clearSession(c, config)
    return c.json({ ok: true })
  })
  routes.get('/me', async (c) => {
    const user = c.get('user')
    return c.json({ user: user ? await subscriptions.publicUser(user.id) : null })
  })
  return routes
}
