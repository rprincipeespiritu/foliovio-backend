import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { migrate, openDatabase } from '../src/db.js'
import { SubscriptionService } from '../src/modules/subscriptions/service.js'
import { testDatabase } from './database.js'

const pid = (prefix: string, value: number) => `${prefix}_${String(value).padStart(26, '0')}`
const priceId = pid('pri', 1)
const secret = 'paddle-test-secret'

async function fixture() {
  const database = await testDatabase()
  const config = readConfig({ DATABASE_URL: database.url, PADDLE_PRICE_ID: priceId, PADDLE_API_KEY: 'test-api', PADDLE_CLIENT_TOKEN: 'test_browser', PADDLE_WEBHOOK_SECRET: secret })
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const customers: Record<string, unknown>[] = []
  const transactions = new Map<string, Record<string, unknown>>()
  let fail = false
  let cycle = { interval: 'month', frequency: 1 }
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://sandbox-api.paddle.com')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-api')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, body })
    if (fail) return new Response('{}', { status: 503 })
    let data: unknown
    if (url.pathname.startsWith('/prices/')) data = { id: priceId, status: 'active', billing_cycle: cycle, unit_price: { amount: '1900', currency_code: 'PEN' } }
    else if (url.pathname === '/customers' && !body) data = customers.filter(c => c.email === url.searchParams.get('email'))
    else if (url.pathname === '/customers') {
      data = { ...body, id: pid('ctm', customers.length + 1), status: 'active' }
      customers.push(data as Record<string, unknown>)
    } else if (url.pathname === '/transactions') {
      const transaction = { ...body, id: pid('txn', transactions.size + 1), status: 'ready' }
      transactions.set(transaction.id, transaction)
      data = transaction
    } else if (url.pathname.startsWith('/transactions/')) data = transactions.get(url.pathname.split('/')[2])
    else if (url.pathname.endsWith('/portal-sessions')) data = { urls: { general: { overview: 'https://sandbox-customer-portal.paddle.com/test?token=private' } } }
    else throw new Error(`Unexpected request: ${url.pathname}`)
    return Response.json({ data })
  }
  const app = createApp(database.db, config, async () => {}, transport)
  const service = new SubscriptionService(database.db)
  const account = async (number: number, verified = true) => {
    const userId = `user-${number}`
    await database.db.query('INSERT INTO users (id,email,password_hash,name,created_at,email_verified_at) VALUES ($1,$2,$3,$4,$5,$6)', [userId, `user${number}@example.test`, 'unused', 'Test', Date.now(), verified ? Date.now() : null])
    const token = await new SignJWT({ sub: userId }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(config.jwtSecret))
    const cookie = `foliovio_session=${token}`
    const request = (path: string, body?: unknown, origin?: string) => app.request(`/api/billing/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { userId, cookie, request }
  }
  let counter = 0
  const event = (overrides: Record<string, unknown> = {}, version = Date.now()) => ({
    event_id: pid('evt', ++counter), event_type: 'subscription.updated', occurred_at: new Date(version).toISOString(),
    data: { id: pid('sub', 1), customer_id: pid('ctm', 1), status: 'active', items: [{ price: { id: priceId } }],
      current_billing_period: { ends_at: new Date(Date.now() + 86400000).toISOString() }, scheduled_change: null, ...overrides },
  })
  const webhook = (payload: unknown, timestamp = Math.floor(Date.now() / 1000), signingKey = secret) => {
    const body = JSON.stringify(payload)
    const signature = createHmac('sha256', signingKey).update(`${timestamp}:${body}`).digest('hex')
    return app.request('/api/webhooks/paddle', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${timestamp};h1=${signature}` } })
  }
  return { ...database, config, app, service, transport, calls, customers, transactions, account, event, webhook,
    fail: (value: boolean) => { fail = value }, cycle: (value: typeof cycle) => { cycle = value } }
}

