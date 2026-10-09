import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { Database } from './db.js'
import type { Config } from './config.js'
import type { AppEnv } from './types.js'
import { authRoutes } from './modules/auth/routes.js'
import { loadUser } from './modules/auth/session.js'
import { SubscriptionService } from './modules/subscriptions/service.js'
import { subscriptionRoutes } from './modules/subscriptions/routes.js'
import { adminRoutes } from './modules/subscriptions/admin.js'
import { polarRoutes } from './modules/subscriptions/polar.js'
import { sendGridMailer, type VerificationMailer } from './modules/auth/mail.js'
import { PaddleService, paddleBillingRoutes, paddleWebhookRoutes } from './modules/subscriptions/paddle.js'

export function createApp(db: Database, config: Config, mailer: VerificationMailer = sendGridMailer(config), paddleFetch: typeof fetch = fetch) {
  const app = new Hono<AppEnv>()
  const subscriptions = new SubscriptionService(db, config.paddleEnvironment)
  const paddle = new PaddleService(subscriptions, config, paddleFetch)
  const origins = config.isProd ? [config.appOrigin] : [config.appOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173']
  app.use('/api/*', cors({ origin: origins, credentials: true }))
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }))
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !['/api/webhooks/polar', '/api/webhooks/paddle'].includes(c.req.path) &&
        origin && !origins.includes(origin)) {
      return c.json({ error: 'Origen no permitido.' }, 403)
    }
    c.set('user', await loadUser(c, db, config))
    await next()
  })
  app.get('/api/health', async (c) => {
    try {
      await db.query('SELECT 1')
      return c.json({ ok: true })
    } catch {
      return c.json({ ok: false }, 503)
    }
  })
  app.route('/api/auth', authRoutes(db, config, subscriptions, mailer))
  app.route('/api/billing', paddleBillingRoutes(paddle))
  app.route('/api/billing', subscriptionRoutes(subscriptions, config))
  app.route('/api/admin', adminRoutes(subscriptions, config))
  app.route('/api/webhooks', polarRoutes(subscriptions, config))
  app.route('/api/webhooks', paddleWebhookRoutes(paddle))
  app.notFound((c) => c.json({ error: 'No encontrado.' }, 404))
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    console.error(error)
    return c.json({ error: 'No se pudo completar la solicitud.' }, 500)
  })
  return app
}
