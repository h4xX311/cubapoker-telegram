# Cómo ver el juego y cómo publicarlo en Telegram

Dos cosas distintas, y confundirlas cuesta media hora. Esta es la versión corta.

---

## PARTE 1 · Ver el juego en el navegador, ahora mismo

Hay **dos servidores**, y cada uno sirve una cosa distinta:

| URL | Qué sirve | ¿Sirve para probar? |
|---|---|---|
| `localhost:5173` | La web en modo desarrollo (Vite) | **Sí. Ábrela en el navegador.** |
| `localhost:3000` | La web compilada de producción + la API | No en navegador: rechaza fuera de Telegram (es lo correcto) |

**Usa `localhost:5173` para trabajar en el navegador.**

### Los dos comandos, en dos terminales

**Terminal 1 — el backend (API + motor de poker), puerto 3000:**
```bash
cd C:\Users\La'Roch\cubapoker\telegram-bot
npm run dev
```
Espera a ver `CubaPoker escuchando en el puerto 3000`. Tarda hasta 30 segundos y **no dice nada mientras tanto** (ya lo arreglé, pero sigue siendo lento la primera vez).

**Terminal 2 — la web, puerto 5173:**
```bash
cd C:\Users\La\Roch\cubapoker\telegram-bot\mini-app
npm run dev
```
Espera a ver `ready in ...ms`.

**Luego abre `http://localhost:5173`** en el navegador.

### Por qué 5173 y no 3000

`localhost:3000` sirve la versión de **producción**, que comprueba que abras la app dentro de Telegram. Si no lo haces, dice:

> Sesión expirada · Esta aplicación solo funciona dentro de Telegram

**Ese mensaje es correcto y es lo que debe pasar.** Un Mini App abierto en un navegador no trae `initData`, así que no hay forma de saber quién eres. Permitirlo sería permitir que cualquiera se haga pasar por otro.

Vite (`:5173`) tiene el bypass de desarrollo: te deja probarlo en el navegador **sin** saltarse esa comprobación en producción. Nunca se ejecuta en el build real — el código desaparece al compilar.

**Un archivo, dos carpetas:** `telegram-bot` es el backend. `mini-app` es la web. Vite vive dentro de `mini-app`.

---

## PARTE 2 · Publicarlo para usarlo de verdad en Telegram

Esto es lo que quieres para que funcione dentro del bot. Ya está todo documentado en [DEPLOY.md](DEPLOY.md); aquí va el camino directo.

### Un solo servicio

No se despliegan backend y web por separado. **El mismo proceso Node sirve la API y la web.** `render.yaml` compila ambas cosas. Crear un segundo servicio serían 7 USDT/mes para nada.

### Los pasos, en orden

**1 · Atlas** (base de datos). En **Network Access**, añade:
```
0.0.0.0/0
```
Esto es lo que más falla y el error no lo aclara: si Atlas no acepta la IP de Render, el servicio arranca y se cae al conectar, y el log solo dice "timeout". Render no tiene IP fija, hay que abrir para todo.

**2 · @BotFather**: `/newbot` → te da el token. Luego `/newapp` (o `/setmenubutton`) y pon como URL:
```
https://TU-SERVICIO.onrender.com
```
Sin barra final, sin `/game`. El código ya le añade el sufijo.

**3 · Render**: New → Blueprint → apunta al repo. `render.yaml` ya lleva el plan y el build command. **Verifica que el plan es `starter` (7 USDT), no `free`**: el plan gratis **suspende el servicio a los 15 minutos**, y para poker eso es el producto roto — un campo de 300 se corta a mitad con fichas de jugadores bloqueadas.

**4 · Variables de entorno** en Render. Las cinco obligatorias:

| Variable | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | El de @BotFather |
| `MONGODB_URI` | La URI de Atlas (la del driver **Node**) |
| `MINI_APP_URL` | `https://TU-SERVICIO.onrender.com` — **sin barra final** |
| `ADMIN_API_KEY` | Generada. Anótala |
| `SIMULATION_SECRET` | Generada |

Las de `render.yaml` (con `sync: false`) están **vacías a propósito**: ponlas tú.

**5 · Registrar el webhook — no se puede saltar.** En producción el bot usa webhook, no polling. **Visita una vez:**
```
https://TU-SERVICIO.onrender.com/telegram/setup
```
Debe devolver `{"success":true,"webhook":"..."}`. **Sin esto el bot no recibe ni un mensaje**, aunque `/health` responda y el deploy esté en verde. Repítelo si cambias el dominio.

**6 · Probar**: abre el bot en Telegram y pulsa **▶ Jugar**.

### Después de cada `git push`

**Render no actualiza solo.** Render → tu servicio → **Manual Deploy** → **Deploy latest commit**.

Sin esto estás probando la versión anterior. Es la causa más frecuente de "arreglé un bug y sigue igual".

---

## Pagos

Con el blueprint tal cual, **el sistema no mueve dinero real** — a propósito:

- `SIMULATE_PAYMENTS=true`: hay un botón de "simular pago" en la app.
- `ALLOW_SIMULATED_WITHDRAWALS` sin definir: **no se puede aprobar un retiro**.

El segundo freno está por un motivo: aprobar un retiro no mueve dinero (marca la orden y el operador paga por fuera). Sin freno, en simulación una orden es indistinguible de una real y el operador paga USDT de verdad que no sale de ningún sitio.

**No pongas `SIMULATE_PAYMENTS=false` hasta que haya una pasarela real conectada** — requiere cuenta de empresa.

---

## Problemas que ya sabemos que pasan

| Síntoma | Causa |
|---|---|
| "Sesión expirada" en `:3000` | **Correcto.** Usa `:5173` para el navegador |
| El bot no recibe mensajes, `/health` va bien | Falta registrar el webhook (paso 5) |
| Arranca y se cae | Atlas no acepta la IP de Render (`0.0.0.0/0`) |
| El Mini App sale en blanco | El build de la web falló. Mira el log del build |
| Arreglé un bug y sigue igual | Falta el Manual Deploy |

---

## Resumen: dos carpetas, dos terminales

```bash
# Terminal 1 — backend
cd C:\Users\La'Roch\cubapoker\telegram-bot
npm run dev

# Terminal 2 — web
cd C:\Users\La\Roch\cubapoker\telegram-bot\mini-app
npm run dev
```

Abre **http://localhost:5173**. Para jugar de verdad dentro de Telegram, despliega en Render y sigue la Parte 2.