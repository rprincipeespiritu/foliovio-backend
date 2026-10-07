# Flujo dev → prd → Railway

## Trabajo actual

- Los dos repositorios se desarrollan en `dev`.
- PostgreSQL es la única base en desarrollo, pruebas y producción.
- `prd` se reserva para versiones aprobadas. No se cambia de rama ni se despliega durante el desarrollo actual.
- El CI comprueba pushes y PRs hacia `dev` y `prd`. Incluye pruebas contra PostgreSQL 18 y construcción de la imagen Docker.

Cuando se autorice una versión, crea o actualiza `prd` a través de un PR desde `dev` en cada repositorio. Revisa compatibilidad del contrato HTTP, pruebas y migraciones antes de fusionar. Si `prd` todavía no existe, créala como parte de esa primera promoción. Git y los entornos de Railway son conceptos separados: configurar `NODE_ENV=production` no selecciona una rama.

## Servicios que se configurarán en Railway

En un mismo proyecto y entorno de producción:

1. **Postgres**: servicio PostgreSQL persistente.
2. **backend**: repositorio `backend-foliovio`, rama de autodespliegue `prd`, raíz `/` y Dockerfile incluido.
3. **frontend**: repositorio `frontend-foliovio`, rama de autodespliegue `prd`, raíz `/` y su Dockerfile.

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

Configura `API_UPSTREAM=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:3001`, sustituyendo `backend` por el nombre real del servicio. Asigna un dominio público al frontend. Caddy escucha en `PORT`, sirve la aplicación y reenvía `/api/*` sin quitar el prefijo.

La imagen construye la aplicación con `VITE_API_URL` vacío; no configures una dirección privada en una variable `VITE_*`. Caddy conecta al backend en tiempo de ejecución, cuando la red privada está disponible. `VITE_PRICE`, `VITE_CHECKOUT_URL`, `VITE_WHATSAPP` y `VITE_CONTACT_EMAIL` se incorporan durante el build y necesitan reconstrucción al cambiar.

El navegador se comunica siempre con el dominio del frontend. Esto permite cookies de sesión del mismo origen y mantiene el backend como un servicio separado. El webhook de Polar puede usar `https://DOMINIO-FRONTEND/api/webhooks/polar`, que Caddy reenvía al backend. No hace falta publicar un dominio del backend para este esquema.

## Primera publicación, cuando corresponda

1. Publicar los repositorios y preparar los PRs `dev` → `prd` con CI aprobado.
2. Configurar los servicios, PostgreSQL y las variables del entorno de producción.
3. Fusionar los PRs aprobados; Railway construirá las imágenes desde `prd`.
4. Comprobar `/healthz` del frontend y `/api/health` a través de su dominio.
5. Verificar registro, sesión, primera descarga y reglas de Pro. Configurar y comprobar pagos solo cuando se habiliten.

Esta documentación y los archivos de configuración no crean servicios, remotos, ramas ni despliegues por sí mismos.

Referencias: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [configuración como código](https://docs.railway.com/config-as-code), [autodespliegues de GitHub](https://docs.railway.com/deployments/github-autodeploys).
