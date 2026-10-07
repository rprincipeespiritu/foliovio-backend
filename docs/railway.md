# Flujo dev → prd → Railway

## Ramas y repositorios

- Los dos repositorios se desarrollan en `dev`.
- PostgreSQL es la única base en desarrollo, pruebas y producción.
- La primera rama `prd` parte de la versión validada de `dev`; las siguientes versiones se promocionan mediante PRs `dev → prd`.
- El CI comprueba pushes y PRs hacia `dev` y `prd`. Incluye pruebas contra PostgreSQL 18 y construcción de la imagen Docker.

Revisa compatibilidad del contrato HTTP, pruebas y migraciones antes de fusionar. Git y los entornos de Railway son conceptos separados: configurar `NODE_ENV=production` no selecciona una rama.

## Servicios en tu proyecto existente de Railway

Abre tu proyecto existente y selecciona el entorno de producción. Conserva los otros servicios que ya tengas. Configura los tres servicios de Foliovio en este mismo proyecto y entorno:

1. **Postgres**: servicio PostgreSQL persistente.
2. **backend**: repositorio `rprincipeespiritu/foliovio-backend`, rama de autodespliegue `prd`, raíz `/` y Dockerfile incluido.
3. **frontend**: repositorio `rprincipeespiritu/foliovio-frontend`, rama de autodespliegue `prd`, raíz `/` y su Dockerfile.

Si no tienes una base dedicada a Foliovio, agrégala desde **New → Database → PostgreSQL**. No reutilices la base de otra aplicación ni la de desarrollo local. Conserva su volumen y configura respaldos antes de recibir datos reales.

Crea o conecta cada servicio de aplicación desde **Settings → Source** con su repositorio GitHub. Selecciona `prd` antes de desplegar. Si no aparecen los repositorios, habilita acceso a ambos en la instalación de Railway de GitHub. Usa `/railway.json` y no sobrescribas los comandos build/start/pre-deploy: los Dockerfiles ya compilan e inician cada servicio.

En las opciones de origen de cada servicio selecciona `prd` explícitamente; `railway.json` define build y health check, pero no selecciona la rama de GitHub. Activa la espera de CI y protege `prd` en GitHub para exigir las verificaciones antes de fusionar. Si luego se despliega `dev` como staging, usa otro entorno con su propia base, dominios y secretos; nunca le asignes la base de producción.

## Variables del backend

| Variable | Valor previsto |
| --- | --- |
| `NODE_ENV` | `production` (también lo establece la imagen) |
| `PORT` | `3001`, explícito para que el frontend conozca el puerto privado |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`, ajustando `Postgres` al nombre real del servicio |
| `APP_ORIGIN` | URL HTTPS pública del frontend, por ejemplo `https://mi-frontend.up.railway.app` |
| `COOKIE_SAME_SITE` | `lax`, porque el navegador usa el proxy `/api` del frontend |
| `JWT_SECRET` | Secreto aleatorio de al menos 32 caracteres, estable entre despliegues |
| `ADMIN_SECRET` | Secreto administrativo; vacío deshabilita las rutas manuales |
| `POLAR_WEBHOOK_SECRET` | Secreto del webhook, cuando se habiliten pagos |
| `POLAR_PRODUCT_ID` | ID del producto Pro, cuando se habiliten pagos |

No subas `.env`. El backend escucha en `::` para aceptar tráfico de la red privada y usa el puerto configurado. Su health check `/api/health` consulta PostgreSQL. Las migraciones de esquema se aplican antes de aceptar tráfico y se coordinan entre instancias; no requieren una conexión de base durante el build.

## Variables del frontend

En **frontend → Variables**, configura:

```dotenv
PORT=8080
API_UPSTREAM=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}
VITE_PRICE=S/ 19
```

Sustituye `backend` por el nombre real del servicio si elegiste otro. En **Settings → Networking → Generate Domain**, genera un dominio público para el frontend con puerto destino **8080**. Usa esa URL HTTPS exacta como `APP_ORIGIN` del backend. Caddy escucha en `PORT`, sirve la aplicación y reenvía `/api/*` sin quitar el prefijo.

