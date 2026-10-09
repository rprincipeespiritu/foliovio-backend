export interface Config {
  isProd: boolean
  port: number
  appOrigin: string
  jwtSecret: string
  adminSecret: string
  databaseUrl: string
  cookieSameSite: 'lax' | 'none' | 'strict'
  polarWebhookSecret: string
  polarProductId: string
  sendgridApiKey: string
  emailFrom: string
  emailFromName: string
  paddleEnvironment: 'sandbox' | 'production'
  paddleApiKey: string
  paddleClientToken: string
  paddleWebhookSecret: string
  paddlePriceId: string
}

export function readConfig(env = process.env): Config {
  const isProd = env.NODE_ENV === 'production'
  const jwtSecret = env.JWT_SECRET || (isProd ? '' : 'foliovio-dev-secret-cambia-esto')
  if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres en producción.')
  if (isProd && !env.APP_ORIGIN) throw new Error('APP_ORIGIN es obligatorio en producción.')
  const appOrigin = new URL(env.APP_ORIGIN || 'http://localhost:5173').origin
  if (isProd && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN debe usar HTTPS en producción.')
  const emailFrom = env.EMAIL_FROM?.trim() || ''
  if (emailFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFrom)) throw new Error('EMAIL_FROM debe ser un email válido.')
  const cookieSameSite = env.COOKIE_SAME_SITE || 'lax'
  const paddleEnvironment = env.PADDLE_ENVIRONMENT || 'sandbox'
  if (!['sandbox', 'production'].includes(paddleEnvironment)) throw new Error('PADDLE_ENVIRONMENT debe ser sandbox o production.')
  const paddleClientToken = env.PADDLE_CLIENT_TOKEN?.trim() || ''
  if (paddleClientToken && !paddleClientToken.startsWith(paddleEnvironment === 'sandbox' ? 'test_' : 'live_')) throw new Error('PADDLE_CLIENT_TOKEN no corresponde al entorno de Paddle.')
  const paddlePriceId = env.PADDLE_PRICE_ID?.trim() || ''
  if (paddlePriceId && !/^pri_[a-z0-9]{26}$/.test(paddlePriceId)) throw new Error('PADDLE_PRICE_ID inválido.')
  if (!['lax', 'none', 'strict'].includes(cookieSameSite)) throw new Error('COOKIE_SAME_SITE inválido.')
  if (cookieSameSite === 'none' && !isProd) throw new Error('SameSite=None requiere cookies seguras en producción.')
  const port = Number(env.PORT || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido.')
  const databaseUrl = env.DATABASE_URL || ''
  try {
    const url = new URL(databaseUrl)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error()
  } catch {
    throw new Error('DATABASE_URL debe ser una URL PostgreSQL con servidor y nombre de base de datos.')
  }
  return {
    isProd, port, appOrigin, jwtSecret,
    adminSecret: env.ADMIN_SECRET || '',
    databaseUrl,
    cookieSameSite: cookieSameSite as Config['cookieSameSite'],
    polarWebhookSecret: env.POLAR_WEBHOOK_SECRET || '',
    polarProductId: env.POLAR_PRODUCT_ID || '',
    sendgridApiKey: env.SENDGRID_API_KEY || '',
    emailFrom,
    emailFromName: env.EMAIL_FROM_NAME?.trim() || 'Foliovio',
    paddleEnvironment: paddleEnvironment as Config['paddleEnvironment'],
    paddleApiKey: env.PADDLE_API_KEY?.trim() || '',
    paddleClientToken,
    paddleWebhookSecret: env.PADDLE_WEBHOOK_SECRET?.trim() || '',
    paddlePriceId,
  }
}
