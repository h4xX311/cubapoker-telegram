# CubaPoker - Guía de Producción

## Estado del Proyecto

### ✅ Completado

| Componente | Estado | Descripción |
|------------|--------|-------------|
| **Bot de Telegram** | ✅ | Comandos /start, /play, /tournaments, /deposit, /withdraw, /balance, /help |
| **Mini App** | ✅ | 5 páginas: Home, Deposit, Withdraw, Game, Tournaments |
| **Juego Poker** | ✅ | Texas Hold'em completo con todas las fases |
| **Sistema de Rake** | ✅ | 5% configurable, máximo 100 CUP |
| **Torneos** | ✅ | Sit & Go, Programado, Freeroll |
| **Pagos** | ✅ | EnZona, QvaPay, USDT (TRC20, ERC20, BEP20) |
| **Estética** | ✅ | Diseño profesional con gradientes, animaciones, glass effect |
| **Docker** | ✅ | Dockerfile + docker-compose.yml |
| **Render** | ✅ | render.yaml configurado |

---

## Para Desplegar en Producción

### Paso 1: Crear Bot en Telegram

1. Abrir Telegram → @BotFather
2. `/newbot` → Seguir instrucciones
3. Copiar el **Bot Token**
4. `/newapp` → Configurar Mini App URL
5. `/setcommands` → Configurar comandos:

```
start - Iniciar y registrarse
play - Jugar poker
tournaments - Ver torneos
deposit - Depositar fondos
withdraw - Retirar fondos
balance - Ver balance
help - Ayuda
```

### Paso 2: Crear MongoDB Atlas

1. Ir a [MongoDB Atlas](https://www.mongodb.com/atlas)
2. Crear cuenta gratuita
3. Crear cluster (gratuito, 512MB)
4. Crear usuario de base de datos
5. Configurar IP access (0.0.0.0/0)
6. Copiar URI de conexión

### Paso 3: Obtener Credenciales de Pago

| Servicio | URL | Variables |
|----------|-----|-----------|
| **EnZona** | enzona.net | ENZONA_CLIENT_ID, ENZONA_CLIENT_SECRET |
| **QvaPay** | qvapay.com | QVAPAY_APP_ID, QVAPAY_APP_SECRET |
| **TronGrid** | trongrid.io | TRONGRID_API_KEY |

### Paso 4: Desplegar en Render

```bash
# 1. Subir a GitHub
git init
git add .
git commit -m "CubaPoker Telegram Mini App - Producción"
git remote add origin https://github.com/tu-usuario/cubapoker-telegram.git
git push -u origin main

# 2. En Render
# - New → Blueprint
# - Seleccionar repositorio
# - Configurar variables (sync: false)
# - Apply
```

### Paso 5: Configurar Mini App URL

En @BotFather:
```
/newapp → Seleccionar bot → URL: https://cubapoker-telegram-bot.onrender.com
```

---

## Variables de Entorno

```env
# Telegram
TELEGRAM_BOT_TOKEN=tu-token-de-botfather

# MongoDB
MONGODB_URI=mongodb+srv://usuario:password@cluster.mongodb.net/cubapoker

# Blockchain
TRONGRID_API_KEY=tu-api-key
USDT_CONTRACT_ADDRESS=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgLj6t

# EnZona
ENZONA_CLIENT_ID=tu-client-id
ENZONA_CLIENT_SECRET=tu-client-secret

# QvaPay
QVAPAY_APP_ID=tu-app-id
QVAPAY_APP_SECRET=tu-app-secret

# epusdt
EPUSDT_API_URL=http://localhost:8000

# Mini App
MINI_APP_URL=https://cubapoker-telegram-bot.onrender.com

# Server
PORT=3000
```

---

## Estructura del Proyecto

```
telegram-bot/
├── src/
│   ├── bot.ts              # Bot de Telegram + API
│   ├── health.ts           # Health check
│   ├── game/
│   │   ├── polling.ts      # Rutas de juego + torneos
│   │   ├── game.state.ts   # Lógica del juego
│   │   ├── card.utils.ts   # Utilidades de cartas
│   │   ├── hand.evaluator.ts # Evaluador de manos
│   │   ├── rake.ts         # Sistema de rake
│   │   └── tournament.ts   # Sistema de torneos
│   └── models/
│       ├── User.ts         # Modelo de usuario
│       ├── Game.ts         # Modelo de juego
│       └── Transaction.ts  # Modelo de transacciones
├── mini-app/
│   └── src/
│       ├── pages/          # Home, Deposit, Withdraw, Game, Tournaments
│       ├── App.tsx
│       └── main.tsx
├── package.json
├── Dockerfile
├── docker-compose.yml
├── render.yaml
└── .env.example
```

---

## Características del Juego

### Texas Hold'em
- ✅ 2-6 jugadores
- ✅ Preflop, Flop, Turn, River
- ✅ Showdown con evaluador de manos
- ✅ Sistema de blinds
- ✅ Acciones: Fold, Check, Call, Raise, All-In

### Sistema de Rake
- ✅ 5% por defecto
- ✅ Máximo 100 CUP por mano
- ✅ Mínimo 10 CUP de pote para aplicar rake
- ✅ Configurable

### Torneos
- ✅ Sit & Go (comienza cuando hay suficientes jugadores)
- ✅ Programado (horario fijo)
- ✅ Freeroll (gratis)
- ✅ Premios automáticos para top 3

---

## Comandos del Bot

| Comando | Descripción |
|---------|-------------|
| `/start` | Menú principal con botones |
| `/play` | Jugar poker |
| `/tournaments` | Ver torneos |
| `/deposit` | Depositar fondos |
| `/withdraw` | Retirar fondos |
| `/balance` | Ver balance |
| `/help` | Ayuda |

---

## API Endpoints

### Usuarios
- `GET /api/user/:telegramId` - Obtener usuario

### Pagos
- `POST /api/deposit` - Depositar
- `POST /api/withdraw` - Retirar

### Juegos
- `POST /api/game/create` - Crear mesa
- `POST /api/game/join` - Unirse a mesa
- `GET /api/game/state/:gameId/:telegramId` - Estado del juego
- `POST /api/game/action` - Realizar acción
- `POST /api/game/leave` - Salir de la mesa
- `GET /api/game/active` - Mesas activas

### Torneos
- `GET /api/game/tournaments` - Torneos activos
- `POST /api/game/tournaments/create` - Crear torneo
- `POST /api/game/tournaments/:id/register` - Registrarse
- `POST /api/game/tournaments/:id/start` - Iniciar torneo

---

## Monitoreo

### Health Check
```bash
curl https://cubapoker-telegram-bot.onrender.com/health
```

### Logs en Render
```
Dashboard → Servicio → Logs
```

---

## Seguridad

- ✅ Autenticación por Telegram Web App
- ✅ Validación de datos
- ✅ Rate limiting (implementar en producción)
- ✅ CORS configurado
- ✅ Variables de entorno seguras

---

## Próximos Pasos

1. **Crear bot en Telegram** (@BotFather)
2. **Crear MongoDB Atlas** (gratuito)
3. **Obtener credenciales** de EnZona, QvaPay, TronGrid
4. **Subir a GitHub**
5. **Desplegar en Render** con Blueprint
6. **Configurar Mini App URL** en BotFather
7. **Probar** enviando /start a tu bot

---

## Soporte

- **Telegram**: @CubaPokerSupport
- **Email**: soporte@cubapoker.com
- **GitHub**: Issues del repositorio