test('Paddle checkout requires a verified session, pins price and owner, and reuses simultaneous attempts', async t => {
  const f = await fixture(); t.after(f.cleanup)
  assert.equal((await f.app.request('/api/billing/checkout', { method: 'POST' })).status, 401)
  const pending = await f.account(9, false)
  assert.equal((await pending.request('checkout', {})).status, 401)
  const a = await f.account(1)
  const b = await f.account(2)
  assert.equal((await a.request('checkout', {}, 'https://evil.test')).status, 403)
  const results = await Promise.all([a.request('checkout', { userId: b.userId, priceId: pid('pri', 9) }), a.request('checkout', {})])
  assert.deepEqual(results.map(r => r.status), [200, 200])
  assert.deepEqual(await results[0].json(), await results[1].json())
  assert.equal(f.calls.filter(c => c.path === '/transactions' && c.body).length, 1)
  const created = f.calls.find(c => c.path === '/transactions')!.body!
  assert.deepEqual(created.items, [{ price_id: priceId, quantity: 1 }])
  assert.deepEqual(created.custom_data, { foliovio_user_id: a.userId })
  assert.equal((await f.service.get(a.userId)).plan, 'free')
  assert.equal((await f.service.get(b.userId)).plan, 'free')
  const publicConfig = await (await a.request('config')).json()
  assert.equal(publicConfig.enabled, true)
  assert.equal(publicConfig.clientToken, 'test_browser')
  assert.equal(JSON.stringify(publicConfig).includes('test-api'), false)
  assert.equal(JSON.stringify(publicConfig).includes(secret), false)
})

