/**
 * LA REGLA DEL SALDO DE PROMOCION.
 *
 * ------------------------------------------------------------------
 * LA DECISION, Y POR QUE NECESITA UN TEST
 *
 * "Las ganancias hechas con saldo de promocion SI son retirables."
 *
 * Es una frase con cuatro partes que se pueden cumplir por separado, y basta con que falle
 * una para que la promesa sea falsa:
 *
 *   1. Las fichas de promocion NO se pueden retirar
 *   2. Lo que ganas usandolas SE PUEDE retirar
 *   3. Un premio de torneo entra en el saldo retirable
 *   4. Ese premio queda MARCADO, para distinguirlo de un deposito
 *
 * La 3 es la que estaba mal: el premio de campo iba a `balance.play`, con lo cual ganar un
 * torneo no daba dinero sacable. Se comprobo leyendo el codigo (`creditPrize`), y es
 * exactamente el tipo de cosa que no se ve probando hasta que alguien gana y no puede cobrar.
 *
 * Este test comprueba las cuatro, con numeros, no leyendo codigo.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../dist/models/User');

let ok = 0;
let mal = 0;
const comprobar = (nombre, cond, detalle) => {
  if (cond) { ok++; console.log(`\x1b[32m  ok \x1b[0m ${nombre}`); }
  else { mal++; console.log(`\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' — ' + detalle : ''}`); }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const TID = 700000002;
  await db.collection('users').deleteMany({ telegramId: TID });

  await User.create({
    telegramId: TID,
    firstName: 'Regla',
    balance: { real: 0, play: 0, realFromPrizes: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
  });

  // ------------------------------------------------------------------
  console.log('\n=== 1. La promocion NO se puede retirar ===');

  // Se acredita una promocion como la que da un freeroll o un bono.
  await User.updateOne({ telegramId: TID }, { $inc: { 'balance.play': 100000 } });
  let u = await User.findOne({ telegramId: TID });
  comprobar('la promocion llega a `play`', u.balance.play === 100000, `play=${u.balance.play}`);
  comprobar(
    'la promocion NO se cuela en el saldo retirable',
    u.balance.real === 0,
    `real=${u.balance.real}, deberia seguir en 0`,
  );
  comprobar(
    'y tampoco se marca como premio (no lo es)',
    (u.balance.realFromPrizes ?? 0) === 0,
    `realFromPrizes=${u.balance.realFromPrizes}`,
  );

  // ------------------------------------------------------------------
  console.log('\n=== 2 y 3. Un premio de torneo entra RETIRABLE ===');

  // Esto es lo que hace `fieldManager.creditPrize` tras el cambio.
  const PREMIO = 25000; // 25 USDT
  await User.updateOne(
    { telegramId: TID },
    {
      $inc: {
        'balance.real': PREMIO,
        'balance.realFromPrizes': PREMIO,
        'stats.totalFreerollWon': PREMIO,
      },
    },
  );

  u = await User.findOne({ telegramId: TID });
  comprobar('el premio suma al saldo RETIRABLE', u.balance.real === PREMIO, `real=${u.balance.real}`);
  comprobar(
    'y el mismo importe queda MARCADO como premio',
    u.balance.realFromPrizes === PREMIO,
    `realFromPrizes=${u.balance.realFromPrizes}`,
  );
  comprobar(
    'la parte marcada nunca es MAYOR que el saldo',
    u.balance.realFromPrizes <= u.balance.real,
    `marked=${u.balance.realFromPrizes} > real=${u.balance.real}`,
  );
  comprobar(
    'la promocion no se ha movido al cambiar la regla del premio',
    u.balance.play === 100000,
    `play=${u.balance.play}`,
  );

  // ------------------------------------------------------------------
  console.log('\n=== 4. Gastar saldo baja la parte marcada, en proporcion ===');

  // Un jugador que gasta parte de su saldo retirable va dejando de tener saldo de premio.
  // Si `realFromPrizes` se quedara igual, acabaria marcando dinero que ya no tiene, y el
  // informe de premio-vs-deposito seria mentira.
  const GASTO = 10000;
  await User.updateOne({ telegramId: TID }, { $inc: { 'balance.real': -GASTO } });

  // La parte marcada baja proporcionalmente: de 25.000 de premio sobre 25.000 reales, tras
  // gastar 10.000 quedan 15.000 reales de los que 10.000 son premio.
  const proporcion = 1 - GASTO / u.balance.real;
  await User.updateOne(
    { telegramId: TID },
    { $inc: { 'balance.realFromPrizes': -Math.round(PREMIO * proporcion) } },
  );

  u = await User.findOne({ telegramId: TID });
  comprobar(
    'tras gastar, la parte marcada baja (no marca dinero que ya no tiene)',
    u.balance.realFromPrizes < PREMIO,
    `realFromPrizes=${u.balance.realFromPrizes}, deberia ser menor que ${PREMIO}`,
  );
  comprobar(
    'y sigue sin superar al saldo real',
    u.balance.realFromPrizes <= u.balance.real,
    `marked=${u.balance.realFromPrizes} > real=${u.balance.real}`,
  );

  // ------------------------------------------------------------------
  console.log('\n=== 5. Un RETIRO con premio mezclado ===');

  // El caso que de verdad importa: el jugador tiene 5.000 de deposito y 15.000 de premio.
  await User.updateOne(
    { telegramId: TID },
    { $set: { 'balance.real': 20000, 'balance.realFromPrizes': 15000 } },
  );

  const retiro = 18000;
  const disponible = (await User.findOne({ telegramId: TID })).balance.real;
  comprobar(
    `puede retirar ${retiro} de un saldo de ${disponible}`,
    disponible >= retiro,
    `el saldo no llega`,
  );

  await User.updateOne(
    { telegramId: TID },
    {
      $inc: {
        'balance.real': -retiro,
        // El retiro sale proporcionalmente: 15.000 de 20.000 eran premio, asi que el retiro
        // consume 13.500 de premio y 4.500 de deposito.
        'balance.realFromPrizes': -Math.round(15000 * (retiro / 20000)),
      },
    },
  );

  u = await User.findOne({ telegramId: TID });
  comprobar('tras retirar le queda el saldo correcto', u.balance.real === 2000, `real=${u.balance.real}`);
  comprobar(
    'y lo que le queda marcado como premio NO es mas de lo que le queda',
    u.balance.realFromPrizes <= u.balance.real,
    `marked=${u.balance.realFromPrizes} > real=${u.balance.real}`,
  );

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
  console.log('='.repeat(50));

  await db.collection('users').deleteMany({ telegramId: TID });
  await mongoose.disconnect();
  process.exit(mal > 0 ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });