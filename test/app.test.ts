import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Webhook } from 'standardwebhooks'
import { createApp } from '../src/app.js'
import { readConfig, type Config } from '../src/config.js'
import { migrate, openDatabase } from '../src/db.js'
import { testDatabase } from './database.js'
import { SubscriptionService } from '../src/modules/subscriptions/service.js'
import type { VerificationEmail } from '../src/modules/auth/mail.js'

const secret = `whsec_${Buffer.from('test-polar-signing-key-32-bytes!!!').toString('base64')}`

async function fixture(overrides: Partial<Config> = {}) {
  const { db, url, schema, cleanup } = await testDatabase()
  const config = { ...readConfig({ DATABASE_URL: url }), adminSecret: 'test-admin', polarWebhookSecret: secret, polarProductId: 'product-pro', ...overrides }
  const emails: VerificationEmail[] = []
  const app = createApp(db, config, async (message) => { emails.push(message) })
  const subscriptions = new SubscriptionService(db)
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const register = async (email: string) => {
    const response = await request('/api/auth/register', { email, password: 'password-123', name: 'Test' })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('set-cookie'), null)
    const token = new URLSearchParams(new URL(emails.at(-1)!.url).hash.slice(1)).get('verify-email')
    assert.equal((await request('/api/auth/verify-email', { token })).status, 200)
    const login = await request('/api/auth/login', { email, password: 'password-123' })
    assert.equal(login.status, 200)
    const { user } = await login.json()
    return { user, cookie: login.headers.get('set-cookie')!.split(';')[0] }
  }
  const webhook = async (payload: unknown, id = randomUUID(), legacy = false, timestamp = new Date()) => {
    const body = JSON.stringify(payload)
    const signer = new Webhook(legacy ? Buffer.from(secret).toString('base64') : secret)
    return app.request('/api/webhooks/polar', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'webhook-id': id,
        'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'webhook-signature': signer.sign(id, timestamp, body) },
    })
  }
  return { db, app, config, request, register, subscriptions, webhook, schema, cleanup }
}

function polarEvent(email: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'subscription.updated', timestamp: new Date().toISOString(),
    data: { id: 'subscription-1', product_id: 'product-pro', status: 'active', customer: { email },
      modified_at: new Date().toISOString(), current_period_end: new Date(Date.now() + 86400000).toISOString(),
      cancel_at_period_end: false, ...overrides },
  }
}

test('registration, session, login and logout work without exposing password hashes', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const account = await f.register('USER@example.com')
  assert.equal(account.user.email, 'user@example.com')
  assert.equal(account.user.password_hash, undefined)
  assert.equal(account.user.subscription.plan, 'free')
  const me = await f.request('/api/auth/me', undefined, { cookie: account.cookie })
  assert.equal((await me.json()).user.id, account.user.id)
  assert.equal((await f.request('/api/auth/login', { email: 'user@example.com', password: 'wrong' })).status, 401)
  const login = await f.request('/api/auth/login', { email: 'user@example.com', password: 'password-123' })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/i)
  const logout = await f.request('/api/auth/logout', {}, { cookie: account.cookie })
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/i)
  assert.equal((await f.request('/api/auth/me').then(r => r.json())).user, null)
})

test('malformed input and duplicate accounts return client errors', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  for (const body of [null, [], { email: 4, password: {} }, { email: 'a@b.com', password: 'a' }, { email: 'a@b.com', password: 'é'.repeat(40) }]) {
    assert.equal((await f.request('/api/auth/register', body)).status, 400)
  }
  await f.register('user@example.com')
  assert.equal((await f.request('/api/auth/register', { email: 'USER@example.com', password: 'password-123' })).status, 409)
})

test('subscriptions and the free export belong only to the authenticated user', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  const b = await f.register('b@example.com')
  assert.equal((await f.request('/api/billing/subscription')).status, 401)
  assert.equal((await f.request('/api/billing/export', {})).status, 401)
  const responses = await Promise.all(Array.from({ length: 3 }, () =>
    f.request('/api/billing/export', { userId: b.user.id }, { cookie: a.cookie })))
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 402, 402])
  assert.equal((await f.subscriptions.publicUser(b.user.id)).remainingFree, 1)
  await f.request('/api/billing/activate', { userId: b.user.id }, { cookie: a.cookie })
  assert.equal((await f.subscriptions.get(a.user.id)).plan, 'pro')
  assert.equal((await f.subscriptions.get(b.user.id)).plan, 'free')
  assert.equal((await f.request(`/api/billing/subscription?userId=${a.user.id}`, undefined, { cookie: b.cookie }).then(r => r.json())).subscription.plan, 'free')
})

