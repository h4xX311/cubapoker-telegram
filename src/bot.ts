import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import healthRouter from './health';
import userRoutes from './routes/user.routes';
import tableRoutes from './routes/table.routes';
import monetizationRoutes from './routes/monetization.routes';
import paymentRoutes from './routes/payment.routes';
import adminRoutes from './routes/admin.routes';
import { monetizationService } from './services/monetization.service';
import { requireTelegramAuth, getAuthedTelegramId } from './middleware/telegramAuth';
import { User } from './models/User';
import { Game } from './models/Game';
import { Transaction } from './models/Transaction';
import { VIP_CONFIG, VIPLevel } from './models/VIP';
import { SIMULATION_ENABLED, pruneSimulatedOrders } from './services/payment/gateway';
import { tableManager, shutdownEngine } from './game/table.manager';
import { fieldManager } from './game/field.manager';
import { SUIT_SYMBOL } from './game/card.utils';
import { seatingService } from './game/seating.service';
import { logger } from './utils/logger';

// ------------------------------------------------------------------
// QUE HACE ESTA LINEA, Y POR QUE IMPORTA MAS DE LO QUE PARECE
//
// Arrancar el proceso lleva casi medio minuto, y hasta hace nada no decia NI UNA PALABRA
// durante todo ese rato. Es lo que hace que un arranque correcto parezca un proceso
// muerto: se abre la terminal, no aparece nada, y la conclusion razonable es que esta
// roto. Y la conclusion razonable es la que hace que se cierre la terminal.
//
// Ahora lo primero que se ve es esto, al instante, y dice cuanto se espera despues.asi se
// puede distinguir "todavia esta arrancando" de "se quedo colgado", que son dos fallos
// opuestos y no se parecen en nada.
// ------------------------------------------------------------------
console.log('[cubapoker] arrancando... cargando modulos (esto tarda hasta 30s en WSL).');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../mini-app/dist')));

// Health check unico (antes estaba definido dos veces, la segunda era muerta)
app.use('/health', healthRouter);

// ---------------------------------------------------------------------------
// Telegram Bot: webhook en produccion, polling solo en local
// ---------------------------------------------------------------------------
// Por que webhook y no polling:
//  - Render free suspende el servicio tras 15 min de inactividad. Con polling
//    el bot se desconecta de Telegram y hay que reconectar.
//  - Con webhook, Telegram es quien llama: no hay sondeos que mantener.
//  - Es la unica opcion que sobrevive a multiples instancias.
//
// En desarrollo mantenemos polling porque no hay URL publica a la que
// Telegram pueda llamar.
const USE_WEBHOOK = process.env.NODE_ENV === 'production';

// ------------------------------------------------------------------
// EL TOKEN, Y POR QUE EN DESARROLLO PUEDE FALTAR
//
// `new TelegramBot()` lanza `EFATAL` si no hay token, y el proceso se muere. Sin proceso no
// hay API, ni mesas, ni bots, ni interfaz: el unico sintoma es que la web "no hace nada",
// sin decir por que. Y es un fallo solido al desarrollo: en produccion el token siempre
// esta.
//
// En desarrollo se puede arrancar SIN token, con el bot mudo: mismo objeto, sin polling y sin
// webhook. Todo lo demas (API, gestor de mesas, bots de poker, pagos) funciona igual, asi que
// se desarrolla y se prueba el juego entero sin tener un bot.
//
// En produccion sigue siendo obligatorio, y si falta se para. Un bot sin token no puede
// hablar con Telegram, y fingir que arranca solo produce un fallo mas tarde y mas dificil de
// ver.
// ------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const SIN_TOKEN = !TELEGRAM_TOKEN;

if (SIN_TOKEN) {
  if (USE_WEBHOOK) {
    // Produccion sin token: no hay nada que arreglar aqui, se para y se dice por que.
    logger.error(
      'Falta TELEGRAM_BOT_TOKEN y NODE_ENV es production. ' +
        'Sin token el bot no puede hablar con Telegram. No se arranca.',
    );
    process.exit(1);
  }

  logger.warn(
    'SIN TELEGRAM_BOT_TOKEN: el juego, la API y los bots funcionan, pero el bot no ' +
      'habla con Telegram (nada de comandos, nada de teclado de respuesta). ' +
      'Para probar eso hace falta un token de @BotFather en el .env.',
  );
}

