# Foliovio Backend

Repositorio independiente de la API de Foliovio: Node.js, Hono, PostgreSQL y suscripciones por usuario. No sirve el frontend ni necesita su código para instalarse, compilarse o ejecutarse.

## Desarrollo

Requiere Node.js 22.13 o superior, npm 10 o superior y PostgreSQL (probado con PostgreSQL 18). Desde este repositorio:

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

En PowerShell, `Copy-Item .env.example .env`. Antes de migrar o iniciar, crea la base y ajusta `DATABASE_URL` en `.env` con tus credenciales. El servidor escucha en `http://localhost:3001`; `GET /api/health` comprueba la conexión a PostgreSQL y responde `503` si no está disponible. Node carga `.env` en desarrollo y producción. El frontend se inicia desde su repositorio, en otra terminal.

Si ya tienes PostgreSQL instalado, puedes crear el usuario y las bases desde psql o pgAdmin con una cuenta administradora (sustituye la contraseña):

```sql
CREATE ROLE foliovio LOGIN PASSWORD 'TU_CLAVE_LOCAL';
CREATE DATABASE foliovio OWNER foliovio;
CREATE DATABASE foliovio_test OWNER foliovio;
```

```dotenv
DATABASE_URL=postgresql://foliovio:TU_CLAVE_LOCAL@localhost:5432/foliovio
TEST_DATABASE_URL=postgresql://foliovio:TU_CLAVE_LOCAL@localhost:5432/foliovio_test
```

Codifica los caracteres especiales de usuario/contraseña para una URL. La aplicación requiere `DATABASE_URL` al iniciar. PostgreSQL es la única base de datos del proyecto, tanto en desarrollo como en producción.

Alternativamente, con Docker instalado, `docker compose up -d postgres` crea PostgreSQL 18 y ambas bases usando las credenciales locales de `.env.example`. El puerto 5432 se publica solo en localhost. Si tu instalación local ya usa ese puerto, usa esa instalación o cambia el puerto del Compose y las URLs. `POSTGRES_PASSWORD` permite sustituir la contraseña del contenedor en su primera inicialización. Los datos se guardan en un volumen; `docker compose down` lo conserva. El script que crea `foliovio_test` se ejecuta solo al inicializar un volumen vacío. No uses la contraseña de ejemplo en producción.

| Comando | Función |
| --- | --- |
| `npm run dev` | Ejecutar TypeScript y reiniciar ante cambios |
| `npm run build` | Compilar el servidor a `dist/` |
| `npm start` | Ejecutar el JavaScript compilado |
| `npm test` | Probar API, aislamiento entre usuarios, migración y webhooks |
| `npm run lint` | Análisis estático del backend |
| `npm run db:migrate` | Compilar y aplicar el esquema PostgreSQL |

## Estructura

```text
src/
  app.ts                 Construcción de la API
  index.ts               Arranque del servidor
  config.ts              Variables de entorno
  db.ts                  Pool PostgreSQL, transacciones y migraciones
  migrate.ts             Comando de migración del esquema
  contracts/api.d.ts     Tipos públicos del contrato HTTP
  modules/auth/          Registro, login y sesión
  modules/subscriptions/ Plan, consumo, administración y Polar
test/                    Pruebas de integración sobre PostgreSQL real
compose.yaml             PostgreSQL local opcional con Docker
```

Cada cuenta tiene su propio registro de suscripción, estado, vencimiento y referencia de proveedor. La primera solicitud de exportación es gratuita; Pro permite solicitudes ilimitadas mientras esté vigente. Las rutas de usuario toman el ID de la sesión, nunca de un `userId` enviado por el cliente. Activación, revocación y consumo bloquean la fila del usuario con `FOR UPDATE` dentro de una transacción para serializar cambios, incluso entre varias instancias del backend. Las entregas de webhooks se registran atómicamente; una falla revierte también su marca de procesamiento.

## Configuración

Consulta `.env.example`. En producción:

- Define `NODE_ENV=production`, `JWT_SECRET` aleatorio de al menos 32 caracteres y `APP_ORIGIN` con la URL exacta del frontend.
- Configura `DATABASE_URL` con la conexión de PostgreSQL. En Railway, enlaza la variable de conexión del servicio PostgreSQL al backend; la base debe existir. Para conexiones externas usa el TLS y el certificado que indique el proveedor; una URL con `sslmode=verify-full` solicita verificación del certificado. No se deshabilita la verificación TLS en el código.
- Configura `ADMIN_SECRET` para habilitar administración manual. Vacío deshabilita esas rutas.
- Configura `POLAR_WEBHOOK_SECRET` y `POLAR_PRODUCT_ID` para recibir eventos de Polar.
- Usa HTTPS. `COOKIE_SAME_SITE=lax` funciona con el mismo origen o subdominios del mismo sitio; `none` requiere producción y cookies seguras para sitios distintos. Algunos navegadores bloquean cookies de terceros: un dominio compartido o proxy `/api` evita esa dependencia.

Varias réplicas de la API pueden compartir PostgreSQL. Cada proceso tiene un pool de hasta 10 conexiones: considera el total al dimensionar el servidor. No hace falta un volumen de datos en el backend; la persistencia y los respaldos pertenecen al servicio PostgreSQL.

Las migraciones se aplican automáticamente antes de escuchar solicitudes y también mediante `npm run db:migrate`. Un bloqueo transaccional coordina arranques simultáneos. El usuario de conexión necesita permiso para crear el esquema de tablas en la base de la aplicación. La versión se guarda en `schema_migrations`; ejecutarlas de nuevo conserva los datos.

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

## Ramas y Railway

El trabajo actual se realiza en `dev`. La rama `prd` se usará para los cambios aprobados y para los despliegues de producción en Railway. El pase se hará mediante un PR de `dev` a `prd` en cada repositorio cuando se decida publicar. No se promociona ni despliega automáticamente desde este trabajo local.

`Dockerfile` y `railway.json` preparan este servicio para Railway: compilación en una etapa independiente, ejecución con dependencias de producción y health check en `/api/health`. El arranque aplica las migraciones PostgreSQL antes de escuchar solicitudes. No necesita un volumen local ni archivos del frontend.

Consulta [la guía de Railway](docs/railway.md) para las variables, el flujo entre ramas y la conexión con el frontend. La rama de autodespliegue se selecciona en Railway; el archivo de configuración por sí solo no restringe qué rama puede desplegarse.

## Pruebas

Configura `TEST_DATABASE_URL` apuntando a una base exclusiva de pruebas y ejecuta `npm test`. Nunca se utiliza `DATABASE_URL` como fallback. Cada fixture crea un esquema `foliovio_test_<id>` aislado y lo elimina al terminar; necesita permiso `CREATE` sobre la base. No se truncan ni eliminan tablas ajenas a esos esquemas.

Se prueban registro y sesión, aislamiento entre cuentas, límites y activaciones concurrentes usando pools distintos, reintentos concurrentes de webhooks, rollback y migraciones repetidas. El workflow de CI arranca su propio servicio PostgreSQL 18. El linter y la compilación pueden ejecutarse sin conexión a una base.

## Procedencia

Extraído del estado local de `dev` de Foliovio el 6 de octubre de 2026, incluyendo los cambios posteriores al commit `c3c8f24`. Este repositorio mantiene su propia historia. No se copiaron secretos, datos ni artefactos compilados.