test('admin grants extend 30 days, expire and revoke without resetting usage', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  assert.equal((await f.request('/api/admin/grant', { userId: a.user.id }, { cookie: a.cookie })).status, 401)
  const admin = { 'x-admin-secret': 'test-admin' }
  await f.request('/api/billing/export', {}, { cookie: a.cookie })
  const first = await f.request('/api/admin/grant', { email: 'A@example.com' }, admin).then(r => r.json())
  const second = await f.request('/api/admin/grant', { userId: a.user.id }, admin).then(r => r.json())
  assert.equal(second.user.premiumUntil - first.user.premiumUntil, 30 * 86400000)
  assert.equal((await f.request(`/api/admin/subscriptions/${a.user.id}`, undefined, admin)).status, 200)
  await f.db.query('UPDATE subscriptions SET current_period_end = $1 WHERE user_id = $2', [Date.now() - 1, a.user.id])
  assert.equal((await f.subscriptions.get(a.user.id)).status, 'expired')
  assert.equal((await f.request('/api/billing/export', {}, { cookie: a.cookie })).status, 402)
  await f.request('/api/admin/grant', { userId: a.user.id }, admin)
  const revoked = await f.request('/api/admin/revoke', { userId: a.user.id }, admin).then(r => r.json())
  assert.equal(revoked.user.premium, false)
  assert.equal(revoked.user.subscription.status, 'revoked')
  assert.equal(revoked.user.exportCount, 1)
})

test('production blocks local activation and foreign origins, with credentialed CORS', async (t) => {
  const f = await fixture({ isProd: true, appOrigin: 'https://app.example.com', cookieSameSite: 'none' })
  t.after(f.cleanup)
  const a = await f.register('a@example.com')
  assert.equal((await f.request('/api/billing/activate', {}, { cookie: a.cookie })).status, 403)
  assert.equal((await f.request('/api/auth/logout', {}, { origin: 'https://attacker.example', cookie: a.cookie })).status, 403)
  const response = await f.request('/api/auth/login', { email: a.user.email, password: 'password-123' }, { origin: 'https://app.example.com' })
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com')
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
  assert.match(response.headers.get('set-cookie')!, /Secure/)
  assert.match(response.headers.get('set-cookie')!, /SameSite=None/i)
  assert.equal((await f.request('/')).status, 404)
  assert.deepEqual(await f.request('/api/health').then(r => r.json()), { ok: true })
})

test('PostgreSQL migrations can run concurrently and preserve existing data', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  await f.subscriptions.grant(a.user.id, 'manual')
  await f.subscriptions.revoke(a.user.id)
  await Promise.all([migrate(f.db), migrate(f.db), migrate(f.db)])
  assert.equal((await f.subscriptions.get(a.user.id)).status, 'revoked')
  assert.equal((await f.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations'))!.count, 3)
})

test('webhooks reject missing secrets, forged signatures and expired signatures', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  const payload = polarEvent(a.user.email)
  assert.equal((await f.request('/api/webhooks/polar', payload, { 'x-polar-secret': secret })).status, 401)
  assert.equal((await f.webhook(payload, randomUUID(), false, new Date(Date.now() - 10 * 60000))).status, 401)
  const unconfigured = createApp(f.db, { ...f.config, polarWebhookSecret: '' })
  assert.equal((await unconfigured.request('/api/webhooks/polar', { method: 'POST', body: JSON.stringify(payload) })).status, 503)
  assert.equal((await f.subscriptions.get(a.user.id)).plan, 'free')
})

test('Polar synchronizes renewals, deduplicates retries and rejects older events', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  const b = await f.register('b@example.com')
  const base = Date.now() - 10000
  const payload = polarEvent(a.user.email, { modified_at: new Date(base).toISOString() })
  const eventId = randomUUID()
  assert.equal((await f.webhook(payload, eventId)).status, 200)
  assert.equal((await f.webhook(payload, eventId).then(r => r.json())).duplicate, true)
  assert.equal((await f.subscriptions.get(a.user.id)).currentPeriodEnd, Date.parse(payload.data.current_period_end))
  assert.equal((await f.subscriptions.get(b.user.id)).plan, 'free')
  const renewed = polarEvent(a.user.email, { modified_at: new Date(base + 1000).toISOString(), current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() })
  // Once bound, changes in the payment email must not transfer the subscription.
  renewed.data.customer.email = b.user.email
  assert.equal((await f.webhook(renewed, randomUUID(), true)).status, 200)
  assert.equal((await f.webhook(payload).then(r => r.json())).ignored, true)
  assert.equal((await f.subscriptions.get(a.user.id)).currentPeriodEnd, Date.parse(renewed.data.current_period_end))
  assert.equal((await f.subscriptions.get(b.user.id)).plan, 'free')
  assert.equal((await f.request('/api/admin/revoke', { userId: a.user.id }, { 'x-admin-secret': 'test-admin' })).status, 409)
})

