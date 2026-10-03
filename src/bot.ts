import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import healthRouter from './health';
import { createGameRoutes } from './game/polling';
import monetizationRoutes from './routes/monetization.routes';
import { monetizationService } from './services/monetization.service';
import { requireTelegramAuth, getAuthedTelegramId } from './middleware/telegramAuth';
import { User } from './models/User';
import { Game } from './models/Game';
import { Transaction } from './models/Transaction';
import { VIP_CONFIG, VIPLevel } from './models/VIP';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../mini-app/dist')));

// Health check
app.use('/health', healthRouter);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cubapoker-telegram')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });

// Game Routes
app.use('/api/game', createGameRoutes(bot));

// Monetization Routes
app.use('/api/monetization', monetizationRoutes);

// Commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from!;

  await User.findOneAndUpdate(
    { telegramId: user.id },
    {
      telegramId: user.id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
    },
    { upsert: true, new: true }
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

  if (dbUser.balance.credits < 100) {
    bot.sendMessage(chatId, '❌ Necesitas al menos 100 CUP para jugar. Usa /deposit para depositar.');
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🎮 Entrar a la mesa', web_app: { url: `${process.env.MINI_APP_URL}/game` } }],
    ]
  };

  bot.sendMessage(chatId, '🎮 *Mesa de Poker*\n\nBalance: ' + dbUser.balance.credits + ' CUP', {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
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

• Créditos: ${dbUser.balance.credits} CUP
• USDT: ${dbUser.balance.usdt.toFixed(2)}

👑 *VIP:* ${vipLevel ? VIP_CONFIG[vipLevel].name : 'No VIP'}
🔥 *Racha:* ${streak.current} días

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
        balance: user.balance,
        vip: vipLevel,
      },
    });
  } catch (error: any) {
    console.error('GET /api/me error:', error);
    res.status(500).json({ error: 'No se pudo cargar el perfil' });
  }
});

app.post('/api/deposit', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const amount = Number(req.body.amount);
    const method = req.body.method;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    if (!['enzona', 'qvapay', 'usdt'].includes(method)) {
      return res.status(400).json({ error: 'Método de pago inválido' });
    }

    const result = await monetizationService.processDeposit(
      telegramId,
      amount,
      method,
      req.body.externalId
    );

    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('POST /api/deposit error:', error);
    res.status(500).json({ error: error.message || 'Error al procesar el depósito' });
  }
});

app.post('/api/withdraw', requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const amount = Number(req.body.amount);
    const method = req.body.method;
    const address = req.body.address;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    if (!['enzona', 'qvapay', 'usdt'].includes(method)) {
      return res.status(400).json({ error: 'Método de retiro inválido' });
    }

    const result = await monetizationService.processWithdrawal(
      telegramId,
      amount,
      method,
      address
    );

    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('POST /api/withdraw error:', error);
    res.status(400).json({ error: error.message || 'Error al procesar el retiro' });
  }
});

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
app.listen(PORT, () => {
  console.log(`🚀 CubaPoker Telegram Bot running on port ${PORT}`);
  console.log(`📱 Mini App URL: ${process.env.MINI_APP_URL}`);
  console.log(`🔒 Autenticación de Mini App: activa`);
  console.log(`💰 Monetization system initialized`);
});
