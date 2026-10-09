import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Config } from '../../config.js'
import type { AppEnv } from '../../types.js'
import type { UserRow } from '../../db.js'
import type { SubscriptionService } from './service.js'

type Json = Record<string, unknown>
function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
function id(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value)
}
function date(value: unknown) { return typeof value === 'string' ? Date.parse(value) : NaN }
function unavailable(): never { throw new HTTPException(503, { message: 'Los pagos no están disponibles en este momento. Inténtalo más tarde.' }) }

export function verifyPaddle(body: string, header: string, secret: string) {
  const parts = header.split(';').map(part => part.trim().split('='))
  const timestamps = parts.filter(([key]) => key === 'ts')
  const timestamp = timestamps[0]?.[1] || ''
  if (!secret || timestamps.length !== 1 || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 5) {
    throw new HTTPException(401, { message: 'Firma de webhook inválida o vencida.' })
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}:${body}`).digest()
  if (!parts.some(([key, value]) => key === 'h1' && /^[a-f0-9]{64}$/i.test(value || '') && timingSafeEqual(Buffer.from(value, 'hex'), expected))) {
    throw new HTTPException(401, { message: 'Firma de webhook inválida.' })
  }
  try { return object(JSON.parse(body)) } catch { throw new HTTPException(400, { message: 'Webhook inválido.' }) }
}

export class PaddleService {
  constructor(readonly service: SubscriptionService, readonly config: Config, readonly send: typeof fetch = fetch) {}

  enabled() {
    const c = this.config
    return Boolean(c.paddleApiKey && c.paddleClientToken && c.paddlePriceId && c.paddleWebhookSecret)
  }

  async api(path: string, body?: unknown): Promise<unknown> {
    if (!this.enabled()) unavailable()
    const origin = this.config.paddleEnvironment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com'
    try {
      const response = await this.send(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.config.paddleApiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        console.error(`Paddle rechazó una solicitud (HTTP ${response.status}).`)
        unavailable()
      }
      const result = object(await response.json())
      if (!result.data) unavailable()
      return result.data
    } catch { unavailable() }
  }

  async price() {
    const price = object(await this.api(`/prices/${this.config.paddlePriceId}`))
    const cycle = object(price.billing_cycle)
    const unit = object(price.unit_price)
    if (price.id !== this.config.paddlePriceId || price.status !== 'active' || cycle.interval !== 'month' || cycle.frequency !== 1 ||
        typeof unit.amount !== 'string' || !/^\d+$/.test(unit.amount) || typeof unit.currency_code !== 'string') unavailable()
    const formatter = new Intl.NumberFormat('es-PE', { style: 'currency', currency: unit.currency_code })
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
    return formatter.format(Number(unit.amount) / 10 ** digits)
  }

  async checkout(user: UserRow) {
    await this.price() // Only the configured monthly price can be bought.
    const env = this.config.paddleEnvironment
    return this.service.db.transaction(async sql => {
      await sql.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id])
      const current = await this.service.row(user.id, sql)
      if ((await this.service.get(user.id, sql)).plan === 'pro' || current?.provider === 'polar' ||
          (current?.provider === 'paddle' && (current.provider_environment !== env || !['revoked', 'inactive'].includes(current.status)))) {
        throw new HTTPException(409, { message: 'Ya tienes una suscripción. Gestiona tu plan y tus pagos desde Mi cuenta.' })
      }
      let customer = await sql.one<{ customer_id: string; checkout_transaction_id: string | null }>(
        'SELECT * FROM paddle_customers WHERE user_id = $1 AND environment = $2', [user.id, env])
      if (!customer) {
        // Verified account email is used only when creating the persistent mapping, never from request data.
        const matches = await this.api(`/customers?email=${encodeURIComponent(user.email)}`)
        const existing = Array.isArray(matches) ? matches.map(object).find(c => c.email === user.email && c.status === 'active') : undefined
        const remote = existing || object(await this.api('/customers', { email: user.email, name: user.name || undefined, custom_data: { foliovio_user_id: user.id } }))
        if (!id(remote.id, 'ctm')) unavailable()
        await sql.query('INSERT INTO paddle_customers (user_id, environment, customer_id) VALUES ($1, $2, $3)', [user.id, env, remote.id])
        customer = { customer_id: remote.id, checkout_transaction_id: null }
      }
      if (customer.checkout_transaction_id) {
        const transaction = object(await this.api(`/transactions/${customer.checkout_transaction_id}`))
        if (transaction.customer_id !== customer.customer_id) unavailable()
        if (['draft', 'ready'].includes(String(transaction.status))) return { transactionId: customer.checkout_transaction_id }
        if (transaction.status !== 'canceled' && !(current?.provider === 'paddle' && current.status === 'revoked')) {
          throw new HTTPException(409, { message: 'Tu pago se está procesando. Espera la confirmación antes de volver a pagar.' })
        }
      }
      const transaction = object(await this.api('/transactions', {
        items: [{ price_id: this.config.paddlePriceId, quantity: 1 }], customer_id: customer.customer_id,
        collection_mode: 'automatic', custom_data: { foliovio_user_id: user.id }, checkout: { url: this.config.appOrigin },
      }))
      if (!id(transaction.id, 'txn')) unavailable()
      await sql.query('UPDATE paddle_customers SET checkout_transaction_id = $1 WHERE user_id = $2 AND environment = $3', [transaction.id, user.id, env])
      return { transactionId: transaction.id }
    })
  }

  async portal(userId: string) {
    const customer = await this.service.db.one<{ customer_id: string }>('SELECT customer_id FROM paddle_customers WHERE user_id = $1 AND environment = $2', [userId, this.config.paddleEnvironment])
    if (!customer) throw new HTTPException(404, { message: 'Todavía no tienes pagos en Paddle.' })
    const session = object(await this.api(`/customers/${customer.customer_id}/portal-sessions`, {}))
    const url = object(object(session.urls).general).overview
    const host = this.config.paddleEnvironment === 'sandbox' ? 'sandbox-customer-portal.paddle.com' : 'customer-portal.paddle.com'
    if (typeof url !== 'string' || new URL(url).protocol !== 'https:' || new URL(url).hostname !== host) unavailable()
    return { url }
  }

  async webhook(payload: Json) {
    if (!['subscription.created', 'subscription.updated', 'subscription.activated', 'subscription.trialing', 'subscription.canceled', 'subscription.paused', 'subscription.resumed', 'subscription.past_due'].includes(String(payload.event_type))) return { ignored: true }
    const data = object(payload.data)
    const version = date(payload.occurred_at)
    if (!id(payload.event_id, 'evt') || !id(data.id, 'sub') || !id(data.customer_id, 'ctm') || !Number.isFinite(version) ||
        !['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(String(data.status))) {
      throw new HTTPException(400, { message: 'Suscripción de Paddle inválida.' })
    }
    const env = this.config.paddleEnvironment
    return this.service.db.transaction(async sql => {
      const claim = await sql.query('INSERT INTO webhook_events (id, processed_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [`paddle:${env}:${payload.event_id}`, Date.now()])
      if (!claim.rowCount) return { duplicate: true }
      const customer = await sql.one<{ user_id: string }>('SELECT user_id FROM paddle_customers WHERE customer_id = $1 AND environment = $2', [data.customer_id, env])
      const matchingPrice = Array.isArray(data.items) && data.items.some(item => object(object(item).price).id === this.config.paddlePriceId)
      if (!customer) {
        if (!matchingPrice) return { ignored: true }
        throw new HTTPException(409, { message: 'El cliente de Paddle no está vinculado a una cuenta.' })
      }
      await sql.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [customer.user_id])
      const current = await this.service.row(customer.user_id, sql)
      const same = current?.provider === 'paddle' && current.provider_environment === env && current.provider_subscription_id === data.id
      if (!matchingPrice && !same) return { ignored: true }
      if (current?.provider === 'polar') throw new HTTPException(409, { message: 'La cuenta tiene una suscripción gestionada por otro proveedor.' })
      if (current?.provider === 'paddle' && !same) {
        if (current.provider_updated_at >= version) return { ignored: true }
        if (current.status !== 'revoked' || current.provider_environment !== env) throw new HTTPException(409, { message: 'La cuenta ya tiene otra suscripción de Paddle.' })
      }
      if (same && current.provider_updated_at >= version) return { ignored: true }
      const scheduled = object(data.scheduled_change)
      let end = date(object(data.current_billing_period).ends_at)
      const cancel = scheduled.action === 'cancel'
      if (scheduled.action === 'cancel' || scheduled.action === 'pause') {
        const effective = date(scheduled.effective_at)
        if (!Number.isFinite(effective)) throw new HTTPException(400, { message: 'Fecha de cambio inválida.' })
        end = Math.min(end, effective)
      }
      // Past-due payments suspend Pro until Paddle confirms recovery. Canceled means cancellation already took effect.
      const status = !matchingPrice || data.status === 'canceled' ? 'revoked'
        : data.status === 'paused' ? 'inactive' : data.status === 'past_due' ? 'past_due' : 'active'
      if (status === 'active' && !Number.isFinite(end)) throw new HTTPException(400, { message: 'Falta el período de facturación.' })
      await sql.query(`INSERT INTO subscriptions
        (user_id, status, provider, current_period_end, cancel_at_period_end, provider_subscription_id, provider_updated_at, updated_at, provider_environment)
        VALUES ($1, $2, 'paddle', $3, $4, $5, $6, $7, $8)
        ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, provider = 'paddle', current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end, provider_subscription_id = excluded.provider_subscription_id,
        provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at, provider_environment = excluded.provider_environment`,
        [customer.user_id, status, status === 'revoked' ? 0 : Number.isFinite(end) ? end : 0, cancel && status === 'active', data.id, version, Date.now(), env])
      return { updated: true }
    })
  }
}

export function paddleBillingRoutes(paddle: PaddleService) {
  const routes = new Hono<AppEnv>()
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
  routes.get('/config', async c => {
    if (!paddle.enabled()) return c.json({ enabled: false })
    return c.json({ enabled: true, environment: paddle.config.paddleEnvironment, clientToken: paddle.config.paddleClientToken, price: await paddle.price() })
  })
  routes.use('*', async (c, next) => {
    if (!c.get('user')) return c.json({ error: 'Inicia sesión para gestionar tu suscripción.' }, 401)
    await next()
  })
  routes.post('/checkout', async c => c.json(await paddle.checkout(c.get('user')!)))
  routes.post('/portal', async c => c.json(await paddle.portal(c.get('user')!.id)))
  return routes
}

export function paddleWebhookRoutes(paddle: PaddleService) {
  const routes = new Hono()
  routes.post('/paddle', async c => {
    if (!paddle.enabled()) return c.json({ error: 'Paddle no está configurado.' }, 503)
    const payload = verifyPaddle(await c.req.text(), c.req.header('Paddle-Signature') || '', paddle.config.paddleWebhookSecret)
    return c.json({ ok: true, ...await paddle.webhook(payload) })
  })
  return routes
}
