# Foliovio Backend

Repositorio independiente de la API de Foliovio: Node.js, Hono, SQLite y suscripciones por usuario. No sirve el frontend ni necesita su código para instalarse, compilarse o ejecutarse.

## Desarrollo

Requiere Node.js 22.13 o superior y npm 10 o superior. Desde este repositorio:

```bash
npm ci
cp .env.example .env
npm run dev
```

En PowerShell, `Copy-Item .env.example .env`. El servidor escucha en `http://localhost:3001`; `GET /api/health` comprueba disponibilidad. Node carga `.env` en desarrollo y producción. El frontend se inicia desde su repositorio, en otra terminal.

| Comando | Función |
| --- | --- |
| `npm run dev` | Ejecutar TypeScript y reiniciar ante cambios |
| `npm run build` | Compilar el servidor a `dist/` |
| `npm start` | Ejecutar el JavaScript compilado |
| `npm test` | Probar API, aislamiento entre usuarios, migración y webhooks |
| `npm run lint` | Análisis estático del backend |

## Estructura

```text
src/
  app.ts                 Construcción de la API
  index.ts               Arranque del servidor
  config.ts              Variables de entorno
  db.ts                  SQLite y migraciones
  contracts/api.d.ts     Tipos públicos del contrato HTTP
  modules/auth/          Registro, login y sesión
  modules/subscriptions/ Plan, consumo, administración y Polar
test/                    Pruebas con SQLite en memoria
data/                    Base local, ignorada por Git
```

Cada cuenta tiene su propio registro de suscripción, estado, vencimiento y referencia de proveedor. La primera solicitud de exportación es gratuita; Pro permite solicitudes ilimitadas mientras esté vigente. Las rutas de usuario toman el ID de la sesión, nunca de un `userId` enviado por el cliente. La autorización y el consumo de exportaciones son transaccionales.

## Configuración

Consulta `.env.example`. En producción:

- Define `NODE_ENV=production`, `JWT_SECRET` aleatorio de al menos 32 caracteres y `APP_ORIGIN` con la URL exacta del frontend.
- Monta un volumen persistente y configura `DATABASE_PATH=/data/foliovio.db`. Por defecto se usa `data/foliovio.db` dentro de este repositorio. Las rutas relativas explícitas son relativas al directorio de ejecución.
- Configura `ADMIN_SECRET` para habilitar administración manual. Vacío deshabilita esas rutas.
- Configura `POLAR_WEBHOOK_SECRET` y `POLAR_PRODUCT_ID` para recibir eventos de Polar.
- Usa HTTPS. `COOKIE_SAME_SITE=lax` funciona con el mismo origen o subdominios del mismo sitio; `none` requiere producción y cookies seguras para sitios distintos. Algunos navegadores bloquean cookies de terceros: un dominio compartido o proxy `/api` evita esa dependencia.

SQLite necesita una única instancia de escritura con almacenamiento persistente. Para múltiples réplicas debe migrarse a una base compartida.

## API y administración de suscripciones

| Método y ruta | Acceso | Función |
| --- | --- | --- |
| `GET /api/health` | Público | Disponibilidad |
| `POST /api/auth/register` | Público | Crear cuenta con `email`, `password`, `name` |
| `POST /api/auth/login` | Público | Iniciar sesión con `email`, `password` |
| `POST /api/auth/logout` | Cookie | Cerrar sesión |
| `GET /api/auth/me` | Cookie | Usuario y plan, o `user: null` |
| `GET /api/billing/subscription` | Usuario | Consultar su suscripción |
| `POST /api/billing/export` | Usuario | Autorizar y consumir una exportación |
| `POST /api/billing/activate` | Usuario, desarrollo | Activar Pro de prueba |
| `GET /api/admin/subscriptions/:userId` | `x-admin-secret` | Consultar una cuenta |
| `POST /api/admin/grant` | `x-admin-secret` | Agregar 30 días de Pro manual |
| `POST /api/admin/revoke` | `x-admin-secret` | Revocar Pro manual |
| `POST /api/webhooks/polar` | Firma | Sincronizar Polar |

Las rutas administrativas `grant` y `revoke` reciben `{"userId":"..."}` o `{"email":"cliente@email.com"}`. Ejemplo en PowerShell:

```powershell
$headers = @{ 'x-admin-secret' = $env:ADMIN_SECRET }
Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/admin/grant `
  -Headers $headers -ContentType application/json -Body '{"email":"cliente@email.com"}'
```

El contrato de respuestas está en `src/contracts/api.d.ts`; las fechas públicas son milisegundos desde Unix epoch. El frontend mantiene su propia copia para no necesitar un tercer repositorio o paquete privado. Mantén compatible la API o coordina la actualización del cliente cuando cambies el contrato. Esta entrega permite administración por API, sin panel administrativo ni portal de autoservicio.

## Polar

Configura un producto recurrente y un endpoint **Raw** en `https://api.ejemplo.com/api/webhooks/polar`. Suscríbelo a `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked` y `subscription.past_due`. También se aceptan `subscription.cycled`, `subscription.paused` y `subscription.resumed` si tu versión los ofrece.

El cliente debe registrarse antes del pago y usar el mismo email en el checkout. La primera notificación vincula el usuario; las siguientes usan el ID de suscripción de Polar. Se valida firma y fecha de entrega, producto permitido, duplicados y versiones antiguas. Un usuario inexistente o una segunda suscripción activa devuelve `409` para conciliación y reenvío desde Polar.

Una cancelación conserva acceso hasta terminar el período pagado; mora y revocación quitan Pro. Las activaciones manuales agregan 30 días; Polar informa el período real. Las suscripciones vinculadas a Polar se administran en Polar: las rutas manuales devuelven `409` para mantener permisos y cobros sincronizados. El parámetro de retorno del checkout no activa Pro.

Referencia: [validación y entrega de webhooks](https://polar.sh/docs/integrate/webhooks/delivery). Verifica pagos y bajas en el sandbox del proveedor antes de producción; las pruebas locales usan eventos sintéticos firmados.

## Despliegue y migración

Clona solamente este repositorio. Instala con `npm ci`, compila con `npm run build` y arranca con `npm start`. No se necesitan workspaces ni archivos del frontend. Hay un workflow de CI y un lockfile propios.

Para conservar datos de la versión anterior:

1. Detén el backend anterior y respalda la base SQLite de forma consistente.
2. Apunta `DATABASE_PATH` a la base existente mediante una ruta absoluta, o copia el respaldo a `data/foliovio.db` de este repositorio. No se trasladan automáticamente datos ni secretos.
3. Copia las variables de backend a su nuevo `.env`, conservando `JWT_SECRET` para mantener sesiones. Verifica `APP_ORIGIN`.
4. Arranca solo el nuevo backend. La migración versionada importa `users.premium_until` a `subscriptions` una vez; si ya se ejecutó en el monorepo, no vuelve a importar ni reinicia el consumo.
5. Actualiza la URL de API en el frontend y la URL del webhook en Polar cuando cambien los dominios.

No ejecutes simultáneamente el backend antiguo y el nuevo sobre la misma base. La columna antigua `premium_until` se conserva, pero ya no se actualiza para autorizar Pro; para volver al código antiguo restaura su respaldo de datos correspondiente.

## Procedencia

Extraído del estado local de `dev` de Foliovio el 6 de octubre de 2026, incluyendo los cambios posteriores al commit `c3c8f24`. El historial original permanece en `foliovio`; este repositorio inicia su propia historia. No se copiaron secretos, datos ni artefactos compilados.
