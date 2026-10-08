# Despliegue en Render

Guía completa para levantar CubaPoker. Un servicio, no dos: el mismo proceso Node sirve la
API **y** la web del Mini App.

---

## 0. Lo primero, y evita media hora de confusión

**Hay UN solo servicio.** No se despliega el backend y el frontend por separado.

`src/bot.ts:30` sirve el Mini App desde el propio proceso:

```ts
app.use(express.static(path.join(__dirname, '../mini-app/dist')));
```

Y `render.yaml` ya compila ambas cosas en el mismo `buildCommand`. Crear un segundo
servicio serían 7 USDT/mes para un sitio que no hace falta.

---

## 1. Lo que necesitas antes de tocar Render

| Qué | Dónde se saca | Nota |
|---|---|---|
| Token del bot | `@BotFather` → `/newbot` | Lo único que no se puede automatizar |
| MongoDB | [Atlas](https://www.mongodb.com/atlas) | El tier M0 gratis sirve |
| Cuenta de Render | render.com | Con tarjeta, para el plan de pago |

No hace falta tarjeta de empresa ni pasarela para arrancar. Ver
[Payments](#7-pagos) más abajo.

---

## 2. MongoDB Atlas

Crea un cluster **M0** (gratis) y una base de datos dentro.

### 2.1 Abrir el acceso a la red

Esto es el paso que más falla y el mensaje de error no lo aclara: si Atlas no acepta la IP
de Render, el servicio arranca y se cae al intentar conectar, y el log dice un timeout sin
más.

En **Network Access**, añade:

```
0.0.0.0/0
```

Render no tiene IP fija de salida, así que hay que abrir para todo. No es lo ideal, pero es
lo único que funciona con su infraestructura. El acceso sigue protegido por usuario y
contraseña.

### 2.2 La URI

Cópiala desde **Connect → Drivers**. Tiene esta forma:

```
mongodb+srv://USUARIO:CONTRASENA@cluster0.xxxxx.mongodb.net/cubapoker?retryWrites=true&w=majority
```

**Copia la del driver de Node**, no la de Compass: los drivers de otras aplicaciones pueden tener formatos
distintos.

---

## 3. El bot en @BotFather

1. `@BotFather` → `/newbot` → nombre → username → **te da el token**. Guárdalo.
2. `@BotFather` → `/newapp` (o `/setmenubutton`)
3. **URL del Mini App**: `https://TU-SERVICIO.onrender.com`
   - Debe terminar en la **raíz**. Sin `/game`, sin `/deposit`.
   - El código ya le añade el sufijo: `${MINI_APP_URL}/game`, `/freeroll`, `/deposit`…
4. BotFather te devuelve una URL de la web de pruebas. Ábrela y te devuelve una URL de prueba.

---

## 4. El servicio en Render

### Opción A · desde el `render.yaml` (recomendada)

1. New → **Blueprint**
2. Apunta al repositorio
3. Render detecta `render.yaml` y crea el servicio con el plan y el build command correctos

### Opción B · manual

New → Web Service → apunta al repo. **Build Command**:

```bash
npm install && npm run build && cd mini-app && npm install && npm run build
```

**Start Command**:

```bash
node dist/bot.js
```

**Health Check Path**:

```
/health
```

### El plan

`render.yaml` dice `plan: starter` (7 USDT/mes), y no es capricho.

El plan **gratis suspende el servicio a los 15 minutos de inactividad**. Para un bot de poker
eso no es un inconveniente menor, es el producto roto:

- Un campo de 300 tarda horas en terminar. Si el proceso se suspende a mitad, las mesas
  quedan con fichas de jugadores bloqueadas y el campo no se puede ni continuar ni cerrar.
- Los bots de poker son justo el caso que Render suspende: hacen trabajo de temporizador y
  llamadas HTTP esporádicas, no tráfico constante.

**Un CubaPoker suspendido no pierde clientes con abogado; uno que se cae a mitad de un campo
sí.** Verifica que el servicio real está en `starter`, no en `free`.

---

## 5. Variables de entorno

En **Environment** del servicio. `render.yaml` deja varias como `sync: false`, o sea
**vacías a propósito**, y las tienes que poner tú.

### Las cinco obligatorias

| Variable | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | El de @BotFather |
| `MONGODB_URI` | La URI del paso 2 |
| `MINI_APP_URL` | `https://TU-SERVICIO.onrender.com` — **sin barra final** |
| `ADMIN_API_KEY` | Generada. **Anótala**: sin ella las rutas de operador quedan deshabilitadas |
| `SIMULATION_SECRET` | Generada |

### Las que ya vienen puestas

| Variable | Valor en el blueprint | Por qué |
|---|---|---|
| `NODE_ENV` | `production` | Activa el webhook y **bloquea el bypass de desarrollo** |
| `SIMULATE_PAYMENTS` | `true` | No se mueve dinero real |
| `DEV_AUTH_BYPASS` | `false` | Nunca en producción |
| `PORT` | `10000` | Render lo inyecta |

### Opcionales

| Variable | Para qué |
|---|---|
| `TRONGRID_API_KEY` | Consultar la cadena TRON para detectar depósitos reales |
| `USDT_CONTRACT_ADDRESS` | Verifícala antes: multiplicar con una dirección equivocada es un robo directo |
| `TELEGRAM_WEBHOOK_SECRET` | Verifica la firma del webhook. Recomendado |
| `ALLOW_SIMULATED_WITHDRAWALS` | **Déjala en `false`**. Ver [Payments](#7-pagos) |

---

## 6. Arrancar, y por qué el bot puede parecer mudo

### 6.1 Comprobar que vive

```bash
curl https://TU-SERVICIO.onrender.com/health
# {"status":"ok","service":"cubapoker-telegram-bot","timestamp":"..."}
```

Si esto responde, el proceso está vivo.

### 6.2 Registrar el webhook — **este paso no se puede saltar**

En producción el bot **no usa polling, usa webhook**. Sin esto, el bot no recibe ni un
mensaje aunque `/health` responda y el deploy esté en verde.

Visita **una vez**:

```
https://TU-SERVICIO.onrender.com/telegram/setup
```

Debe devolver:

```json
{"success":true,"webhook":"https://TU-SERVICIO.onrender.com/telegram/webhook"}
```

**Vuelve a hacerlo cada vez que cambies el dominio o redespliegues con otra URL.**

### 6.3 Probar

Abre el bot en Telegram y pulsa **▶ Jugar**.

---

## 7. Pagos

Con el blueprint tal cual, el sistema **no puede mover dinero real**:

- `SIMULATE_PAYMENTS=true` — las pasarelas no mueven nada, hay una pantalla de prueba.
- `ALLOW_SIMULATED_WITHDRAWALS` sin definir (`false`) — **no se puede aprobar un retiro**.

El segundo está ahí por un motivo que conviene entender. Aprobar un retiro **no mueve
dinero**: marca la orden como pagada y descuenta el saldo, porque el envío lo hace el
operador por fuera. Sin freno, en modo simulación una orden es indistinguible de una real:
el operador ve "liquidado" y paga USDT de verdad. Ese dinero no sale de ningún sitio.

Para pasar a producción haría falta:

1. `SIMULATE_PAYMENTS=false`
2. `ALLOW_SIMULATED_WITHDRAWALS` — déjalo en `false` igualmente
3. Credenciales de la pasarela real: EnZona, QvaPay o epusdt. **Requieren cuenta de empresa**
4. `TRONGRID_API_KEY` + `USDT_CONTRACT_ADDRESS` para los depósitos en TRC20
5. Revisión legal por abogado

**No pongas `SIMULATE_PAYMENTS=false` hasta que haya una pasarela real conectada.** En
`render.yaml` está puesto `true` a propósito, y hay un aviso en el panel de operador que lo
recuerda.

---

## 8. Comprobación completa antes de enseñárselo a alguien

En orden. Cada paso depende del anterior.

```bash
S=https://TU-SERVICIO.onrender.com
KEY=TU_ADMIN_API_KEY
```

| # | Qué | Cómo | Esperado |
|---|---|---|---|
| 1 | El proceso vive | `curl $S/health` | `status: ok` |
| 2 | El webhook está | `curl $S/telegram/setup` | `success: true` |
| 3 | Hay base de datos | Abre el bot y pulsa Jugar | Se abre la web |
| 4 | Estás en simulación | `curl -H "x-admin-key: $KEY" $S/api/admin/overview` | `"modoSimulacion": true` |
| 5 | El panel responde | `curl -H "x-admin-key: $KEY" $S/api/admin/overview` |(JSON con usuarios y acciones pendientes) |

Si el paso 4 o el 5 falla con 403, `ADMIN_API_KEY` no está puesta o no coincide. Si no está
definida, las rutas administrativas quedan **deshabilitadas**, que es lo correcto.

---

## 9. Problemas que ya sabemos que pasan

### El bot no recibe mensajes, pero `/health` va bien

Falta el paso 6.2. El webhook no se registra solo.

### Arranca y se cae

Casi siempre es MongoDB. Mira el log:

- `MongoServerSelectionError` / timeout → **Atlas no acepta la IP de Render**. Paso 2.1.
- `Authentication failed` → la URI tiene mal el usuario o la contraseña. O le falta el
  `?retryWrites=true&w=majority`.

### El Mini App sale en blanco

El `buildCommand` no terminó de compilar la web. Se compila en el mismo comando del backend;
si falla ahí, el bot funciona pero no hay interfaz. Mira el log del build.

### `Sesión expirada / solo funciona dentro de Telegram`

Correcto, y es lo que debe pasar. Un Mini App abierto en un navegador no trae `initData`,
así que no hay forma de validar quién eres. **Se prueba dentro de Telegram**, nunca en el
navegador.

Para trabajar en la interfaz sin desplegar, ver [DEV.md](DEV.md).

### Las manos no avanzan

El bot muestra las fichas quietas. Pasa cuando el campo tiene pocos jugadores y no llega a
`fieldSize`. Para verlo ahora, `scripts/dev-fill-field.js` llena un campo de verdad.

### Un campo no termina

El campo se queda con 2 jugadores y no reparte el premio. **Es un bug abierto**, no una
cosa de configuración. Está documentado en
[LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) §3-bis-cuarta con lo que ya se descartó.

---

## 10. Redespiegue

Render **no actualiza solo**. Después de un `git push`:

Render → tu servicio → **Manual Deploy** → **Deploy latest commit**

Sin esto estás probando la versión anterior, y los errores que arreglaste siguen ahí.

Si cambias el dominio o la `MINI_APP_URL`, repite el paso 6.2.

---

## 11. Cosas que no hay que hacer

- **No pongas `SIMULATE_PAYMENTS=false` sin pasarela real.** El sistema se queda sin poder
  cobrar ni devolver nada, y es el peor sitio para descubrirlo.
- **No actives `ALLOW_SIMULATED_WITHDRAWALS` para "probar rápido".** Requiere también
  `confirmarSimulado: true` en cada petición, y existe para cuando pagues de verdad a
  propósito. Si se liquida, sale un aviso con nivel ERROR.
- **No quites `DEV_AUTH_BYPASS=false`.** En producción está bloqueado por `NODE_ENV`, así
  que quitarlo no cambia nada; si someday `NODE_ENV` no fuera `production`, sería un
  agujero por el que cualquiera suplanta cualquier cuenta.
- **No apuntes el `.env` de desarrollo a la base de producción.** Para desarrollo, una base
  aparte.
- **No subas `WEB_CONCURRENCY` a 2.** Este es el mas importante de los cinco.

  `withTableLock` (por mesa) y `withFieldLock` (por campo) son cerrojos **en memoria**: un
  `Map` del proceso. Serializan escrituras **dentro** de una instancia, y no entre dos.

  Por eso el servicio corre con una sola instancia. Con dos, dos registros simultaneos
  pueden tocar el mismo documento a la vez y el `$inc` de uno se pierde bajo el `save()` del
  otro. Medido: 20 registros concurrentes dejaron el bote del campo en **1.000 unidades de
  20.000**, con 19.000 de jugadores dentro que no estaban en ninguna parte.

  El indice unico `un_campo_vivo_por_nivel` **no** lo evita: ese indice impide abrir dos
  campos del mismo nivel, que es otro fallo. Las escrituras perdidas son suyas.

  Para mas de una instancia haria falta un cerrojo en la base de datos, o un unico duenno de
  las escrituras (por ejemplo, que solo el bucle del motor escriba en el campo y las rutas
  HTTP manden intenciones en vez de escribir). Es un cambio de arquitectura, no un flag.

- **No quites el indice `un_campo_vivo_por_nivel`.** Es lo unico que impide que 20 personas
  pulsando JUGAR a la vez abran 18 campos y cobren 18 veces. Si `scripts/asegurar-indices.js`
  dice que no existe, el sistema sigue arrancando y parece que todo va bien, solo que ya
  no. Correlo en cada despliegue.