test('Paddle rejects invalid signatures, old/future timestamps, malformed subscriptions and unlinked clients', async t => {
  const f = await fixture(); t.after(f.cleanup)
  assert.equal((await f.app.request('/api/webhooks/paddle', { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await f.webhook(f.event(), undefined, 'forged')).status, 401)
  assert.equal((await f.webhook(f.event(), Math.floor(Date.now() / 1000) - 30)).status, 401)
  assert.equal((await f.webhook(f.event(), Math.floor(Date.now() / 1000) + 30)).status, 401)
  assert.equal((await f.webhook(f.event({ status: 'invented' }))).status, 400)
  const unassigned = f.event()
  assert.equal((await f.webhook(unassigned)).status, 409)
  assert.equal((await f.db.one('SELECT COUNT(*) AS count FROM webhook_events'))!.count, 0)
  const a = await f.account(1); await a.request('checkout', {})
  assert.equal((await f.webhook(unassigned)).status, 200)
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
})

test('Paddle grants only the mapped customer, deduplicates and ignores older events across connections', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.account(1); const b = await f.account(2)
  await a.request('checkout', {})
  const otherDb = await openDatabase(f.url, { schema: f.schema }); t.after(() => otherDb.close())
  const otherApp = createApp(otherDb, f.config, async () => {}, f.transport)
  const now = Date.now()
  const event = f.event({ custom_data: { foliovio_user_id: b.userId } }, now)
  const body = JSON.stringify(event); const ts = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')
  const responses = await Promise.all([f.webhook(event), otherApp.request('/api/webhooks/paddle', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${ts};h1=${signature}` } })])
  const outcomes = await Promise.all(responses.map(r => r.json()))
  assert.equal(outcomes.filter(r => r.updated).length, 1)
  assert.equal(outcomes.filter(r => r.duplicate).length, 1)
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
  assert.equal((await f.service.get(b.userId)).plan, 'free')
  assert.equal((await new SubscriptionService(f.db, 'production').get(a.userId)).plan, 'free')
  assert.equal((await a.request('checkout', {})).status, 409)
  assert.equal((await a.request('activate', {})).status, 409)
  assert.equal(await f.service.revoke(a.userId), null)
  await f.webhook(f.event({ status: 'canceled', current_billing_period: null }, now - 1000))
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
  assert.equal((await f.webhook(f.event({ customer_id: pid('ctm', 50), items: [{ price: { id: pid('pri', 50) } }] }))).status, 200)
})

test('Paddle renewals, scheduled cancellation, past due, pause and effective cancellation update access', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.account(1); await a.request('checkout', {})
  let version = Date.now()
  const publish = async (data: Record<string, unknown>) => assert.equal((await f.webhook(f.event(data, ++version))).status, 200)
  const end = Date.now() + 40 * 86400000
  await publish({ current_billing_period: { ends_at: new Date(end).toISOString() } })
  assert.equal((await f.service.get(a.userId)).currentPeriodEnd, end)
  const cancelDate = Date.now() + 100000
  await publish({ scheduled_change: { action: 'cancel', effective_at: new Date(cancelDate).toISOString() } })
  assert.equal((await f.service.get(a.userId)).cancelAtPeriodEnd, true)
  assert.equal((await f.service.get(a.userId)).currentPeriodEnd, cancelDate)
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
  await publish({ status: 'past_due' })
  assert.equal((await f.service.get(a.userId)).plan, 'free')
  assert.equal((await a.request('checkout', {})).status, 409)
  await publish({ status: 'active' })
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
  await publish({ status: 'paused', current_billing_period: null })
  assert.equal((await f.service.get(a.userId)).plan, 'free')
  await publish({ status: 'active' })
  await publish({ status: 'canceled', current_billing_period: null })
  assert.equal((await f.service.get(a.userId)).plan, 'free')
  assert.equal((await f.service.get(a.userId)).status, 'revoked')
  f.transactions.get(pid('txn', 1))!.status = 'completed'
  assert.equal((await a.request('checkout', {})).status, 200)
  await publish({ id: pid('sub', 2), status: 'active' })
  assert.equal((await f.service.row(a.userId))!.provider_subscription_id, pid('sub', 2))
  await f.webhook(f.event({ status: 'canceled', current_billing_period: null }, version - 1))
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
})

test('Paddle portal uses only the session owner, is not cached and checkout fails closed on provider errors', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.account(1); const b = await f.account(2)
  await a.request('checkout', {})
  const portal = await a.request('portal', { userId: b.userId, customer_id: pid('ctm', 99) })
  assert.equal(portal.status, 200)
  assert.equal(portal.headers.get('cache-control'), 'no-store')
  assert.equal(f.calls.at(-1)!.path, `/customers/${pid('ctm', 1)}/portal-sessions`)
  assert.equal((await b.request('portal', { userId: a.userId })).status, 404)
  f.fail(true)
  assert.equal((await b.request('checkout', {})).status, 503)
  assert.equal((await f.service.get(b.userId)).plan, 'free')
  f.fail(false); f.cycle({ interval: 'year', frequency: 1 })
  assert.equal((await b.request('checkout', {})).status, 503)
})

test('Paddle completed checkout waits for webhook; unrelated prices cannot grant access and removals revoke it', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const a = await f.account(1); await a.request('checkout', {})
  f.transactions.get(pid('txn', 1))!.status = 'completed'
  assert.equal((await a.request('checkout', {})).status, 409)
  assert.equal((await f.service.get(a.userId)).plan, 'free')
  const version = Date.now()
  await f.webhook(f.event({ items: [{ price: { id: pid('pri', 50) } }] }, version))
  assert.equal((await f.service.get(a.userId)).plan, 'free')
  await f.webhook(f.event({}, version + 1))
  assert.equal((await f.service.get(a.userId)).plan, 'pro')
  await f.webhook(f.event({ items: [{ price: { id: pid('pri', 50) } }] }, version + 2))
  assert.equal((await f.service.get(a.userId)).plan, 'free')
})

test('Paddle configuration is optional and migration preserves existing subscriptions and exports', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const disabledApp = createApp(f.db, readConfig({ DATABASE_URL: f.url }))
  assert.deepEqual(await (await disabledApp.request('/api/billing/config')).json(), { enabled: false })
  const a = await f.account(1); await f.service.grant(a.userId, 'manual'); await f.service.consumeExport(a.userId)
  const before = await f.service.publicUser(a.userId)
  await f.db.query(`DROP TABLE paddle_customers; ALTER TABLE subscriptions DROP COLUMN provider_environment;
    ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_provider_check;
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_provider_check CHECK(provider IN ('manual','local','legacy','polar'));
    DELETE FROM schema_migrations WHERE version = 3`)
  await Promise.all([migrate(f.db), migrate(f.db)])
  assert.deepEqual(await f.service.publicUser(a.userId), before)
  assert.equal((await f.db.one('SELECT COUNT(*) AS count FROM schema_migrations'))!.count, 3)
  assert.throws(() => readConfig({ DATABASE_URL: f.url, PADDLE_ENVIRONMENT: 'production', PADDLE_CLIENT_TOKEN: 'test_wrong' }))
})