const bot = new TelegramBot(TELEGRAM_TOKEN || '0:dry-run-sin-token', {
  polling: !USE_WEBHOOK && !SIN_TOKEN,
});

/**
 * Avisos de turno.
 *
 * El gestor de mesas no sabe nada de Telegram (ver `TurnNotifier`): aqui se
 * traduce su aviso a un mensaje. Solo se manda lo justo para que el jugador
 * sepa que le toca y abra la mesa. Antes se empujaba el estado completo en
 * cada movimiento de la mesa, lo que generaba un volumen de mensajes
 * insostenible y ademas filtraba las cartas del rival al cliente.
 */
tableManager.setNotifier(async (notice) => {
  const user = await User.findOne({ telegramId: notice.telegramId });
  if (!user) return;

  const chatId = (user as any).chatId as number | undefined;
  if (!chatId) return;

  const phaseLabel =
    { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' }[
      notice.phase
    ] ?? notice.phase;

  const cards = notice.cards
    .map(c => `${c.rank}${SUIT_SYMBOL[c.suit] ?? ''}`)
    .join('  ');

  const instruction = notice.toCall === 0
    ? 'Puedes pasar o subir.'
    : `Debes poner *${notice.toCall} CUP* para continuar.`;

  const body = [
    `🎯 *Te toca* · ${phaseLabel}`,
    '',
    `🃏 ${cards}`,
    `💰 Bote: ${notice.pot} CUP · tus fichas: ${notice.chips}`,
    '',
    instruction,
    `⏱️ Tienes ${Math.round(notice.deadlineMs / 1000)} s. Si no respondes, el motor juega por ti.`,
  ].join('\n');

  await bot.sendMessage(chatId, body, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🃏 Jugar mi turno',
            web_app: { url: `${process.env.MINI_APP_URL}/game` },
          },
        ],
      ],
    },
  });
});

