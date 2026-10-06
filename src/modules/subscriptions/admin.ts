import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Config } from '../../config.js'
import type { SubscriptionService } from './service.js'

export function adminRoutes(service: SubscriptionService, config: Config) {
  const routes = new Hono()
  routes.use('*', async (c, next) => {
    const supplied = Buffer.from(c.req.header('x-admin-secret') || '')
    const expected = Buffer.from(config.adminSecret)
    if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ error: 'No autorizado.' }, 401)
    }
    await next()
  })
  routes.get('/subscriptions/:userId', (c) => {
    const id = c.req.param('userId')
    if (!service.db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return c.json({ error: 'Usuario no encontrado.' }, 404)
    return c.json({ user: service.publicUser(id) })
  })
  for (const action of ['grant', 'revoke'] as const) {
    routes.post(`/${action}`, async (c) => {
      const body = await c.req.json().catch(() => null)
      const id = typeof body?.userId === 'string' ? body.userId : ''
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (!id && !email) return c.json({ error: 'Indica userId o email.' }, 400)
      const row = (id ? service.db.prepare('SELECT id FROM users WHERE id = ?').get(id)
        : service.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) as { id: string } | undefined
      if (!row) return c.json({ error: 'Usuario no encontrado.' }, 404)
      const user = action === 'grant' ? service.grant(row.id, 'manual') : service.revoke(row.id)
      if (!user) return c.json({ error: 'Gestiona esta suscripción desde Polar para mantener los cobros sincronizados.' }, 409)
      return c.json({ user })
    })
  }
  return routes
}