test('Polar cancellation retains the paid period; revocation and past due remove Pro', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  const base = Date.now() - 10000
  const canceled = polarEvent(a.user.email, { status: 'canceled', cancel_at_period_end: true, modified_at: new Date(base).toISOString() })
  assert.equal((await f.webhook(canceled)).status, 200)
  assert.equal((await f.subscriptions.get(a.user.id)).plan, 'pro')
  assert.equal((await f.subscriptions.get(a.user.id)).cancelAtPeriodEnd, true)
  const pastDue = polarEvent(a.user.email, { status: 'past_due', modified_at: new Date(base + 1000).toISOString() })
  await f.webhook(pastDue)
  assert.equal((await f.subscriptions.get(a.user.id)).plan, 'free')
  const revoked = { ...polarEvent(a.user.email, { modified_at: new Date(base + 2000).toISOString() }), type: 'subscription.revoked' }
  await f.webhook(revoked)
  assert.equal((await f.subscriptions.get(a.user.id)).status, 'revoked')
  assert.equal((await f.subscriptions.get(a.user.id)).plan, 'free')
})

test('unrelated products and events cannot grant Pro; unknown users can retry', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.register('a@example.com')
  assert.equal((await f.webhook(polarEvent(a.user.email, { product_id: 'other' })).then(r => r.json())).ignored, true)
  assert.equal((await f.webhook({ ...polarEvent(a.user.email), type: 'order.created' }).then(r => r.json())).ignored, true)
  assert.equal((await f.subscriptions.get(a.user.id)).plan, 'free')
  assert.equal((await f.webhook(polarEvent(a.user.email, { current_period_end: null }))).status, 400)
  const id = randomUUID()
  const payload = polarEvent('new@example.com')
  assert.equal((await f.webhook(payload, id)).status, 409)
  const newcomer = await f.register('new@example.com')
  assert.equal((await f.webhook(payload, id)).status, 200)
  assert.equal((await f.subscriptions.get(newcomer.user.id)).plan, 'pro')
})

test('production configuration requires a strong secret and an explicit origin', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /JWT_SECRET/)
  assert.throws(() => readConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(32) }), /APP_ORIGIN/)
  assert.throws(() => readConfig({ COOKIE_SAME_SITE: 'none' }), /SameSite/)
  assert.throws(() => readConfig({ PORT: 'invalid' }), /PORT/)
})

test('parallel grants and exports serialize across independent connection pools', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const secondDb = await openDatabase(f.config.databaseUrl, { schema: f.schema })
  t.after(() => secondDb.close())
  const other = new SubscriptionService(secondDb)
  const a = await f.register('parallel@example.com')
  const exports = await Promise.all([f.subscriptions.consumeExport(a.user.id), other.consumeExport(a.user.id)])
  assert.equal(exports.filter(result => result.allowed).length, 1)
  const grants = await Promise.all([f.subscriptions.grant(a.user.id, 'manual'), other.grant(a.user.id, 'manual')])
  const ends = grants.map(user => user!.premiumUntil).sort((a, b) => a - b)
  assert.equal(ends[1] - ends[0], 30 * 86400000)
  assert.equal((await f.subscriptions.publicUser(a.user.id)).exportCount, 1)
})

test('concurrent webhook retries apply once and failed deliveries roll back their claim', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const eventId = randomUUID()
  const payload = polarEvent('retry@example.com')
  assert.equal((await f.webhook(payload, eventId)).status, 409)
  assert.equal(await f.db.one('SELECT id FROM webhook_events WHERE id = $1', [eventId]), undefined)
  const account = await f.register('retry@example.com')
  const deliveries = await Promise.all(Array.from({ length: 5 }, () => f.webhook(payload, eventId).then(r => r.json())))
  assert.equal(deliveries.filter(result => result.updated).length, 1)
  assert.equal(deliveries.filter(result => result.duplicate).length, 4)
  assert.equal((await f.subscriptions.get(account.user.id)).currentPeriodEnd, Date.parse(payload.data.current_period_end))
})

test('transaction rollback removes partial writes and leaves the pool usable', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  await assert.rejects(f.db.transaction(async sql => {
    await sql.query('INSERT INTO webhook_events (id, processed_at) VALUES ($1, $2)', ['rolled-back', Date.now()])
    throw new Error('Intentional rollback')
  }), /Intentional rollback/)
  assert.equal(await f.db.one('SELECT id FROM webhook_events WHERE id = $1', ['rolled-back']), undefined)
  assert.equal((await f.request('/api/health')).status, 200)
})

test('configuration requires a PostgreSQL connection URL', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL/)
  assert.throws(() => readConfig({ DATABASE_URL: 'https://localhost/foliovio' }), /DATABASE_URL/)
  assert.throws(() => readConfig({ DATABASE_URL: 'postgresql://localhost' }), /DATABASE_URL/)
  assert.equal(readConfig({ DATABASE_URL: 'postgresql://localhost/foliovio' }).databaseUrl, 'postgresql://localhost/foliovio')
})