if (USE_WEBHOOK) {
  // Verificacion de la firma del webhook. Sin esto, cualquiera podria enviar
  // updates falsos y hacerse pasar por Telegram.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  app.post('/telegram/webhook', (req, res) => {
    if (secret) {
      const provided = req.headers['x-telegram-bot-api-secret-token'];
      if (provided !== secret) {
        res.sendStatus(403);
        return;
      }
    }
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  // Registro del webhook. Render inyecta la URL publica en RENDER_EXTERNAL_URL.
  app.get('/telegram/setup', async (_req, res) => {
    const base =
      process.env.MINI_APP_URL?.replace(/^https?:\/\//, '').split('/')[0] ||
      process.env.RENDER_EXTERNAL_URL;

    if (!base) {
      res.status(400).json({ error: 'Falta MINI_APP_URL o RENDER_EXTERNAL_URL' });
      return;
    }

    const url = `https://${base}/telegram/webhook`;
    try {
      await bot.setWebHook(url, {
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
      });
      res.json({ success: true, webhook: url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}

// Game Routes (mesas cash, freerolls, acciones)
app.use('/api/game', tableRoutes);

// ------------------------------------------------------------------
// SESION DEL JUGADOR
//
// Se monta ANTES que cualquier otra cosa de `/api`, y por dos razones.
//
// La primera es que la Mini App lo pide desde el arranque: sin el, la aplicacion no sabe
// quien es el jugador ni cuanto tiene, y con el saldo a cero todos los botones de compra
// salen deshabilitados sin explicar por que.
//
// La segunda es la que de verdad importa: **las rutas que faltan no dan 404**, caen en el
// `catch-all` que sirve la SPA y devuelven su HTML con HTTP 200. Un 404 se ve enseguida;
// un 200 con una pagina HTML dentro parece que todo va bien mientras el cliente revienta al
// hacer `JSON.parse`. Por eso este router tiene que existir de verdad, no "de momento".
// ------------------------------------------------------------------
app.use('/api', userRoutes);

// Monetization Routes
app.use('/api/monetization', monetizationRoutes);

// Payment Orders (deposit in two steps, withdrawals, simulation)
app.use('/api/payment', paymentRoutes);

// Panel de operador: aprobar/cancelar retiros, ver depositos, campos y finanzas.
// Se monta DESPUES de las rutas publicas y lleva su propia clave, para que un
// fallo de autenticacion aqui no exponga nada del resto.
app.use('/api/admin', adminRoutes);

// Liveness / readiness para el orquestador
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'cubapoker-telegram-bot',
    paymentMode: SIMULATION_ENABLED ? 'simulation' : 'live',
    timestamp: new Date().toISOString(),
  });
});

// Commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  await User.findOneAndUpdate(
    { telegramId: user.id },
    {
      // Se guarda `chatId` para poder avisar de turnos. Solo se registra si el
      // mensaje llega en un chat privado (tipo "private"): en un grupo el aviso
      // "te toca" se leeria en voz alta y molestaria a los demas.
      $set: {
        telegramId: user.id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        ...(msg.chat.type === 'private' ? { chatId: msg.chat.id } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const welcomeMessage = `
🃏 *Bienvenido a CubaPoker* ${user.first_name}!

La primera plataforma de poker con blockchain y métodos de pagos cubanos.

💰 *Tu balance:*
• Créditos: 0 CUP
• USDT: 0.00

🎮 *Comandos disponibles:*
/play - Jugar poker
/tournaments - Ver torneos
/vip - Comprar VIP
/referrals - Ver referidos
/achievements - Ver logros
/deposit - Depositar fondos
/withdraw - Retirar fondos
/balance - Ver balance
/help - Ayuda

🇨🇺 *Métodos de pago:*
• EnZona
• QvaPay
• USDT (TRC20)
  `;

  // Las URLs deben coincidir con las rutas que la Mini App resuelve en App.tsx.
  const app = process.env.MINI_APP_URL || '';
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🎮 Jugar', web_app: { url: `${app}/game` } },
        { text: '🏆 Torneos', web_app: { url: `${app}/tournaments` } },
      ],
      [
        { text: '💰 Depositar', web_app: { url: `${app}/deposit` } },
        { text: '💸 Retirar', web_app: { url: `${app}/withdraw` } },
      ],
      [
        { text: '👑 VIP', web_app: { url: `${app}/vip` } },
        { text: '🎖️ Logros', web_app: { url: `${app}/achievements` } },
      ],
    ],
  };

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/play/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const dbUser = await User.findOne({ telegramId: user.id });
  if (!dbUser) {
    bot.sendMessage(chatId, '❌ Usa /start primero para registrarte');
    return;
  }

  // Para jugar se usa el saldo total: el de promocion tambien sirve para
  // sentarse en mesas cash (es su proposito).
  const total = dbUser.balance.real + dbUser.balance.play;

  if (total < 200) {
    bot.sendMessage(
      chatId,
      '❌ Necesitas al menos 200 CUP para jugar.\n\n' +
      'Tu saldo:\n' +
      `• Real (retirable): ${dbUser.balance.real} CUP\n` +
      `• Promoción: ${dbUser.balance.play} CUP\n\n` +
      'Deposita con /deposit o entra a un freeroll gratis con /freeroll.',
    );
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🎮 Jugar', web_app: { url: `${process.env.MINI_APP_URL}/game` } }],
      [{ text: '🎁 Freeroll gratis', web_app: { url: `${process.env.MINI_APP_URL}/freeroll` } }],
    ],
  };

  bot.sendMessage(
    chatId,
    `🎮 *Mesas de Poker*\n\n` +
      `Saldo total: ${total} CUP\n` +
      `• Real: ${dbUser.balance.real} CUP\n` +
      `• Promoción: ${dbUser.balance.play} CUP\n\n` +
      'Mesas de 50 a 500 jugadores con premio garantizado.',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    },
  );
});

