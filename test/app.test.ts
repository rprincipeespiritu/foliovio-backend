import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { Webhook } from 'standardwebhooks'
import { createApp } from '../src/app.js'
import { readConfig, type Config } from '../src/config.js'
import { migrate, openDatabase } from '../src/db.js'
import { SubscriptionService } from '../src/modules/subscriptions/service.js'

const secret = `whsec_${Buffer.from('test-polar-signing-key-32-bytes!!!').toString('base64')}`

function fixture(overrides: Partial<Config> = {}) {
  const db = openDatabase(':memory:')
  const config = { ...readConfig({}), adminSecret: 'test-admin', polarWebhookSecret: secret, polarProductId: 'product-pro', ...overrides }
  const app = createApp(db, config)
  const subscriptions = new SubscriptionService(db)
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const register = async (email: string) => {
    const response = await request('/api/auth/register', { email, password: 'password-123', name: 'Test' })
    assert.equal(response.status, 200)
    const { user } = await response.json()
    return { user, cookie: response.headers.get('set-cookie')!.split(';')[0] }
  }
  const webhook = (payload: unknown, id = randomUUID(), legacy = false, timestamp = new Date()) => {
    const body = JSON.stringify(payload)
    const signer = new Webhook(legacy ? Buffer.from(secret).toString('base64') : secret)
    return app.request('/api/webhooks/polar', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'webhook-id': id,
        'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'webhook-signature': signer.sign(id, timestamp, body) },
    })
  }
  return { db, app, config, request, register, subscriptions, webhook }
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
  const f = fixture(); t.after(() => f.db.close())
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
  const f = fixture(); t.after(() => f.db.close())
  for (const body of [null, [], { email: 4, password: {} }, { email: 'a@b.com', password: 'a' }, { email: 'a@b.com', password: 'é'.repeat(40) }]) {
    assert.equal((await f.request('/api/auth/register', body)).status, 400)
  }
  await f.register('user@example.com')
  assert.equal((await f.request('/api/auth/register', { email: 'USER@example.com', password: 'password-123' })).status, 409)
})

test('subscriptions and the free export belong only to the authenticated user', async (t) => {
  const f = fixture(); t.after(() => f.db.close())
  const a = await f.register('a@example.com')
  const b = await f.register('b@example.com')
  assert.equal((await f.request('/api/billing/subscription')).status, 401)
  assert.equal((await f.request('/api/billing/export', {})).status, 401)
  const responses = await Promise.all(Array.from({ length: 3 }, () =>
    f.request('/api/billing/export', { userId: b.user.id }, { cookie: a.cookie })))
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 402, 402])
  assert.equal(f.subscriptions.publicUser(b.user.id).remainingFree, 1)
  await f.request('/api/billing/activate', { userId: b.user.id }, { cookie: a.cookie })
  assert.equal(f.subscriptions.get(a.user.id).plan, 'pro')
  assert.equal(f.subscriptions.get(b.user.id).plan, 'free')
  assert.equal((await f.request(`/api/billing/subscription?userId=${a.user.id}`, undefined, { cookie: b.cookie }).then(r => r.json())).subscription.plan, 'free')
})

test('admin grants extend 30 days, expire and revoke without resetting usage', async (t) => {
  const f = fixture(); t.after(() => f.db.close())
  const a = await f.register('a@example.com')
  assert.equal((await f.request('/api/admin/grant', { userId: a.user.id }, { cookie: a.cookie })).status, 401)
  const admin = { 'x-admin-secret': 'test-admin' }
  await f.request('/api/billing/export', {}, { cookie: a.cookie })
  const first = await f.request('/api/admin/grant', { email: 'A@example.com' }, admin).then(r => r.json())
  const second = await f.request('/api/admin/grant', { userId: a.user.id }, admin).then(r => r.json())
  assert.equal(second.user.premiumUntil - first.user.premiumUntil, 30 * 86400000)
  assert.equal((await f.request(`/api/admin/subscriptions/${a.user.id}`, undefined, admin)).status, 200)
  f.db.prepare('UPDATE subscriptions SET current_period_end = ? WHERE user_id = ?').run(Date.now() - 1, a.user.id)
  assert.equal(f.subscriptions.get(a.user.id).status, 'expired')
  assert.equal((await f.request('/api/billing/export', {}, { cookie: a.cookie })).status, 402)
  await f.request('/api/admin/grant', { userId: a.user.id }, admin)
  const revoked = await f.request('/api/admin/revoke', { userId: a.user.id }, admin).then(r => r.json())
  assert.equal(revoked.user.premium, false)
  assert.equal(revoked.user.subscription.status, 'revoked')
  assert.equal(revoked.user.exportCount, 1)
})

