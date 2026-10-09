import { Hono } from 'hono'
import type { Config } from '../../config.js'
import type { AppEnv } from '../../types.js'
import type { SubscriptionService } from './service.js'

export function subscriptionRoutes(service: SubscriptionService, config: Config) {
  const routes = new Hono<AppEnv>()
  routes.use('*', async (c, next) => {
    if (!c.get('user')) return c.json({ error: 'Inicia sesión para gestionar tu suscripción.' }, 401)
    await next()
  })
  routes.get('/subscription', async (c) => c.json({ subscription: await service.get(c.get('user')!.id) }))
  routes.post('/export', async (c) => {
    const result = await service.consumeExport(c.get('user')!.id)
    if (!result.allowed) return c.json({ ...result, error: 'Necesitas Foliovio Pro para más descargas.' }, 402)
    return c.json(result)
  })
  routes.post('/activate', async (c) => {
    if (config.isProd) return c.json({ error: 'Pro se activa cuando se confirma el pago.' }, 403)
    const user = await service.grant(c.get('user')!.id, 'local')
    if (!user) return c.json({ error: 'Esta suscripción se gestiona desde su proveedor de pagos.' }, 409)
    return c.json({ user })
  })
  return routes
}
