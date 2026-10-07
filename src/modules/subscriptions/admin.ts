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
  routes.get('/subscriptions/:userId', async (c) => {
    const id = c.req.param('userId')
    if (!await service.db.one('SELECT id FROM users WHERE id = $1', [id])) return c.json({ error: 'Usuario no encontrado.' }, 404)
    return c.json({ user: await service.publicUser(id) })
  })
  for (const action of ['grant', 'revoke'] as const) {
    routes.post(`/${action}`, async (c) => {
      const body = await c.req.json().catch(() => null)
      const id = typeof body?.userId === 'string' ? body.userId : ''
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (!id && !email) return c.json({ error: 'Indica userId o email.' }, 400)
      const row = id ? await service.db.one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id])
        : await service.db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])
      if (!row) return c.json({ error: 'Usuario no encontrado.' }, 404)
      const user = action === 'grant' ? await service.grant(row.id, 'manual') : await service.revoke(row.id)
      if (!user) return c.json({ error: 'Gestiona esta suscripción desde Polar para mantener los cobros sincronizados.' }, 409)
      return c.json({ user })
    })
  }
  return routes
}
