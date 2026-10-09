import type { Config } from '../../config.js'

export interface VerificationEmail {
  email: string
  url: string
}

export type VerificationMailer = (message: VerificationEmail) => Promise<void>

export class MailDeliveryError extends Error {
  constructor() { super('No se pudo enviar el correo de activación.') }
}

export function sendGridMailer(config: Config, send: typeof fetch = fetch): VerificationMailer {
  return async ({ email, url }) => {
    if (!config.sendgridApiKey || !config.emailFrom) throw new MailDeliveryError()
    const safeUrl = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
    try {
      const response = await send('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.sendgridApiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: config.emailFrom, name: config.emailFromName },
          subject: 'Activa tu cuenta de Foliovio',
          content: [
            { type: 'text/plain', value: `Confirma tu correo para activar tu cuenta de Foliovio:\n\n${url}\n\nEl enlace vence en 24 horas y solo se puede usar una vez. Si no creaste esta cuenta, ignora este correo.` },
            { type: 'text/html', value: `<h1>Activa tu cuenta de Foliovio</h1><p>Confirma tu correo para empezar a usar tu cuenta.</p><p><a href="${safeUrl}">Activar mi cuenta</a></p><p>El enlace vence en 24 horas y solo se puede usar una vez.</p><p>Si no creaste esta cuenta, ignora este correo.</p>` },
          ],
          tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
        }),
      })
      if (response.status !== 202) {
        // Do not log provider bodies: they can contain addresses and sensitive metadata.
        console.error(`SendGrid rechazó el correo de activación (HTTP ${response.status}).`)
        throw new MailDeliveryError()
      }
    } catch {
      throw new MailDeliveryError()
    }
  }
}
