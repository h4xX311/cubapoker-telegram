/**
 * CENTROLL CON BOTS: EL PREMIO DEL BOT SE QUEDA EN LA CASA
 *
 * ------------------------------------------------------------------
 * LA REGLA
 *
 * Los bots rellenan la mesa hasta el minimo y no pagan buy-in. Si un bot
 * termina en una posicion premiada, ese tramo NO se paga a nadie: se queda en
 * la casa. Tampoco puede acabar en el bolsillo del ganador humano por el
 * mecanismo de "posiciones sin adjudicar".
 *
 * El caso que fija este test es el peor de todos: gana un bot. El humano
 * segundo y el humano tercero tienen que cobrar exactamente lo suyo (9 y 6 de
 * un premio de 30), y el 15 del primer puesto no puede aparecer en ninguna
 * cartera humana. El margen de la casa es 100 - 15 = 85.
 *
 * Ejecutar:
 *   npm run build
 *   MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_centroll_bots \
 *     node scripts/test-centroll-bots.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Field } = require('../dist/models/Field');
const { Table } = require('../dist/models/Table');
const { User } = require('../dist/models/User');
const { fieldManager } = require('../dist/game/field.manager');
const { CENTROLL, FREEROLL_PAYOUT } = require('../dist/config/product');

const URI =
  process.env.MONGODB_URI ||
  'mongodb://127.0.0.1:37017/cubapoker_centroll_bots';

let ok = 0;
let fail = 0;
const check = (nombre, cond, detalle = '') => {
  if (cond) {
    ok++;
    console.log(`  OK   ${nombre}`);
  } else {
    fail++;
    console.log(`  FALLA ${nombre} ${detalle}`);
  }
};

const crearJugador = (id) =>
  User.create({
    telegramId: id,
    firstName: 'C' + String(id).slice(-3),
    balance: { real: 0, play: 0, realFromPrizes: 0 },
    stats: {
      handsPlayed: 0,
      handsWon: 0,
      tablesJoined: 0,
      freerollsPlayed: 0,
      totalRakePaid: 0,
      totalFreerollWon: 0,
    },
    activeTableId: null,
  });

(async () => {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({});
  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});

  // Bote de 100 unidades: 10 humanos pagaron 10 cada uno. El premio del
  // centroll es el 30 % = 30 unidades, repartido 15 / 9 / 6.
  const ids = { segundo: 74002, tercero: 74003 };
  for (const id of Object.values(ids)) await crearJugador(id);

  const field = await Field.create({
    fieldId: 'centroll-bots-test',
    kind: 'centroll',
    tierId: 'centroll-bots-test',
    status: 'running',
    buyInUnits: 10,
    buyInsCollected: 100,
    targetField: 100,
    waiting: 0,
    seated: 10,
    playersRemaining: 1,
    paidPositionsLeft: FREEROLL_PAYOUT.length,
    results: [
      // El segundo y el tercero son humanos. El primer puesto lo ocupa un bot
      // que sigue vivo: no esta en `results`, se pasa como `winner`.
      { position: 2, telegramId: ids.segundo, username: 'Segundo', amount: 0 },
      { position: 3, telegramId: ids.tercero, username: 'Tercero', amount: 0 },
    ],
    tables: [],
  });

  const botGanador = {
    index: 0,
    kind: 'bot',
    playerId: 'bot-centroll-1',
    displayName: 'BotUno',
    chips: 10000,
    bet: 0,
    status: 'active',
  };

  await Table.create({
    tableId: 'centroll-bots-test-t1',
    kind: 'centroll',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 10,
    startChips: CENTROLL.startingChips,
    maxSeats: 7,
    seats: [
      botGanador,
      {
        index: 1,
        kind: 'human',
        playerId: String(ids.segundo),
        displayName: 'Segundo',
        chips: 0,
        bet: 0,
        status: 'out',
      },
      {
        index: 2,
        kind: 'human',
        playerId: String(ids.tercero),
        displayName: 'Tercero',
        chips: 0,
        bet: 0,
        status: 'out',
      },
    ],
    field: {
      fieldId: field.fieldId,
      tableNumber: 1,
      targetField: 100,
      registered: 10,
      seated: 10,
      fieldStatus: 'running',
    },
  });

  const resultado = await fieldManager.settleField(field, botGanador);

  const segundo = await User.findOne({ telegramId: ids.segundo });
  const tercero = await User.findOne({ telegramId: ids.tercero });
  const campo = await Field.findOne({ fieldId: field.fieldId });

  console.log('');
  console.log(
    `  bote=${field.buyInsCollected} premio=30 repartido a humanos=${resultado.totalPaid} ` +
      `rakeCollected=${campo.rakeCollected}`,
  );
  console.log(
    `  play: segundo=${segundo.balance.play} tercero=${tercero.balance.play} ` +
      `real: ${segundo.balance.real}/${tercero.balance.real}`,
  );
  console.log('');

  check(
    'el segundo humano cobra 9 unidades en balance.play',
    segundo.balance.play === 9,
    `play=${segundo.balance.play}`,
  );
  check(
    'el tercer humano cobra 6 unidades en balance.play',
    tercero.balance.play === 6,
    `play=${tercero.balance.play}`,
  );
  check(
    'el premio del bot (15) NO se paga a ningun humano',
    resultado.totalPaid === 15,
    `repartido=${resultado.totalPaid}`,
  );
  check(
    'la casa retiene el 70 % mas el tramo del bot (85)',
    campo.rakeCollected === 85,
    `rakeCollected=${campo.rakeCollected}`,
  );
  check(
    'nadie cobra en balance.real (sigue siendo promocion)',
    segundo.balance.real === 0 && tercero.balance.real === 0,
  );
  check('el campo queda finished', campo.status === 'finished', `status=${campo.status}`);

  await mongoose.disconnect();
  console.log('');
  console.log(`Resultado: ${ok} correctos, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('ERROR DEL TEST:', err);
  process.exit(1);
});
