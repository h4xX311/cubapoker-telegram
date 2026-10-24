/**
 * LIQUIDACION DEL CENTROLL
 * ========================
 *
 * El centroll se liquida por `fieldManager.tick()`, el mismo camino que un campo
 * de cash. Hasta ahora `settleField` solo distinguia `freeroll` de todo lo demas:
 *
 *   const esFreeroll = field.kind === 'freeroll';
 *
 * Un centroll caia en la rama de CASH: rake del 5 %, reparto 45/25/15/9/6 y pago
 * a `balance.real` (retirable). Eso contradice la regla del producto:
 *
 *   - premio = 30 % del bote
 *   - reparto 50/30/20
 *   - destino `balance.play` (promocion, no retirable)
 *
 * Este test monta un centroll de 10 jugadores (bote de 100 unidades) con 3 plazas
 * pagadas y comprueba la liquidacion real. Antes del arreglo falla: los premios
 * llegan a `balance.real` y por el 95 % del bote.
 *
 * Ejecutar: node scripts/test-centroll-liquidacion.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Field } = require('../dist/models/Field');
const { Table } = require('../dist/models/Table');
const { User } = require('../dist/models/User');
const { fieldManager } = require('../dist/game/field.manager');
const { CENTROLL, FREEROLL_PAYOUT } = require('../dist/config/product');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_centroll_liq';

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

  const ids = { primero: 73001, segundo: 73002, tercero: 73003 };
  for (const id of Object.values(ids)) await crearJugador(id);

  // 10 jugadores x 10 unidades = 100 unidades de bote.
  // El premio del centroll es el 30 %: 30 unidades (0,03 USDT).
  const field = await Field.create({
    fieldId: 'centroll-liq-test',
    kind: 'centroll',
    tierId: 'centroll',
    status: 'running',
    buyInUnits: 10,
    buyInsCollected: 100,
    targetField: 100,
    waiting: 0,
    seated: 10,
    playersRemaining: 1,
    paidPositionsLeft: FREEROLL_PAYOUT.length,
    results: [
      { position: 2, telegramId: ids.segundo, username: 'Segundo', amount: 0 },
      { position: 3, telegramId: ids.tercero, username: 'Tercero', amount: 0 },
    ],
    tables: [],
  });

  const ganador = {
    index: 0,
    kind: 'human',
    playerId: String(ids.primero),
    displayName: 'Primero',
    chips: 10000, // se lleva las 10.000 fichas de la mesa
    bet: 0,
    status: 'active',
  };
  await Table.create({
    tableId: 'centroll-liq-test-t1',
    kind: 'centroll',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 10,
    maxSeats: 7,
    seats: [
      ganador,
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

  const resultado = await fieldManager.settleField(field, ganador);

  const u = {};
  for (const [nombre, id] of Object.entries(ids)) {
    u[nombre] = await User.findOne({ telegramId: id });
  }
  const campo = await Field.findOne({ fieldId: field.fieldId });
  const premioEsperado = Math.floor((field.buyInsCollected * CENTROLL.prizeMultiplier) / 100);

  console.log('');
  console.log(
    `  bote=${field.buyInsCollected} premio esperado=${premioEsperado} repartido=${resultado.totalPaid}`,
  );
  console.log(
    `  play: ${u.primero.balance.play}/${u.segundo.balance.play}/${u.tercero.balance.play}  ` +
      `real: ${u.primero.balance.real}/${u.segundo.balance.real}/${u.tercero.balance.real}  ` +
      `rakeCollected=${campo.rakeCollected}`,
  );
  console.log('');

  check(
    'el ganador cobra 15 unidades en balance.play',
    u.primero.balance.play === 15,
    `play=${u.primero.balance.play}`,
  );
  check(
    'el 2.º cobra 9 unidades en balance.play',
    u.segundo.balance.play === 9,
    `play=${u.segundo.balance.play}`,
  );
  check(
    'el 3.º cobra 6 unidades en balance.play',
    u.tercero.balance.play === 6,
    `play=${u.tercero.balance.play}`,
  );
  check(
    'nadie cobra en balance.real (no es retirable)',
    u.primero.balance.real === 0 && u.segundo.balance.real === 0 && u.tercero.balance.real === 0,
  );
  check(
    'lo repartido es el 30 % del bote (30 unidades)',
    resultado.totalPaid === 30,
    `repartido=${resultado.totalPaid}`,
  );
  check(
    'la casa retiene el 70 % (rakeCollected=70)',
    campo.rakeCollected === 70,
    `rakeCollected=${campo.rakeCollected}`,
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
