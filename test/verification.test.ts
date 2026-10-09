import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { migrate, openDatabase } from '../src/db.js'
import { MailDeliveryError, sendGridMailer, type VerificationEmail } from '../src/modules/auth/mail.js'
import { testDatabase } from './database.js'

async function fixture() {
  const database = await testDatabase()
  const config = readConfig({ DATABASE_URL: database.url, APP_ORIGIN: 'https://www.foliovio.test' })
  const messages: VerificationEmail[] = []
  let fail = false
  const mailer = async (message: VerificationEmail) => {
    if (fail) throw new MailDeliveryError()
    messages.push(message)
  }
  const app = createApp(database.db, config, mailer)
  const request = (path: string, body?: unknown, cookie?: string) => app.request(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const register = (email = 'test@example.test') => request('register', { email, name: 'Prueba', password: 'password-123' })
  const token = () => new URLSearchParams(new URL(messages.at(-1)!.url).hash.slice(1)).get('verify-email')!
  return { ...database, app, config, mailer, messages, request, register, token, failMail: (value: boolean) => { fail = value } }
}

test('pending registration sends a hashed single-use token and cannot authenticate until activation', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  const registered = await f.register('TEST@example.test')
  assert.equal(registered.status, 201)
  assert.equal(registered.headers.get('set-cookie'), null)
  const body = await registered.json()
  assert.equal(body.verificationRequired, true)
  assert.equal(body.user, undefined)
  assert.equal(body.token, undefined)
  assert.equal(f.messages[0].email, 'test@example.test')
  const link = new URL(f.messages[0].url)
  assert.equal(link.origin, f.config.appOrigin)
  assert.equal(link.search, '')
  const token = f.token()
  const stored = await f.db.one('SELECT * FROM email_verifications')
  assert.equal(stored!.token_hash, createHash('sha256').update(token).digest('hex'))
  assert.ok(stored!.expires_at > Date.now() + 23 * 3600000)
  const login = await f.request('login', { email: 'test@example.test', password: 'password-123' })
  assert.equal(login.status, 403)
  assert.equal((await login.json()).code, 'EMAIL_NOT_VERIFIED')
  assert.equal((await f.request('login', { email: 'test@example.test', password: 'wrong' })).status, 401)
  // Even a previously issued/signed session must not authorize a pending account.
  const user = await f.db.one('SELECT id FROM users')
  const session = await new SignJWT({ sub: user!.id }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(f.config.jwtSecret))
  assert.deepEqual(await (await f.request('me', undefined, `foliovio_session=${session}`)).json(), { user: null })
  assert.equal((await f.app.request('/api/billing/export', { method: 'POST', headers: { cookie: `foliovio_session=${session}` } })).status, 401)
  assert.equal((await f.request(`verify-email?token=${token}`)).status, 404)
  const activated = await f.request('verify-email', { token })
  assert.equal(activated.status, 200)
  assert.equal(activated.headers.get('set-cookie'), null)
  assert.equal((await f.request('verify-email', { token })).status, 400)
  const signedIn = await f.request('login', { email: 'test@example.test', password: 'password-123' })
  assert.equal(signedIn.status, 200)
  assert.ok(signedIn.headers.get('set-cookie'))
})

test('invalid and expired links fail; concurrent verification consumes a token only once across pools', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  await f.register()
  for (const token of ['', 'invalid', 'a'.repeat(64), null]) {
    assert.equal((await f.request('verify-email', { token })).status, 400)
  }
  await f.db.query('UPDATE email_verifications SET expires_at = $1', [Date.now() - 1])
  assert.equal((await f.request('verify-email', { token: f.token() })).status, 400)
  assert.equal((await f.db.one('SELECT email_verified_at FROM users'))!.email_verified_at, null)
  await f.db.query('UPDATE email_verifications SET expires_at = $1', [Date.now() + 60000])
  const second = await openDatabase(f.url, { schema: f.schema }); t.after(() => second.close())
  const otherApp = createApp(second, f.config, f.mailer)
  const results = await Promise.all([
    f.request('verify-email', { token: f.token() }),
    otherApp.request('/api/auth/verify-email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: f.token() }) }),
  ])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400])
})

