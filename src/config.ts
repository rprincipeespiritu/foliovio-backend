import { fileURLToPath } from 'node:url'

export interface Config {
  isProd: boolean
  port: number
  appOrigin: string
  jwtSecret: string
  adminSecret: string
  databasePath: string
  cookieSameSite: 'lax' | 'none' | 'strict'
  polarWebhookSecret: string
  polarProductId: string
}

export function readConfig(env = process.env): Config {
  const isProd = env.NODE_ENV === 'production'
  const jwtSecret = env.JWT_SECRET || (isProd ? '' : 'foliovio-dev-secret-cambia-esto')
  if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres en producción.')
  if (isProd && !env.APP_ORIGIN) throw new Error('APP_ORIGIN es obligatorio en producción.')
  const appOrigin = new URL(env.APP_ORIGIN || 'http://localhost:5173').origin
  const cookieSameSite = env.COOKIE_SAME_SITE || 'lax'
  if (!['lax', 'none', 'strict'].includes(cookieSameSite)) throw new Error('COOKIE_SAME_SITE inválido.')
  if (cookieSameSite === 'none' && !isProd) throw new Error('SameSite=None requiere cookies seguras en producción.')
  const port = Number(env.PORT || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido.')
  return {
    isProd, port, appOrigin, jwtSecret,
    adminSecret: env.ADMIN_SECRET || '',
    databasePath: env.DATABASE_PATH || fileURLToPath(new URL('../data/foliovio.db', import.meta.url)),
    cookieSameSite: cookieSameSite as Config['cookieSameSite'],
    polarWebhookSecret: env.POLAR_WEBHOOK_SECRET || '',
    polarProductId: env.POLAR_PRODUCT_ID || '',
  }
}
