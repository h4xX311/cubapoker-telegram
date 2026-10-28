# CubaPoker — Telegram Mini App

Mini App de póker para Telegram con salas cash, VIP Arena, torneos y freerolls.
La unidad interna es la milésima de USDT: **1 USDT = 1000 unidades**.

## Características

- Integración con Telegram Web App, sin registro separado.
- Lobby cash por modalidad, nivel de ciegas y formato (6-max, Heads-Up y 7-max).
- Entrada rápida y multimesa con las cartas privadas de cada mesa.
- VIP Arena independiente, con sus niveles y su profit share.
- Torneos multimesa con garantía, Spin & Go y freerolls por franjas UTC.
- Pagos con EnZona, QvaPay y USDT; simulación mientras no haya pasarelas reales.
- Mesa ovalada con asientos, avatares, cartas, bote, dealer y acciones.
- Historial de resultados, fuerza de mano y avisos de turno.
- Interfaz adaptativa para Telegram móvil y escritorio.

## Inicio rápido

### 1. Crear el bot en Telegram

1. Abrir Telegram y buscar `@BotFather`.
2. Enviar `/newbot`.
3. Seguir las instrucciones.
4. Copiar el **Bot Token**.

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Variables principales:

```env
TELEGRAM_BOT_TOKEN=tu-token-de-botfather
MONGODB_URI=mongodb://127.0.0.1:27017/cubapoker
TRONGRID_API_KEY=tu-api-key
ENZONA_CLIENT_ID=tu-client-id
ENZONA_CLIENT_SECRET=tu-client-secret
QVAPAY_APP_ID=tu-app-id
QVAPAY_APP_SECRET=tu-app-secret
EPUSDT_API_URL=http://localhost:8000
MINI_APP_URL=https://tu-dominio.com
```

### 3. Instalar y ejecutar

```bash
# Backend
npm install
npm run dev

# Mini App, en otra terminal
cd mini-app
npm install
npm run dev
```

### 4. Configurar la Mini App en BotFather

1. Enviar `/newapp` a `@BotFather`.
2. Seleccionar el bot.
3. Ingresar la URL pública de la Mini App.

## Comandos del bot

| Comando | Descripción |
|---|---|
| `/start` | Iniciar y mostrar el menú principal |
| `/play` | Abrir el lobby de póker |
| `/deposit` | Depositar fondos |
| `/withdraw` | Retirar fondos |
| `/balance` | Ver el balance |
| `/help` | Mostrar la ayuda |

## Pruebas

El runner estándar compila y ejecuta todas las suites:

```bash
npm test
```

Suites específicas:

```bash
npm run test:fichas      # conservación de fichas
npm run test:mano        # fuerza de mano en la Mini App
```

Las suites que usan Mongo necesitan una instancia real:

```powershell
$env:MONGODB_URI='mongodb://127.0.0.1:37017/cubapoker_test'
npm test
```

`scripts/test-interfaz.js` es una prueba de humo HTTP: requiere el servidor
levantado en `http://localhost:3000`.

## Estructura

```text
telegram-bot/
├── src/
│   ├── bot.ts              # Bot de Telegram y API
│   ├── game/               # Motor, mesa, bots, campos y asientos
│   ├── models/             # Modelos de Mongo
│   ├── routes/             # API de la Mini App
│   └── services/           # Pagos, rake, rakeback y operaciones
├── mini-app/
│   └── src/
│       ├── pages/          # Home, mesas, mesa, perfil, VIP, fuente
│       └── lib/            # API, tipos y fuerza de mano
├── scripts/                # Pruebas y utilidades
├── DECISIONES.md
├── REVISION-PROYECTOS.md
└── NOTICE.md
```

## Despliegue

### Render

1. Subir el repositorio a GitHub.
2. Crear un Web Service.
3. Build Command: `npm install && npm run build`.
4. Start Command: `node dist/bot.js`.
5. Configurar las variables de entorno.

### VPS con PM2

```bash
npm install
npm run build
cd mini-app && npm run build
pm2 start dist/bot.js --name cubapoker-bot
```

## Documentación de producto

- `DECISIONES.md`: reglas de dinero, salas, bots, torneos, rake y seguridad de asientos.
- `REVISION-PROYECTOS.md`: revisión de los proyectos de referencia y qué se puede reutilizar.
- `NOTICE.md`: autoría, licencias y atribuciones de la obra combinada.

## Licencia

CubaPoker se distribuye bajo la **GNU Affero General Public License, versión 3
(AGPL-3.0)**. El texto completo está en [`LICENSE`](./LICENSE).

La obra combinada incorpora lógica y conceptos derivados de **PokerTH**, también
bajo AGPL-3.0. Las atribuciones y la oferta de código fuente están en
[`NOTICE.md`](./NOTICE.md) y en la ruta `/source` de la Mini App.

Cualquier versión modificada que se ofrezca a través de una red debe poner a
disposición de los usuarios el código fuente correspondiente.