bot.onText(/\/freeroll/, async (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🎁 Entrar al freeroll', web_app: { url: `${process.env.MINI_APP_URL}/freeroll` } }],
    ],
  };

  bot.sendMessage(
    chatId,
    '🎁 *Freerolls gratuit\cos*\n\n' +
      'Premios de 5 a 50 CUP sin buy-in.\n\n' +
      '⚠️ *Importante:* el saldo que ganas aqui es solo para jugar dentro de ' +
      'CubaPoker en cualquier mesa cash. No se puede retirar.',
    { parse_mode: 'Markdown', reply_markup: keyboard },
  );
});

bot.onText(/\/tournaments/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🏆 Ver Torneos', web_app: { url: `${process.env.MINI_APP_URL}/tournaments` } }],
    ]
  };

  bot.sendMessage(chatId, '🏆 *Torneos*\n\nParticipa y gana premios:', {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/vip/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const dbUser = await User.findOne({ telegramId: user.id });
  const vipLevel = await monetizationService.getVIPLevel(user.id);

  let message = `👑 *VIP - CubaPoker*\n\n`;
  
  if (vipLevel) {
    const config = VIP_CONFIG[vipLevel];
    message += `✅ *Tu nivel actual:* ${config.name}\n\n`;
    message += `🎁 *Beneficios:*\n`;
    config.benefits.forEach(b => { message += `• ${b}\n`; });
  } else {
    message += `❌ No tienes suscripción VIP\n\n`;
  }

  message += `\n📊 *Planes disponibles:*\n\n`;
  
  Object.entries(VIP_CONFIG).forEach(([key, config]) => {
    message += `*${config.name}*\n`;
    message += `💰 Precio: ${config.price} CUP/mes\n`;
    message += `🎁 Beneficios:\n`;
    config.benefits.forEach(b => { message += `  • ${b}\n`; });
    message += `\n`;
  });

  const keyboard = {
    inline_keyboard: [
      [{ text: '👑 Ver VIP', web_app: { url: `${process.env.MINI_APP_URL}/vip` } }],
    ]
  };

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/referrals/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const stats = await monetizationService.getReferralStats(user.id);

  const message = `
👥 *Referidos - CubaPoker*

📊 *Tus estadísticas:*
• Total referidos: ${stats.totalReferrals}
• Referidos activos: ${stats.activeReferrals}
• Comisión total: ${stats.totalCommission} CUP

🎁 *Recompensas:*
• 10% del rake de referidos directos
• 5% del rake de segundo nivel
• 2% del rake de tercer nivel
• Bonus: 50 CUP por cada referido activo

📝 *Cómo funciona:*
1. Comparte tu enlace de referido
2. Tus amigos se registran y juegan
3. Ganas comisiones por cada mano que jueguen
  `;

  const keyboard = {
    inline_keyboard: [
      [{ text: '👥 Ver Referidos', web_app: { url: `${process.env.MINI_APP_URL}/referrals` } }],
    ]
  };

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/achievements/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const achievements = await monetizationService.getUserAchievements(user.id);
  const streak = await monetizationService.getStreak(user.id);

  let message = `
🏆 *Logros - CubaPoker*

📊 *Tu racha:*
• Racha actual: ${streak.current} días
• Mejor racha: ${streak.best} días

🎖️ *Tus logros:* (${achievements.length})
  `;

  if (achievements.length === 0) {
    message += `\n\nAún no has desbloqueado logros. ¡Juega para ganar recompensas!`;
  } else {
    achievements.slice(0, 5).forEach(a => {
      message += `\n• ${a.achievementId} - ${a.reward} CUP`;
    });
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🏆 Ver Logros', web_app: { url: `${process.env.MINI_APP_URL}/achievements` } }],
    ]
  };

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/deposit/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💰 Depositar', web_app: { url: `${process.env.MINI_APP_URL}/deposit` } }],
    ]
  };

  bot.sendMessage(chatId, '💰 *Depositar Fondos*\n\nSelecciona un método de pago:', {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/withdraw/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💸 Retirar', web_app: { url: `${process.env.MINI_APP_URL}/withdraw` } }],
    ]
  };

  bot.sendMessage(chatId, '💸 *Retirar Fondos*\n\nSelecciona un método de retiro:', {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  const dbUser = await User.findOne({ telegramId: user.id });
  if (!dbUser) {
    bot.sendMessage(chatId, '❌ Usa /start primero');
    return;
  }

  const vipLevel = await monetizationService.getVIPLevel(user.id);
  const streak = await monetizationService.getStreak(user.id);

  const balanceMessage = `
💰 *Tu Balance*

• *Real (retirable):* ${dbUser.balance.real} CUP
• *Promoción (solo jugar):* ${dbUser.balance.play} CUP
• *Total:* ${dbUser.balance.real + dbUser.balance.play} CUP

👑 *VIP:* ${vipLevel ? VIP_CONFIG[vipLevel].name : 'No VIP'}
🔥 *Racha:* ${streak.current} días

El saldo de promoción sirve para jugar en cualquier mesa cash pero *no se puede retirar*.

Para depositar: /deposit
Para retirar: /withdraw
  `;

  bot.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  const helpMessage = `
🃏 *CubaPoker - Ayuda*

*Comandos:*
/start - Iniciar y registrarse
/play - Jugar poker
/tournaments - Ver torneos
/vip - Comprar VIP
/referrals - Ver referidos
/achievements - Ver logros
/deposit - Depositar fondos
/withdraw - Retirar fondos
/balance - Ver balance
/help - Este mensaje

*Métodos de pago:*
🇨🇺 EnZona - Pagos móviles cubanos
💳 QvaPay - Pagos online
₮ USDT - Criptomonedas (TRC20)

*Soporte:*
@CubaPokerSupport
  `;

  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// ==========================================================================
// API del Mini App
//
// Regla de seguridad: NINGUN endpoint de dinero acepta `telegramId` del
// cliente. La identidad se deriva de la firma de Telegram (initData) y se
// valida en cada request. Sin esto, cualquiera podria acreditar saldo
// arbitrariamente con un simple curl.
// ==========================================================================

// Perfil del usuario autenticado + auto-registro si es su primera visita
app.get('/api/me', requireTelegramAuth, async (req, res) => {
  try {
    const tgUser = (req as any).telegramUser;

    const user = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      {
        $set: {
          telegramId: tgUser.id,
          username: tgUser.username,
          firstName: tgUser.first_name,
          lastName: tgUser.last_name,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).select('-password');

    const vipLevel = await monetizationService.getVIPLevel(tgUser.id);

    res.json({
      user: {
        id: user._id,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        // La UI muestra los dos saldos por separado: `real` es el unico
        // retirable y `play` es saldo de promocion.
        balance: {
          real: user.balance.real,
          play: user.balance.play,
          total: user.balance.real + user.balance.play,
          withdrawable: user.balance.real,
        },
        stats: user.stats,
        activeTableId: user.activeTableId,
        vip: vipLevel,
      },
    });
  } catch (error: any) {
    console.error('GET /api/me error:', error);
    res.status(500).json({ error: 'No se pudo cargar el perfil' });
  }
});

// Nota: los endpoints /api/deposit y /api/withdraw conackers directos se
// eliminaron a proposito. Acreditar saldo sin una orden pagada era un agujero:
// el flujo correcto es /api/payment/deposit/order -> confirmar -> acreditar,
// y /api/payment/withdraw -> revision del operador -> liquidar.

// Historial de transacciones del usuario autenticado
app.get('/api/transactions', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const transactions = await Transaction.find({ telegramId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ transactions });
  } catch (error) {
    console.error('GET /api/transactions error:', error);
    res.status(500).json({ error: 'Error al obtener el historial' });
  }
});

// Serve Mini App (SPA fallback: todas las rutas profundidad -> index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../mini-app/dist/index.html'));
});

