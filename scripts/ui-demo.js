/**
 * Usuario de demostracion para revisar el lobby en un navegador.
 *
 * NO se usa en produccion. Sirve para que la Mini App tenga un jugador con saldo y
 * estadisticas realistas cuando se abre con DEV_AUTH_BYPASS.
 */
const mongoose = require('mongoose');
const { User } = require('../dist/models/User');

(async () => {
  await mongoose.connect('mongodb://127.0.0.1:37017/cubapoker_ui');
  const db = mongoose.connection.db;

  await db.collection('users').deleteMany({});
  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});

  await User.create({
    telegramId: 777001,
    firstName: 'Carlos',
    lastName: 'Hernandez',
    username: 'carlos_h',
    balance: {
      real: 24500, // 24,50 USDT
      play: 3200, // 3,20 USDT
      total: 27700,
      realFromPrizes: 0,
    },
    stats: {
      handsPlayed: 348,
      handsWon: 41,
      tablesJoined: 12,
      freerollsPlayed: 7,
      totalRakePaid: 1840,
      totalFreerollWon: 3200,
    },
    activeTableId: null,
    vip: null,
  });

  console.log('Usuario de demostracion listo: Carlos, 24,50 + 3,20 USDT.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
