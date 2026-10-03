# Guía de Despliegue en Producción - CubaPoker

## Requisitos Previos

- [ ] Cuenta en GitHub
- [ ] Cuenta en Telegram (@BotFather)
- [ ] Cuenta en MongoDB Atlas
- [ ] Cuenta en Render
- [ ] Credenciales de EnZona, QvaPay, TronGrid

---

## Paso 1: Subir Código a GitHub

```bash
cd telegram-bot

# Inicializar repositorio
git init

# Crear .gitignore (ya existe)
# Verificar que .env NO esté en git
cat .gitignore | grep ".env"

# Agregar archivos
git add .

# Commit
git commit -m "CubaPoker - Sistema de monetización completo"

# Crear repositorio en GitHub y subir
git remote add origin https://github.com/tu-usuario/cubapoker-telegram.git
git branch -M main
git push -u origin main
```

---

## Paso 2: Crear Bot en Telegram

1. Abrir Telegram y buscar **@BotFather**
2. Enviar `/newbot`
3. Seguir las instrucciones:
   - Nombre: `CubaPoker`
   - Username: `CubaPokerBot` (o el que prefieras)
4. **Copiar el Bot Token** (lo necesitarás después)

### Configurar Comandos del Bot

Enviar a @BotFather:
```
/setcommands
```

Seleccionar tu bot y pegar:
```
start - Iniciar y registrarse
play - Jugar poker
tournaments - Ver torneos
vip - Comprar VIP
referrals - Ver referidos
achievements - Ver logros
deposit - Depositar fondos
withdraw - Retirar fondos
balance - Ver balance
help - Ayuda
```

### Configurar Mini App

Enviar a @BotFather:
```
/newapp
```

1. Seleccionar tu bot
2. Nombre: `CubaPoker`
3. Descripción: `Plataforma de poker con blockchain y pagos cubanos`
4. URL: `https://cubapoker-telegram-bot.onrender.com` (la URL de Render)
5. Foto: Subir una imagen de 640x360px

---

## Paso 3: Crear MongoDB Atlas

1. Ir a [MongoDB Atlas](https://www.mongodb.com/atlas)
2. Crear cuenta gratuita
3. Crear cluster:
   - **Provider**: AWS
   - **Region**: South America (São Paulo) - más cercano a Cuba
   - **Tier**: M0 Sandbox (gratuito, 512MB)
4. Crear usuario de base de datos:
   - Username: `cubapoker_admin`
   - Password: (generar una segura)
5. Configurar IP Access:
   - Agregar `0.0.0.0/0` (permitir desde cualquier IP)
6. Obtener URI de conexión:
   ```
   mongodb+srv://cubapoker_admin:<password>@cluster0.xxxxx.mongodb.net/cubapoker
   ```

---

## Paso 4: Obtener Credenciales de Pago

### EnZona
1. Ir a [enzona.net](https://www.enzona.net)
2. Crear cuenta de desarrollador
3. Crear aplicación
4. Obtener: `ENZONA_CLIENT_ID`, `ENZONA_CLIENT_SECRET`

### QvaPay
1. Ir a [qvapay.com](https://qvapay.com)
2. Crear cuenta
3. Crear aplicación
4. Obtener: `QVAPAY_APP_ID`, `QVAPAY_APP_SECRET`

### TronGrid
1. Ir a [trongrid.io](https://www.trongrid.io)
2. Crear cuenta
3. Crear API Key
4. Obtener: `TRONGRID_API_KEY`

---

## Paso 5: Desplegar en Render

### Opción A: Blueprint (Recomendado)

1. Ir a [Render Dashboard](https://dashboard.render.com)
2. Click en **New** → **Blueprint**
3. Seleccionar tu repositorio `cubapoker-telegram`
4. Render detectará automáticamente `render.yaml`
5. Configurar variables de entorno:

| Variable | Valor |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Tu token de BotFather |
| `MONGODB_URI` | Tu URI de MongoDB Atlas |
| `TRONGRID_API_KEY` | Tu API key de TronGrid |
| `ENZONA_CLIENT_ID` | Tu client ID de EnZona |
| `ENZONA_CLIENT_SECRET` | Tu client secret de EnZona |
| `QVAPAY_APP_ID` | Tu app ID de QvaPay |
| `QVAPAY_APP_SECRET` | Tu app secret de QvaPay |
| `EPUSDT_API_URL` | URL de tu epusdt (o dejar vacío por ahora) |
| `MINI_APP_URL` | `https://cubapoker-telegram-bot.onrender.com` |

6. Click en **Apply**
7. Esperar 5-10 minutos para el despliegue

### Opción B: Web Service Manual

1. Click en **New** → **Web Service**
2. Conectar repositorio GitHub
3. Configurar:

| Campo | Valor |
|-------|-------|
| Name | `cubapoker-telegram-bot` |
| Runtime | `Node` |
| Build Command | `npm install && npm run build && cd mini-app && npm install && npm run build` |
| Start Command | `node dist/bot.js` |
| Instance Type | `Free` |

4. Agregar variables de entorno (mismas que arriba)
5. Click en **Create Web Service**

---

## Paso 6: Verificar Despliegue

### Health Check
```bash
curl https://cubapoker-telegram-bot.onrender.com/health
```

Respuesta esperada:
```json
{
  "status": "ok",
  "service": "cubapoker-telegram-bot",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Probar Bot en Telegram
1. Buscar tu bot en Telegram
2. Enviar `/start`
3. Verificar que aparezca el menú con botones
4. Probar `/balance`, `/vip`, `/referrals`, `/achievements`

---

## Paso 7: Configurar Dominio Personalizado (Opcional)

1. En Render, ir a **Settings** → **Custom Domains**
2. Agregar tu dominio: `poker.tudominio.com`
3. Configurar DNS según las instrucciones de Render
4. Actualizar `MINI_APP_URL` en las variables de entorno

---

## Solución de Problemas

### El bot no responde
```bash
# Ver logs en Render
Dashboard → Servicio → Logs

# Verificar que el token sea correcto
echo $TELEGRAM_BOT_TOKEN
```

### Error de MongoDB
```bash
# Verificar URI de conexión
echo $MONGODB_URI

# Probar conexión localmente
mongosh "mongodb+srv://..."
```

### Mini App no carga
```bash
# Verificar que el build fue exitoso
# En Render: Dashboard → Servicio → Builds

# Verificar archivos estáticos
curl https://cubapoker-telegram-bot.onrender.com/
```

---

## Checklist Final

- [ ] Código subido a GitHub
- [ ] Bot creado en Telegram
- [ ] Comandos configurados
- [ ] Mini App configurada
- [ ] MongoDB Atlas creado
- [ ] Credenciales de pago obtenidas
- [ ] Desplegado en Render
- [ ] Health check funcionando
- [ ] Bot respondiendo en Telegram
- [ ] Mini App cargando correctamente
- [ ] Depósitos funcionando
- [ ] Retiros funcionando
- [ ] Juego de poker funcionando
- [ ] Torneos funcionando
- [ ] VIP funcionando
- [ ] Referidos funcionando
- [ ] Logros funcionando

---

## Soporte

Si tienes problemas durante el despliegue:

1. Revisa los logs en Render
2. Verifica las variables de entorno
3. Prueba el health check
4. Contacta a @CubaPokerSupport

---

¡Despliegue completado! 🎉