La imagen construye la aplicación con `VITE_API_URL` vacío; no configures una dirección privada en una variable `VITE_*`. Caddy conecta al backend en tiempo de ejecución, cuando la red privada está disponible. `VITE_PRICE`, `VITE_CHECKOUT_URL`, `VITE_WHATSAPP` y `VITE_CONTACT_EMAIL` se incorporan durante el build y necesitan reconstrucción al cambiar.

El navegador se comunica siempre con el dominio del frontend. Esto permite cookies de sesión del mismo origen y mantiene el backend como un servicio separado. El webhook de Polar puede usar `https://DOMINIO-FRONTEND/api/webhooks/polar`, que Caddy reenvía al backend. No hace falta publicar un dominio del backend para este esquema.

## Primera publicación

1. Comprueba que GitHub Actions haya aprobado el commit de `prd` en ambos repositorios.
2. Configura los servicios y las variables; genera el dominio del frontend.
3. Espera a que PostgreSQL esté disponible y despliega primero el backend.
4. Despliega el frontend. Railway construye ambos desde `prd`, usando sus Dockerfiles.
5. Comprueba `/` (interfaz), `/healthz` (texto `ok`), `/api/health` (`{"ok":true}`) y `/api/auth/me` sin sesión (`{"user":null}`) desde el dominio del frontend.
6. Verifica registro, entrada, avatar, confirmación de salida, primera descarga y reglas de Pro con una cuenta de prueba.

Para cargar las variables obligatorias del backend desde **Variables**, usa estos valores y reemplaza dominio y secreto:

```dotenv
NODE_ENV=production
PORT=3001
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_ORIGIN=https://TU-DOMINIO-FRONTEND.up.railway.app
COOKIE_SAME_SITE=lax
JWT_SECRET=REEMPLAZAR_POR_UN_SECRETO_ALEATORIO
```

Genera un secreto nuevo en tu terminal y copia el resultado solo al panel de Railway:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Mantén `JWT_SECRET` estable entre despliegues; cambiarlo invalida las sesiones. Genera otro secreto independiente si habilitas `ADMIN_SECRET`. No configures `TEST_DATABASE_URL` en Railway ni copies los secretos de desarrollo.

Comprueba las rutas desde PowerShell:

```powershell
$foliovioUrl = 'https://TU-DOMINIO-FRONTEND.up.railway.app'
Invoke-RestMethod "$foliovioUrl/healthz"
Invoke-RestMethod "$foliovioUrl/api/health"
Invoke-RestMethod "$foliovioUrl/api/auth/me"
```

Sin `VITE_CHECKOUT_URL`, `VITE_WHATSAPP` o `VITE_CONTACT_EMAIL`, la interfaz informa que las suscripciones aún no están disponibles. Configura y comprueba Polar siguiendo el README del backend antes de habilitar su enlace de compra. La activación Pro de prueba se bloquea en producción.

## Diagnóstico y siguientes versiones

- **502 en /api**: revisa el estado del backend y el nombre/puerto privados de `API_UPSTREAM`.
- **403 al entrar o registrarte**: `APP_ORIGIN` debe coincidir con el dominio HTTPS del frontend.
- **Backend no arranca**: revisa logs, `DATABASE_URL`, disponibilidad de PostgreSQL y longitud de `JWT_SECRET`.
- **Espera de CI**: revisa la ejecución de GitHub Actions del mismo commit que Railway intenta desplegar.

Continúa desarrollando en `dev` y publica las siguientes versiones mediante PRs `dev → prd`. Para volver atrás, redespliega una versión anterior compatible desde Railway; esto no revierte la base de datos. Las migraciones futuras destructivas requieren respaldo y un plan de recuperación.

Esta documentación y los archivos de configuración no crean servicios, remotos, ramas ni despliegues por sí mismos.

Referencias: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [configuración como código](https://docs.railway.com/config-as-code), [autodespliegues de GitHub](https://docs.railway.com/deployments/github-autodeploys).