const PORT = process.env.PORT || 3000;

/**
 * Arranque.
 *
 * El orden importa: primero MongoDB (todo depende de el), despues las mesas
 * base (para que el lobby nunca este vacio) y por ultimo el gestor de mesas,
 * que recupera las manos interrumpidas por un reinicio anterior.
 */
const start = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cubapoker');
  logger.info('MongoDB conectado');

  await seatingService.seedTables();

  // El field manager se inyecta como coordinador del tick de mesas. Se hace
  // aqui y no con un import directo en table.manager.ts para que el nucleo del
  // juego no dependa del gestor de campos: se pueden probar y desplegar por
  // separado.
  tableManager.setFieldCoordinator(() => fieldManager.tick());

  await tableManager.start();

  app.listen(PORT, () => {
    logger.info(`CubaPoker escuchando en el puerto ${PORT}`);
    logger.info(`Mini App: ${process.env.MINI_APP_URL || '(sin configurar)'}`);
    logger.info(
      `Pagos: ${SIMULATION_ENABLED ? 'SIMULACION (sin dinero real)' : 'PRODUCCION'}`,
    );
    // El modo del bot se lee de lo que REALMENTE se ha configurado. Antes ponia
    // `polling (local)` siempre que no fuera produccion, incluso sin token, y decia
    // una cosa que no era la que estaba pasando.
    logger.info(
      `Bot: ${SIN_TOKEN ? 'MUDO (sin token: el juego va, el bot no habla con Telegram)' : USE_WEBHOOK ? 'webhook' : 'polling (local)'}`,
    );
  });

  // Limpieza de ordenes simuladas caducadas
  const pruneTimer = setInterval(() => pruneSimulatedOrders(), 5 * 60 * 1000);
  pruneTimer.unref();

  // ------------------------------------------------------------------
  // APAGADO LIMPIO
  //
  // Render manda SIGTERM antes de cada despliegue y cuando apaga el servicio. Sin
  // este manejador el proceso muere en el acto: el motor de poker esta a mitad de
  // una mano y las fichas de los jugadores no coinciden con el pot de la mesa.
  // Al arrancar otra vez, `refundTable` reembolsa las mesas cash, pero un campo a
  // medias queda pausado y sin nadie mirando (ver `/api/admin/paused-tables`).
  //
  // Lo que hace esto es PARAR el motor antes de morir, para que ningun tick
  // escriba a medias y los cambios lleguen enteros a Mongo.
  installShutdownHandlers();
};

