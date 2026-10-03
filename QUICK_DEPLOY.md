# Despliegue Rápido - CubaPoker

## 🚀 En 10 minutos

### 1. Subir a GitHub (2 min)
```bash
cd telegram-bot
git init
git add .
git commit -m "CubaPoker production"
git remote add origin https://github.com/tu-usuario/cubapoker-telegram.git
git push -u origin main
```

### 2. Crear Bot en Telegram (2 min)
```
@BotFather → /newbot → Copiar token
@BotFather → /setcommands → Pegar comandos
@BotFather → /newapp → Configurar URL
```

### 3. MongoDB Atlas (3 min)
```
mongodb.com/atlas → Crear cluster gratuito
→ Crear usuario → IP: 0.0.0.0/0
→ Copiar URI de conexión
```

### 4. Desplegar en Render (3 min)
```
render.com → New → Blueprint
→ Seleccionar repositorio
→ Configurar variables:
   TELEGRAM_BOT_TOKEN=tu-token
   MONGODB_URI=tu-uri
   TRONGRID_API_KEY=tu-key
   ENZONA_CLIENT_ID=tu-id
   ENZONA_CLIENT_SECRET=tu-secret
   QVAPAY_APP_ID=tu-id
   QVAPAY_APP_SECRET=tu-secret
   MINI_APP_URL=https://cubapoker-telegram-bot.onrender.com
→ Apply
```

### 5. Verificar (1 min)
```bash
curl https://cubapoker-telegram-bot.onrender.com/health
```

---

## ✅ Listo!

Abre Telegram → Busca tu bot → Envía `/start`

---

## Variables de Entorno Requeridas

| Variable | Obligatoria | Dónde obtenerla |
|----------|--------------|-----------------|
| `TELEGRAM_BOT_TOKEN` | Sí | @BotFather |
| `MONGODB_URI` | Sí | MongoDB Atlas |
| `TRONGRID_API_KEY` | Sí | trongrid.io |
| `ENZONA_CLIENT_ID` | Sí | enzona.net |
| `ENZONA_CLIENT_SECRET` | Sí | enzona.net |
| `QVAPAY_APP_ID` | Sí | qvapay.com |
| `QVAPAY_APP_SECRET` | Sí | qvapay.com |
| `EPUSDT_API_URL` | No | Tu servidor epusdt |
| `MINI_APP_URL` | Sí | URL de Render |

---

## Comandos del Bot

```
/start - Menú principal
/play - Jugar poker
/tournaments - Ver torneos
/vip - Comprar VIP
/referrals - Ver referidos
/achievements - Ver logros
/deposit - Depositar
/withdraw - Retirar
/balance - Ver balance
/help - Ayuda
```

---

## Estructura del Proyecto

```
telegram-bot/
├── src/
│   ├── bot.ts              # Bot + API
│   ├── config/
│   │   └── monetization.ts # Configuración
│   ├── models/             # User, VIP, Referral, Achievement
│   ├── services/
│   │   └── monetization.service.ts
│   ├── routes/
│   │   └── monetization.routes.ts
│   └── game/
│       ├── rake.ts
│       └── tournament.ts
├── mini-app/
│   └── src/pages/          # 8 páginas
├── scripts/
│   ├── setup.sh
│   ├── deploy.sh
│   ├── verify.sh
│   └── ...
├── render.yaml
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Soporte

- **Guía completa**: DEPLOYMENT.md
- **Verificación**: ./scripts/verify.sh
- **Monetización**: MONETIZATION.md
- **Usuario**: USER_GUIDE.md
