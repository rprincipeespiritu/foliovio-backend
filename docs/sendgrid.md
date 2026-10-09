# Activación de cuentas con SendGrid

## Flujo

1. El registro crea una cuenta pendiente y envía el correo. Responde HTTP 201 con `verificationRequired: true`, sin cookie ni usuario autenticado.
2. El enlace apunta a `APP_ORIGIN/#verify-email=TOKEN`. El frontend retira el fragmento del historial y muestra **Activar mi cuenta**. Abrir el enlace no consume el token automáticamente.
3. El botón envía un POST a `/api/auth/verify-email`. Después de activar, el usuario entra con su contraseña.
4. Las cuentas pendientes no pueden iniciar sesión ni usar rutas protegidas, incluso con una cookie firmada anteriormente.
5. Desde el formulario de acceso se puede reenviar el correo. Se permite un intento por minuto y cinco por hora por cuenta, compartidos entre instancias mediante PostgreSQL. Los fallos de SendGrid también cuentan.

Los tokens son aleatorios de 256 bits, de un solo uso y vencen en 24 horas. La base guarda únicamente SHA-256. Un reenvío aceptado por SendGrid invalida el enlace anterior; un fallo conserva el último enlace válido. Las solicitudes para correos inexistentes, activos o limitados reciben el mismo mensaje genérico.

La migración 2 conserva el acceso de las cuentas preexistentes asignando su fecha de creación a `email_verified_at` como excepción de compatibilidad; **no demuestra que esas cuentas hayan confirmado su correo**. Las cuentas nuevas siempre se crean pendientes. La migración se aplica una sola vez antes de iniciar la API y conserva suscripciones y descargas.

## Configurar SendGrid

1. En SendGrid, abre **Settings → Sender Authentication**. Autentica `foliovio.com` siguiendo los registros DNS que indique SendGrid; cópialos en Squarespace. Conserva el CNAME `www` de Railway y sus registros de verificación. Para una prueba inicial también puedes verificar un remitente individual.
2. Usa una dirección de ese dominio autorizado, por ejemplo `cuentas@foliovio.com`, como remitente. El nombre visible puede ser `Foliovio`.
3. En **Settings → API Keys**, crea una clave con permiso **Mail Send**. Guarda el valor directamente en las variables del backend; no lo subas a Git ni lo compartas por chat.
4. En Railway, configura estas variables en el servicio **foliovio-backend**, entorno **production**:

| Variable | Valor |
| --- | --- |
| `SENDGRID_API_KEY` | La API key de SendGrid con permiso de envío |
| `EMAIL_FROM` | La dirección autorizada, por ejemplo `cuentas@foliovio.com` |
| `EMAIL_FROM_NAME` | `Foliovio` (opcional, valor predeterminado) |
| `APP_ORIGIN` | `https://www.foliovio.com` |

No hay secretos de correo en el frontend. Para desarrollo utiliza las mismas variables en el `.env` del backend, un remitente verificado y `APP_ORIGIN=http://localhost:5173`. El envío real requiere SendGrid tanto en dev como en producción; no hay bypass de activación ni enlaces expuestos en respuestas/logs. Las pruebas automatizadas inyectan un remitente simulado y no envían correos.

## Publicación y comprobación

Configura las variables primero. Promueve **ambos repositorios** de dev a prd, publicando el frontend antes del backend para que el nuevo resultado de registro ya tenga interfaz. La versión nueva del frontend también permite iniciar sesión con el backend anterior; en ese intervalo conviene evitar nuevos registros hasta que termine el despliegue del backend.

Registra una cuenta controlada, comprueba que no pueda entrar antes de activarla, abre el correo, pulsa el botón y entra. Reutilizar o vencer el enlace debe mostrar un error y ofrecer otro enlace. Comprueba también el reenvío y la conservación del plan de las cuentas antiguas.

Si no hay configuración de SendGrid, la API y las cuentas activas siguen funcionando, pero el registro devuelve 503 con `VERIFICATION_EMAIL_FAILED`; la nueva cuenta queda pendiente y se puede recuperar desde **Reenviar activación** después de configurar el servicio. No se activa ninguna cuenta por un fallo de envío.

SendGrid responde 202 cuando acepta el envío, no cuando llega a la bandeja. Consulta **Email Activity** y spam si el correo no llega. Los logs de la API muestran el código HTTP de rechazo sin imprimir la API key, el token o el cuerpo de respuesta del proveedor. El adaptador usa la API global `https://api.sendgrid.com`; las subcuentas regionales de la UE requieren adaptar el endpoint.

El envío tiene un timeout de diez segundos. No hay reintentos automáticos ni cola: si la respuesta del proveedor se pierde, el usuario debe solicitar un nuevo enlace después del período de espera. Los límites son por cuenta; para un lanzamiento público con riesgo de abuso masivo, complementa con límites en el borde/CAPTCHA según el tráfico.

Referencias: [Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send), [autenticación](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication), [remitentes verificados](https://www.twilio.com/docs/sendgrid/api-reference/sender-verification/create-verified-sender-request).
