# Suscripciones con Paddle Billing

La integración está preparada para un único precio recurrente mensual de Foliovio Pro. El producto, las credenciales y la verificación comercial del vendedor se configuran en Paddle. No se crean automáticamente ni se realizan cobros durante las pruebas del repositorio.

## Crear el plan en sandbox

1. Crea una cuenta de [Paddle Sandbox](https://sandbox-vendors.paddle.com/). Es independiente de la cuenta live.
2. En el catálogo crea el producto **Foliovio Pro** y un precio **mensual**, frecuencia **1**. Por ejemplo, PEN 19.00 (importe de API `1900`). Usa el precio comercial que decidas; la app consulta el precio base real. Desactiva el trial si quieres cobrar desde el primer día.
3. Copia el ID del precio `pri_...` en `PADDLE_PRICE_ID`. El ID del producto `pro_...` no sirve para esta variable.
4. En **My account → Settings → Authentication → API keys**, crea una API key con permisos `price.read`, `customer.write`, `transaction.write` y `customer_portal_session.write`. Los permisos de escritura incluyen lectura. Guárdala en `PADDLE_API_KEY`. En la pestaña **Client-side tokens**, crea un token que empieza por `test_` y úsalo en `PADDLE_CLIENT_TOKEN`; copia el token, no su ID `ctkn_...`.
5. En **Checkout → Checkout settings**, configura el default payment link con la URL del frontend, por ejemplo `https://www.foliovio.com`. El dominio live debe estar aprobado por Paddle. En local usa `http://localhost:5173` en sandbox. La página inicial carga Paddle.js al recibir un enlace `?_ptxn=...`.
6. En **Events → Notifications → New destination**, crea un destino webhook de tipo URL y uso **Platform and simulation**. Usa la URL pública del entorno de pruebas con la integración desplegada. Selecciona como mínimo `subscription.created` y `subscription.updated`; también se admiten `subscription.activated`, `subscription.trialing`, `subscription.canceled`, `subscription.paused`, `subscription.resumed` y `subscription.past_due`. Copia el secreto de ese destino en `PADDLE_WEBHOOK_SECRET`.

## Variables del backend

```dotenv
PADDLE_ENVIRONMENT=sandbox
PADDLE_API_KEY=REEMPLAZAR_POR_API_KEY_PRIVADA
PADDLE_CLIENT_TOKEN=REEMPLAZAR_POR_CLIENT_TOKEN_test_
PADDLE_WEBHOOK_SECRET=REEMPLAZAR_POR_SECRETO_DEL_DESTINO
PADDLE_PRICE_ID=REEMPLAZAR_POR_ID_pri_
APP_ORIGIN=https://www.foliovio.com
```

Todas se configuran en **Railway → foliovio-backend → Variables**, o en `.env` del backend para desarrollo. No copies los ejemplos `REEMPLAZAR...` literalmente: deja los campos vacíos hasta obtener los valores reales. No se necesitan variables `VITE_PADDLE_*`, argumentos Docker nuevos ni claves privadas en el frontend. `GET /api/billing/config` publica solamente habilitación, entorno, token público y precio. Sin las credenciales completas, la aplicación sigue operativa y el checkout de Paddle queda deshabilitado.

El precio de Paddle se muestra en el cuadro de suscripción. `VITE_PRICE` sigue siendo el texto comercial del encabezado y debe coincidir con el plan configurado. El checkout determina impuestos, moneda y total final. Al activar Paddle, el cuadro usa Paddle en lugar del enlace anterior de Polar y de los enlaces manuales. Vacía `VITE_CHECKOUT_URL` al retirar ese enlace comercial.

### URL del webhook

Con el proxy de Railway puedes usar:

```text
https://www.foliovio.com/api/webhooks/paddle
```

También puedes usar el dominio público del backend seguido de `/api/webhooks/paddle`. No uses el dominio privado `railway.internal`. Para pruebas locales necesitas un túnel HTTPS hacia el backend: `https://TU-TUNEL/api/webhooks/paddle`. `APP_ORIGIN` sigue siendo la URL del frontend.

## Comportamiento

- El comprador inicia sesión y confirma su correo antes de comprar. El backend fija el precio y vincula el cliente de Paddle al usuario de la sesión. No acepta `userId`, precio, importe ni email del cuerpo del checkout.
- La relación cliente/usuario se guarda por entorno. Los webhooks usan esa relación, nunca el email ni `custom_data` como autorización. No se vinculan automáticamente compras hechas fuera del flujo de la app.
- `POST /api/billing/checkout` crea la transacción y reutiliza una transacción abierta para evitar compras por doble clic. Una transacción completada bloquea otra compra hasta recibir el webhook. Un timeout de red al crear una transacción puede requerir conciliación en Paddle antes de reintentar; no hay garantía distribuida de exactamente una creación.
- El navegador abre el checkout oficial. El evento de checkout terminado solo inicia una consulta del plan durante unos 30 segundos. El servidor concede Pro únicamente mediante el webhook firmado. Si demora, la interfaz pide esperar y evita sugerir otro pago.
- Se verifica HMAC-SHA256 sobre el cuerpo original con tolerancia de 5 segundos. PostgreSQL deduplica `event_id` de forma transaccional y compara `occurred_at` para evitar retrocesos. Eventos fallidos revierten su marca y pueden reenviarse.
- `active` y `trialing` dan Pro hasta `current_billing_period.ends_at`. Una cancelación programada mantiene el acceso hasta la fecha efectiva; `canceled` lo retira inmediatamente. `past_due` y `paused` suspenden Pro. Al recuperar el pago o reanudar la suscripción se actualiza de nuevo. La política de esta app no ofrece un período de gracia por mora.
- **Mi cuenta → Gestionar suscripción y pagos** abre el portal alojado por Paddle para cancelar, actualizar medios de pago y consultar comprobantes. Se genera una sesión temporal para el usuario autenticado y nunca se cachea la URL. La app refresca el plan al recuperar el foco.
- Las cuentas y planes anteriores se conservan. La migración 3 amplía proveedores y crea `paddle_customers`. Las acciones manuales/locales no pueden modificar una suscripción de Paddle o Polar. Un proveedor no puede sobrescribir al otro.
- No se migran contratos ni tarjetas de Polar a Paddle. Cancela/coordina el contrato anterior antes de migrar una cuenta. Reembolsar una transacción no equivale a cancelar la suscripción: gestiona también la cancelación en Paddle cuando corresponda.

## Validar antes de producción

Usa una base de datos y un entorno Railway separados para sandbox. No pruebes con tarjetas reales. Crea dos cuentas verificadas y realiza un pago con los [datos de prueba de Paddle](https://developer.paddle.com/concepts/payment-methods/credit-debit-card/): solo el comprador debe obtener Pro. Verifica el webhook entregado, la fecha del período, renovación, cancelación programada, cancelación efectiva, mora y recuperación. Comprueba el portal y el reenvío de un mismo evento. El simulador debe utilizar un customer ID vinculado y el precio configurado; un evento genérico no concede acceso.

Para live, termina la aprobación de Paddle, crea producto/precio y credenciales **live**, cambia `PADDLE_ENVIRONMENT=production` y usa el token `live_...` y el secreto del destino live. Publica ambos repositorios de `dev` a `prd` después de validar sandbox. Los permisos sandbox no otorgan Pro cuando el backend usa production. No reutilices la base de sandbox: las vinculaciones se mantienen separadas y una suscripción de otro entorno bloquea compras para evitar mezclas.

### Diagnóstico

- **Checkout no disponible:** completa las cinco variables y comprueba permisos, precio activo mensual y dominio autorizado. Las claves privadas no se registran en logs; los rechazos de API muestran solo el código HTTP.
- **409 al comprar:** ya existe un plan o hay un pago pendiente. Consulta el portal y el estado de la transacción; no crees otro cobro manualmente.
- **401 en webhook:** secreto incorrecto, reloj del servidor desajustado o cuerpo modificado. Usa el secreto del destino, no la API key.
- **409 en webhook:** cliente sin vínculo o conflicto con otra suscripción. Conciliar antes de reenviar desde Notifications.
- **Pago aceptado pero sin Pro:** revisa Notifications, los eventos suscritos y la coincidencia del Price ID. Reenvía el evento fallido. No hay conciliación periódica automática; Paddle reintenta y los eventos pueden reenviarse desde su panel.

Las pruebas automatizadas usan PostgreSQL real con esquemas aislados, eventos HMAC sintéticos y un transporte Paddle simulado. No sustituyen la compra de prueba en sandbox con tus credenciales.

Referencias oficiales: [checkout con transacción](https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/), [firmas](https://developer.paddle.com/webhooks/about/signature-verification/), [estados de suscripción](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/), [portal](https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session/).