test('production blocks local activation and foreign origins, with credentialed CORS', async (t) => {
  const f = fixture({ isProd: true, appOrigin: 'https://app.example.com', cookieSameSite: 'none' })
  t.after(() => f.db.close())
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

test('legacy migration preserves users, Pro expiry and usage and runs only once', () => {
  const db = new Database(':memory:')
  try {
    const until = Date.now() + 86400000
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT,
      created_at INTEGER, premium_until INTEGER DEFAULT 0, export_count INTEGER DEFAULT 0)`)
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run('old-user', 'old@example.com', 'hash', 'Old', 1, until, 7)
    migrate(db)
    const service = new SubscriptionService(db)
    assert.equal(service.get('old-user').currentPeriodEnd, until)
    assert.equal(service.get('old-user').provider, 'legacy')
    assert.equal(service.publicUser('old-user').exportCount, 7)
    service.revoke('old-user')
    migrate(db)
    assert.equal(service.get('old-user').status, 'revoked')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as { count: number }).count, 1)
  } finally { db.close() }
})

test('webhooks reject missing secrets, forged signatures and expired signatures', async (t) => {
  const f = fixture(); t.after(() => f.db.close())
  const a = await f.register('a@example.com')
  const payload = polarEvent(a.user.email)
  assert.equal((await f.request('/api/webhooks/polar', payload, { 'x-polar-secret': secret })).status, 401)
  assert.equal((await f.webhook(payload, randomUUID(), false, new Date(Date.now() - 10 * 60000))).status, 401)
  const unconfigured = createApp(f.db, { ...f.config, polarWebhookSecret: '' })
  assert.equal((await unconfigured.request('/api/webhooks/polar', { method: 'POST', body: JSON.stringify(payload) })).status, 503)
  assert.equal(f.subscriptions.get(a.user.id).plan, 'free')
})

test('Polar synchronizes renewals, deduplicates retries and rejects older events', async (t) => {
  const f = fixture(); t.after(() => f.db.close())
  const a = await f.register('a@example.com')
  const b = await f.register('b@example.com')
  const base = Date.now() - 10000
  const payload = polarEvent(a.user.email, { modified_at: new Date(base).toISOString() })
  const eventId = randomUUID()
  assert.equal((await f.webhook(payload, eventId)).status, 200)
  assert.equal((await f.webhook(payload, eventId).then(r => r.json())).duplicate, true)
  assert.equal(f.subscriptions.get(a.user.id).currentPeriodEnd, Date.parse(payload.data.current_period_end))
  assert.equal(f.subscriptions.get(b.user.id).plan, 'free')
  const renewed = polarEvent(a.user.email, { modified_at: new Date(base + 1000).toISOString(), current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() })
  // Once bound, changes in the payment email must not transfer the subscription.
  renewed.data.customer.email = b.user.email
  assert.equal((await f.webhook(renewed, randomUUID(), true)).status, 200)
  assert.equal((await f.webhook(payload).then(r => r.json())).ignored, true)
  assert.equal(f.subscriptions.get(a.user.id).currentPeriodEnd, Date.parse(renewed.data.current_period_end))
  assert.equal(f.subscriptions.get(b.user.id).plan, 'free')
  assert.equal((await f.request('/api/admin/revoke', { userId: a.user.id }, { 'x-admin-secret': 'test-admin' })).status, 409)
})

test('Polar cancellation retains the paid period; revocation and past due remove Pro', async (t) => {
  const f = fixture(); t.after(() => f.db.close())
  const a = await f.register('a@example.com')
  const base = Date.now() - 10000
  const canceled = polarEvent(a.user.email, { status: 'canceled', cancel_at_period_end: true, modified_at: new Date(base).toISOString() })
  assert.equal((await f.webhook(canceled)).status, 200)
  assert.equal(f.subscriptions.get(a.user.id).plan, 'pro')
  assert.equal(f.subscriptions.get(a.user.id).cancelAtPeriodEnd, true)
  const pastDue = polarEvent(a.user.email, { status: 'past_due', modified_at: new Date(base + 1000).toISOString() })
  await f.webhook(pastDue)
  assert.equal(f.subscriptions.get(a.user.id).plan, 'free')
  const revoked = { ...polarEvent(a.user.email, { modified_at: new Date(base + 2000).toISOString() }), type: 'subscription.revoked' }
  await f.webhook(revoked)
  assert.equal(f.subscriptions.get(a.user.id).status, 'revoked')
  assert.equal(f.subscriptions.get(a.user.id).plan, 'free')
})

test('unrelated products and events cannot grant Pro; unknown users can retry', async (t) => {
  const f = fixture(); t.after(() => f.db.close())
  const a = await f.register('a@example.com')
  assert.equal((await f.webhook(polarEvent(a.user.email, { product_id: 'other' })).then(r => r.json())).ignored, true)
  assert.equal((await f.webhook({ ...polarEvent(a.user.email), type: 'order.created' }).then(r => r.json())).ignored, true)
  assert.equal(f.subscriptions.get(a.user.id).plan, 'free')
  assert.equal((await f.webhook(polarEvent(a.user.email, { current_period_end: null }))).status, 400)
  const id = randomUUID()
  const payload = polarEvent('new@example.com')
  assert.equal((await f.webhook(payload, id)).status, 409)
  const newcomer = await f.register('new@example.com')
  assert.equal((await f.webhook(payload, id)).status, 200)
  assert.equal(f.subscriptions.get(newcomer.user.id).plan, 'pro')
})

test('production configuration requires a strong secret and an explicit origin', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /JWT_SECRET/)
  assert.throws(() => readConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(32) }), /APP_ORIGIN/)
  assert.throws(() => readConfig({ COOKIE_SAME_SITE: 'none' }), /SameSite/)
  assert.throws(() => readConfig({ PORT: 'invalid' }), /PORT/)
})
