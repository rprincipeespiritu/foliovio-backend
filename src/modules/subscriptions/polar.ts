import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Webhook } from 'standardwebhooks'
import type { Config } from '../../config.js'
import type { SubscriptionRow, SubscriptionService } from './service.js'

const EVENTS = new Set([
  'subscription.created', 'subscription.updated', 'subscription.active', 'subscription.canceled',
  'subscription.uncanceled', 'subscription.revoked', 'subscription.past_due',
  'subscription.cycled', 'subscription.paused', 'subscription.resumed',
])
const STATUSES = new Set(['active', 'trialing', 'canceled', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function date(value: unknown) {
  return typeof value === 'string' ? Date.parse(value) : NaN
}

// Polar supports both Standard Webhooks secrets and its older literal UTF-8 keys.
// https://polar.sh/docs/integrate/webhooks/delivery
export function verifyPolar(body: string, headers: Record<string, string>, secret: string): unknown {
  for (const key of [secret, Buffer.from(secret, 'utf8').toString('base64')]) {
    try {
      return new Webhook(key).verify(body, headers)
    } catch {
      // Try the legacy signing scheme before rejecting the request.
    }
  }
  throw new HTTPException(401, { message: 'Firma de webhook inválida.' })
}

export function polarRoutes(service: SubscriptionService, config: Config) {
  const routes = new Hono()
  routes.post('/polar', async (c) => {
    if (!config.polarWebhookSecret || !config.polarProductId) {
      return c.json({ error: 'Polar no está configurado.' }, 503)
    }
    const payload = object(verifyPolar(await c.req.text(), c.req.header(), config.polarWebhookSecret))
    if (typeof payload.type !== 'string' || !EVENTS.has(payload.type)) return c.json({ ok: true, ignored: true })
    const data = object(payload.data)
    if (data.product_id !== config.polarProductId) return c.json({ ok: true, ignored: true })
    const customer = object(data.customer)
    const email = typeof customer.email === 'string' ? customer.email.trim().toLowerCase() : ''
    const version = date(data.modified_at ?? payload.timestamp)
    const end = date(data.current_period_end)
    if (typeof data.id !== 'string' || !data.id || !Number.isFinite(version) ||
        typeof data.status !== 'string' || !STATUSES.has(data.status)) {
      return c.json({ error: 'Suscripción de Polar inválida.' }, 400)
    }
    let status: SubscriptionRow['status'] = 'inactive'
    if (data.status === 'active' || data.status === 'trialing') status = 'active'
    if (data.status === 'canceled') status = 'canceled'
    if (data.status === 'past_due' || data.status === 'unpaid') status = 'past_due'
    if (payload.type === 'subscription.revoked' || data.ended_at) status = 'revoked'
    if ((status === 'active' || status === 'canceled') && !Number.isFinite(end)) {
      return c.json({ error: 'Falta el vencimiento de la suscripción.' }, 400)
    }
    const eventId = c.req.header('webhook-id')!
    const result = await service.db.transaction(async (sql) => {
      // Claim atomically: concurrent deliveries wait here, and failures roll back the claim.
      const claim = await sql.query('INSERT INTO webhook_events (id, processed_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [eventId, Date.now()])
      if (!claim.rowCount) return { duplicate: true }
      // Serialize first-time binding for this provider subscription, including email changes.
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`polar:${data.id}`])
      const linked = await sql.one<SubscriptionRow>('SELECT * FROM subscriptions WHERE provider_subscription_id = $1', [data.id])
      const user = linked ? { id: linked.user_id } : await sql.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])
      // Do not acknowledge an unassigned payment: allow retry after account reconciliation.
      if (!user) throw new HTTPException(409, { message: 'No existe una cuenta para este cliente de Polar.' })
      await sql.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id])
      const current = await service.row(user.id, sql)
      if (current && current.provider_updated_at >= version) {
        return { ignored: true }
      }
      if (current?.provider_subscription_id && current.provider_subscription_id !== data.id &&
          (await service.get(user.id, sql)).plan === 'pro') {
        throw new HTTPException(409, { message: 'La cuenta ya tiene otra suscripción activa de Polar.' })
      }
      await sql.query(`INSERT INTO subscriptions
        (user_id, status, provider, current_period_end, cancel_at_period_end, provider_subscription_id, provider_updated_at, updated_at)
        VALUES ($1, $2, 'polar', $3, $4, $5, $6, $7)
        ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, provider = 'polar',
          current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
          provider_subscription_id = excluded.provider_subscription_id,
          provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at`,
        [user.id, status, status === 'revoked' ? Date.now() : (Number.isFinite(end) ? end : 0),
          data.cancel_at_period_end === true, data.id, version, Date.now()])
      return { updated: true }
    })
    return c.json({ ok: true, ...result })
  })
  return routes
}