/**
 * Cierre ordenado.
 *
 * No se intenta liquidar nada aqui. Es tentador, y estaria mal: liquidar un
 * campo a mitad de despliegue exige que todas las escrituras terminen, y si alguna
 * falla a medias el resultado es peor que pausar y que un humano decida.
 *
 * El presupuesto son 8 segundos. Si no se cierra a tiempo, Render mata el proceso
 * igual, asi que el plazo es para poder escribir el log, no para esperar. Y se
 * elige 8 y no 30 porque Render da 30 segundos antes del SIGKILL, pero un
 * despliegue que tarda 30 en caer se nota como caida.
 */
const installShutdownHandlers = (): void => {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      // Segundo SIGTERM: se esta insistiendo. Salir de inmediato.
      logger.warn(`${signal} repetido durante el apagado. Saliendo ya.`);
      process.exit(1);
    }
    shuttingDown = true;

    logger.info(`${signal} recibido. Deteniendo el motor (max 8s)...`);

    const forceExit = setTimeout(() => {
      logger.error('El apagado no termino a tiempo. Saliendo a la fuerza.');
      process.exit(1);
    }, 8000);
    forceExit.unref();

    // El motor para los timers y resuelve lo que ya esta en vuelo. `stop()` es
    // asincrono, y por eso el `forceExit` de arriba: si se queda colgado, no
    // esperamos indefinidamente.
    void shutdownEngine()
      .then(() => {
        clearTimeout(forceExit);
        logger.info('Motor detenido. Cerrando.');
        process.exit(0);
      })
      .catch((error) => {
        logger.error('Error en el apagado ordenado:', error);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Si el proceso lanza sin que se pueda capturar, se sale con codigo 1 para que
  // Render reinicie el servicio en vez de dejarlo en un estado raro.
  process.on('unhandledRejection', (reason) => {
    logger.error('Promesa rechazada sin capturar:', reason);
    shutdown('unhandledRejection');
  });
};

start().catch((error) => {
  logger.error('Fallo al arrancar:', error);
  process.exit(1);
});