test('resends rotate links, use shared cooldowns and do not reveal unknown or active accounts', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  await f.register()
  const first = f.token()
  const pending = await f.request('resend-verification', { email: 'test@example.test' })
  const unknown = await f.request('resend-verification', { email: 'missing@example.test' })
  assert.equal(pending.status, 202)
  assert.deepEqual(await pending.json(), await unknown.json())
  assert.equal(f.messages.length, 1)
  await f.db.query('UPDATE email_verifications SET last_attempt_at = $1', [Date.now() - 61000])
  const second = await openDatabase(f.url, { schema: f.schema }); t.after(() => second.close())
  const other = createApp(second, f.config, f.mailer)
  await Promise.all([
    f.request('resend-verification', { email: 'test@example.test' }),
    other.request('/api/auth/resend-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'test@example.test' }) }),
  ])
  assert.equal(f.messages.length, 2)
  assert.notEqual(first, f.token())
  assert.equal((await f.request('verify-email', { token: first })).status, 400)
  await f.db.query('UPDATE email_verifications SET last_attempt_at = $1, attempts = 5', [Date.now() - 61000])
  await f.request('resend-verification', { email: 'test@example.test' })
  assert.equal(f.messages.length, 2)
  await f.db.query('UPDATE email_verifications SET window_started_at = $1', [Date.now() - 3600001])
  await f.request('resend-verification', { email: 'test@example.test' })
  assert.equal(f.messages.length, 3)
  await f.request('verify-email', { token: f.token() })
  const active = await f.request('resend-verification', { email: 'test@example.test' })
  assert.equal(active.status, 202)
  assert.equal(f.messages.length, 3)
})

test('provider failures leave a recoverable pending account and preserve the last delivered link', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  f.failMail(true)
  const response = await f.register()
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'VERIFICATION_EMAIL_FAILED')
  assert.equal((await f.db.one('SELECT email_verified_at FROM users'))!.email_verified_at, null)
  assert.equal((await f.db.one('SELECT attempts FROM email_verifications'))!.attempts, 1)
  f.failMail(false)
  await f.db.query('UPDATE email_verifications SET last_attempt_at = $1', [Date.now() - 61000])
  await f.request('resend-verification', { email: 'test@example.test' })
  const first = f.token()
  f.failMail(true)
  await f.db.query('UPDATE email_verifications SET last_attempt_at = $1', [Date.now() - 61000])
  assert.equal((await f.request('resend-verification', { email: 'test@example.test' })).status, 503)
  assert.equal((await f.request('verify-email', { token: first })).status, 200)
})

test('migration upgrades legacy accounts once while new accounts stay pending', async (t) => {
  const f = await fixture(); t.after(f.cleanup)
  // Recreate version 1 inside this isolated test schema only.
  await f.db.query('DROP TABLE email_verifications; ALTER TABLE users DROP COLUMN email_verified_at; DELETE FROM schema_migrations WHERE version = 2')
  await f.db.query("INSERT INTO users (id,email,password_hash,name,created_at,export_count) VALUES ('legacy','legacy@example.test','hash','Legacy',100,1)")
  await Promise.all([migrate(f.db), migrate(f.db)])
  const legacy = await f.db.one("SELECT * FROM users WHERE id = 'legacy'")
  assert.equal(legacy!.email_verified_at, 100)
  assert.equal(legacy!.export_count, 1)
  await f.register()
  await migrate(f.db)
  assert.equal((await f.db.one("SELECT email_verified_at FROM users WHERE email = 'test@example.test'"))!.email_verified_at, null)
})

test('SendGrid adapter requires configuration and sends verification content without tracking', async () => {
  const config = readConfig({ DATABASE_URL: 'postgres://localhost/test', SENDGRID_API_KEY: 'test-only-key', EMAIL_FROM: 'cuentas@foliovio.test', EMAIL_FROM_NAME: 'Foliovio' })
  const message = { email: 'test@example.test', url: 'https://www.foliovio.test/#verify-email=abc' }
  let requests = 0
  const send: typeof fetch = async (input, init) => {
    requests++
    assert.equal(input, 'https://api.sendgrid.com/v3/mail/send')
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer test-only-key')
    const body = JSON.parse(init!.body as string)
    assert.equal(body.personalizations[0].to[0].email, message.email)
    assert.equal(body.from.email, config.emailFrom)
    assert.ok(body.content.every((part: { value: string }) => part.value.includes(message.url)))
    assert.equal(body.tracking_settings.click_tracking.enable, false)
    assert.equal(body.tracking_settings.open_tracking.enable, false)
    assert.ok(init!.signal)
    return new Response(null, { status: 202 })
  }
  await sendGridMailer(config, send)(message)
  assert.equal(requests, 1)
  await assert.rejects(sendGridMailer({ ...config, sendgridApiKey: '' }, send)(message), MailDeliveryError)
  await assert.rejects(sendGridMailer({ ...config, emailFrom: '' }, send)(message), MailDeliveryError)
  assert.equal(requests, 1)
  await assert.rejects(sendGridMailer(config, async () => new Response(null, { status: 401 }))(message), MailDeliveryError)
  await assert.rejects(sendGridMailer(config, async () => { throw new Error('timeout') })(message), MailDeliveryError)
})
