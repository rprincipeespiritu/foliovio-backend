import { randomUUID } from 'node:crypto'
import { hash, compare } from 'bcryptjs'
import { Hono } from 'hono'
import type { Database } from '../../db.js'
import type { Config } from '../../config.js'
import type { UserRow } from '../../db.js'
import type { AppEnv } from '../../types.js'
import type { SubscriptionService } from '../subscriptions/service.js'
import { clearSession, setSession } from './session.js'
import { MailDeliveryError, type VerificationMailer } from './mail.js'
import { EmailVerification } from './verification.js'

export function authRoutes(db: Database, config: Config, subscriptions: SubscriptionService, mailer: VerificationMailer) {
  const routes = new Hono<AppEnv>()
  const verification = new EmailVerification(db, config.appOrigin, mailer)
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  routes.post('/register', async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Escribe un email válido.' }, 400)
    if (name.length > 120) return c.json({ error: 'El nombre admite hasta 120 caracteres.' }, 400)
    if (password.length < 8 || Buffer.byteLength(password) > 72) {
      return c.json({ error: 'La contraseña debe tener al menos 8 caracteres y como máximo 72 bytes.' }, 400)
    }
    const passwordHash = await hash(password, 12)
    const id = randomUUID()
    const result = await db.query(`INSERT INTO users (id, email, password_hash, name, created_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT(email) DO NOTHING`, [id, email, passwordHash, name, Date.now()])
    if (!result.rowCount) return c.json({ error: 'Ese email ya tiene cuenta. Entra o solicita otro enlace de activación.' }, 409)
    try {
      await verification.send(email)
    } catch (error) {
      if (!(error instanceof MailDeliveryError)) throw error
      return c.json({ code: 'VERIFICATION_EMAIL_FAILED', error: 'Tu cuenta está pendiente de activación, pero no pudimos enviar el correo. Espera un minuto y solicita otro enlace.' }, 503)
    }
    return c.json({ verificationRequired: true, message: 'Revisa tu correo para activar tu cuenta. El enlace vence en 24 horas.' }, 201)
  })
  routes.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [email])
    if (!user || !(await compare(password, user.password_hash))) {
      return c.json({ error: 'Email o contraseña incorrectos.' }, 401)
    }
    if (user.email_verified_at === null) {
      return c.json({ code: 'EMAIL_NOT_VERIFIED', error: 'Activa tu cuenta desde el enlace que enviamos a tu correo antes de entrar.' }, 403)
    }
    await setSession(c, user.id, config)
    return c.json({ user: await subscriptions.publicUser(user.id) })
  })
  routes.post('/logout', (c) => {
    clearSession(c, config)
    return c.json({ ok: true })
  })
  routes.post('/resend-verification', async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Escribe un email válido.' }, 400)
    try {
      await verification.send(email)
    } catch (error) {
      if (!(error instanceof MailDeliveryError)) throw error
      return c.json({ error: 'No se pudo enviar el correo. Espera un minuto e inténtalo de nuevo.' }, 503)
    }
    return c.json({ message: 'Si tu cuenta está pendiente, recibirás un enlace de activación. Revisa también spam. Puedes solicitar uno por minuto, hasta 5 por hora.' }, 202)
  })
  routes.post('/verify-email', async (c) => {
    const body = await c.req.json().catch(() => null)
    const token = typeof body?.token === 'string' ? body.token : ''
    if (!(await verification.verify(token))) return c.json({ code: 'INVALID_VERIFICATION_TOKEN', error: 'El enlace no es válido, ya fue usado o venció. Solicita uno nuevo.' }, 400)
    return c.json({ ok: true, message: 'Cuenta activada. Ya puedes entrar con tu email y contraseña.' })
  })
  routes.get('/me', async (c) => {
    const user = c.get('user')
    return c.json({ user: user ? await subscriptions.publicUser(user.id) : null })
  })
  return routes
}
