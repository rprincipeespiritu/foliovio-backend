import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { openDatabase, migrate } from '../src/db.js'
import { createSession, IDLE_TIMEOUT_MS } from '../src/modules/auth/session.js'
import { testDatabase } from './database.js'

async function fixture() {
  const database = await testDatabase()
  const { db } = database
  const config = readConfig({ DATABASE_URL: database.url })
  await db.query(`INSERT INTO users (id, email, password_hash, name, created_at, email_verified_at)
    VALUES ('idle-user', 'idle@example.com', 'unused', 'Idle', $1, $1)`, [Date.now()])
  const { token, session } = await createSession(db, 'idle-user', config)
  const cookie = `foliovio_session=${token}`
  const app = createApp(db, config, async () => {})
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ...database, config, cookie, session, request }
}

test('background requests never renew idle sessions; real activity does and preserves reported idle time', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const previous = Date.now() - 300_000
  await f.db.query('UPDATE auth_sessions SET last_activity_at = $1', [previous])
  const me = await (await f.request('/api/auth/me')).json()
  assert.equal(me.user.id, 'idle-user')
  assert.equal(me.session.id, f.session.id)
  assert.ok(me.session.remainingMs > 290_000 && me.session.remainingMs <= 300_000)
  await f.request('/api/billing/subscription')
  assert.equal((await f.db.one('SELECT last_activity_at FROM auth_sessions'))!.last_activity_at, previous)
  const start = Date.now()
  assert.equal((await f.request('/api/auth/activity', { sessionId: f.session.id, idleMs: 5000 })).status, 200)
  const updated = (await f.db.one('SELECT last_activity_at FROM auth_sessions'))!.last_activity_at
  assert.ok(updated >= start - 5000 && updated <= Date.now() - 5000)
  // A delayed activity report cannot move the deadline backwards.
  await f.request('/api/auth/activity', { sessionId: f.session.id, idleMs: 100_000 })
  assert.equal((await f.db.one('SELECT last_activity_at FROM auth_sessions'))!.last_activity_at, updated)
})

test('ten-minute expiration denies protected operations and cannot be revived by activity or replaying the cookie', async t => {
  const f = await fixture(); t.after(f.cleanup)
  await f.db.query('UPDATE auth_sessions SET last_activity_at = $1', [Date.now() - IDLE_TIMEOUT_MS])
  assert.deepEqual(await (await f.request('/api/auth/me')).json(), { user: null, session: null })
  assert.equal((await f.request('/api/billing/export', {})).status, 401)
  assert.equal((await f.request('/api/billing/checkout', {})).status, 401)
  const activity = await f.request('/api/auth/activity', { sessionId: f.session.id, idleMs: 0 })
  assert.equal(activity.status, 401)
  assert.equal((await activity.json()).code, 'SESSION_EXPIRED')
})

test('activity validates the session, elapsed time, origin, and absolute session expiry', async t => {
  const f = await fixture(); t.after(f.cleanup)
  for (const idleMs of [-1, IDLE_TIMEOUT_MS, '0', null]) {
    assert.equal((await f.request('/api/auth/activity', { sessionId: f.session.id, idleMs })).status, 400)
  }
  assert.equal((await f.request('/api/auth/activity', { sessionId: 'another-session', idleMs: 0 })).status, 401)
  assert.equal((await f.request('/api/auth/activity', { sessionId: f.session.id, idleMs: 0 }, { origin: 'https://untrusted.example' })).status, 403)
  await f.db.query('UPDATE auth_sessions SET expires_at = $1', [Date.now() - 1])
  assert.equal((await f.request('/api/auth/activity', { sessionId: f.session.id, idleMs: 0 })).status, 401)
})

test('logout revokes persisted sessions across server instances and stale tabs cannot revoke a new session', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const otherDb = await openDatabase(f.url, { schema: f.schema }); t.after(() => otherDb.close())
  const otherApp = createApp(otherDb, f.config, async () => {})
  assert.equal((await (await otherApp.request('/api/auth/me', { headers: { cookie: f.cookie } })).json()).user.id, 'idle-user')
  const staleLogout = await f.request('/api/auth/logout', { sessionId: 'old-session' })
  assert.equal(staleLogout.headers.get('set-cookie'), null)
  assert.equal((await (await f.request('/api/auth/me')).json()).user.id, 'idle-user')
  await f.request('/api/auth/logout', { sessionId: f.session.id })
  assert.equal((await (await otherApp.request('/api/auth/me', { headers: { cookie: f.cookie } })).json()).user, null)
  const fresh = await createSession(f.db, 'idle-user', f.config)
  assert.notEqual(fresh.session.id, f.session.id)
  await migrate(f.db)
  assert.equal((await f.db.one('SELECT COUNT(*) AS count FROM auth_sessions'))!.count, 1)
})

test('legacy JWTs without a persisted session are rejected after deployment', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const token = await new SignJWT({ sub: 'idle-user' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30d').sign(new TextEncoder().encode(f.config.jwtSecret))
  assert.equal((await (await f.request('/api/auth/me', undefined, { cookie: `foliovio_session=${token}` })).json()).user, null)
})
