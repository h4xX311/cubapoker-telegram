/**
 * VIP ARENA: SALA CON PROFIT SHARE
 * ================================
 *
 * VIP Arena NO es una membresía. Es una sala de cash de high stakes con un
 * profit share semanal. Este test comprueba el dinero:
 *
 *   - El 15 % se calcula solo sobre eventos `arena: true`.
 *   - El rake de mesas normales no entra en el profit share de Arena.
 *   - Se paga una sola vez por jugador y semana.
 *   - Un profit share failed se reintenta sin duplicar el saldo.
 *   - El job paga a todos los que generaron rake en Arena.
 *   - El 3-Bet Club no se activa por jugar en Arena.
 *
 * Ejecutar:
 *   npm run build
 *   MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_arena_test \
 *     node scripts/test-vip-arena.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../dist/models/User');
const {
  RakeEvent,
  RakebackPayout,
  ArenaPayout,
} = require('../dist/models/Rakeback');
const { Transaction } = require('../dist/models/Transaction');
const { VIP, VIP_CONFIG } = require('../dist/models/VIP');
const { VIP_ARENA } = require('../dist/config/product');
const {
  rakebackService,
  startOfWeekUtc,
  weekKeyOf,
} = require('../dist/services/rakeback.service');

let ok = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    ok++;
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    console.log(`  FALLA ${name}${detail ? ' - ' + detail : ''}`);
  }
};

const crearUsuario = (id, saldo = 0) =>
  User.create({
    telegramId: id,
    firstName: 'Arena' + String(id).slice(-3),
    balance: { real: saldo, play: 0, realFromPrizes: 0 },
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

const saldo = async (id) =>
  (await User.findOne({ telegramId: id }))?.balance?.real ?? 0;

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI ||
      'mongodb://127.0.0.1:37017/cubapoker_arena_test',
  );
  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({});
  await db.collection('vips').deleteMany({});
  await db.collection('rakeevents').deleteMany({});
  await db.collection('rakebackpayouts').deleteMany({});
  await db.collection('arenapayouts').deleteMany({});
  await db.collection('transactions').deleteMany({});

  const ID = 881001;
  const ID_JOB = 881002;
  const ID_VIP = 881003;
  await crearUsuario(ID, 0);
  await crearUsuario(ID_JOB, 0);
  await crearUsuario(ID_VIP, 0);

  // Fecha fija para no depender del día en que se ejecute la prueba.
  const ahora = new Date('2026-10-21T12:00:00.000Z');
  const inicioActual = startOfWeekUtc(ahora);
  const inicioPrevia = new Date(inicioActual.getTime() - 7 * 86_400_000);
  const clave = weekKeyOf(inicioPrevia);
  const duranteLaSemana = new Date(inicioPrevia.getTime() + 86_400_000);

  console.log('\n=== 1. VIP Arena es una sala, no un plan ===\n');
  check(
    'VIP Arena tiene profit share del 15%',
    VIP_ARENA.profitSharePercent === 15,
    `percent=${VIP_ARENA.profitSharePercent}`,
  );
  check(
    'VIP Arena no está en los planes del 3-Bet Club',
    VIP_CONFIG.elite === undefined &&
      Object.keys(VIP_CONFIG).length === 2,
    `planes=${Object.keys(VIP_CONFIG).join(',')}`,
  );
  check(
    'el buy-in de Arena es 10.000 USDT (ciegas 50/100)',
    VIP_ARENA.buyInUsdt === 10_000 &&
      VIP_ARENA.blinds.small === 50 &&
      VIP_ARENA.blinds.big === 100,
  );

  console.log('\n=== 2. Solo el rake de Arena genera profit share ===\n');
  await RakeEvent.create({
    telegramId: ID,
    tableId: 'cash-arena-vieja',
    handNumber: 1,
    amount: 1_000,
    arena: true,
    at: duranteLaSemana,
  });
  // Rake de una mesa normal. No debe entrar en el cálculo de Arena.
  await RakeEvent.create({
    telegramId: ID,
    tableId: 'cash-normal-vieja',
    handNumber: 1,
    amount: 500,
    arena: false,
    at: duranteLaSemana,
  });

  const estado = await rakebackService.getArenaStatus(ID, ahora);
  check('la semana cerrada es la anterior', estado.weekKey === clave);
  check('solo cuenta el rake de Arena', estado.rakeUnits === 1_000, `rake=${estado.rakeUnits}`);
  check('el profit share es 15% del rake', estado.estimatedUnits === 150, `estimado=${estado.estimatedUnits}`);
  check('está disponible para cobrar', estado.claimableUnits === 150);
  check('no hay pago previo', estado.payoutStatus === 'none');

  console.log('\n=== 3. Pago idempotente ===\n');
  const pago = await rakebackService.payArenaWeekly(ID, ahora);
  check('paga 150 unidades (0,15 USDT)', pago.paid === 150, `pagado=${pago.paid}`);
  check('el saldo real sube exactamente 150', (await saldo(ID)) === 150, `saldo=${await saldo(ID)}`);

  const registro = await ArenaPayout.findOne({ telegramId: ID });
  check('el registro queda pagado', registro?.status === 'paid');
  check(
    'el registro guarda la tasa contratada',
    registro?.profitSharePercent === 15 && registro?.rakeUnits === 1_000,
    `rate=${registro?.profitSharePercent} rake=${registro?.rakeUnits}`,
  );

  const transaccion = await Transaction.findOne({
    telegramId: ID,
    type: 'arena_profit_share',
  });
  check('se registra en el libro como arena_profit_share', Boolean(transaccion));
  check('la transacción es por 150 unidades', transaccion?.amount === 150);
  check(
    'la transacción usa unidades internas, no USDT',
    transaccion?.currency === 'CUP',
    `currency=${transaccion?.currency}`,
  );

  const segundo = await rakebackService.payArenaWeekly(ID, ahora);
  check('el segundo cobro paga 0', segundo.paid === 0, `pagado=${segundo.paid}`);
  check('el saldo no cambia en el segundo cobro', (await saldo(ID)) === 150);

  const estadoPagado = await rakebackService.getArenaStatus(ID, ahora);
  check('ya no queda saldo cobrable', estadoPagado.claimableUnits === 0);
  check('el estado refleja el pago', estadoPagado.payoutStatus === 'paid');

  console.log('\n=== 4. Job de pagos de Arena ===\n');
  await RakeEvent.create({
    telegramId: ID_JOB,
    tableId: 'cash-arena-job',
    handNumber: 1,
    amount: 2_000,
    arena: true,
    at: duranteLaSemana,
  });

  const job = await rakebackService.payDueArenaPayouts(ahora);
  check('el job ve a los dos jugadores de Arena', job.players === 2, `players=${job.players}`);
  check('solo paga al que faltaba (300 unidades)', job.totalPaid === 300, `total=${job.totalPaid}`);
  check('el segundo jugador cobra 300', (await saldo(ID_JOB)) === 300, `saldo=${await saldo(ID_JOB)}`);

  const jobRepetido = await rakebackService.payDueArenaPayouts(ahora);
  check('repetir el job no vuelve a pagar', jobRepetido.totalPaid === 0, `total=${jobRepetido.totalPaid}`);

  console.log('\n=== 5. El motor marca las manos de Arena ===\n');
  const mesaArena = {
    tableId: 'cash-arena-mano',
    kind: 'cash',
    tierId: 'arena',
    hand: { handNumber: 9 },
    seats: [
      { kind: 'human', playerId: String(ID_JOB), totalBet: 100 },
      { kind: 'bot', playerId: 'bot-arena', totalBet: 100 },
    ],
  };
  await rakebackService.recordTableRake(mesaArena, 100);
  const eventoArena = await RakeEvent.findOne({ tableId: 'cash-arena-mano' });
  check('la mano de Arena se marca arena: true', eventoArena?.arena === true);
  check('solo se atribuye al humano', eventoArena?.telegramId === ID_JOB);

  const mesaNormal = {
    tableId: 'cash-normal-mano',
    kind: 'cash',
    tierId: 't100',
    hand: { handNumber: 10 },
    seats: [{ kind: 'human', playerId: String(ID_JOB), totalBet: 100 }],
  };
  await rakebackService.recordTableRake(mesaNormal, 100);
  const eventoNormal = await RakeEvent.findOne({ tableId: 'cash-normal-mano' });
  check('la mano normal se marca arena: false', eventoNormal?.arena === false);

  console.log('\n=== 6. Un miembro del 3-Bet cobra los dos programas ===\n');
  await VIP.create({
    telegramId: ID_VIP,
    level: 'basic',
    startDate: new Date(ahora.getTime() - 30 * 86_400_000),
    endDate: new Date(ahora.getTime() + 30 * 86_400_000),
    rakebackPercent: 10,
    rakeDiscount: 0,
  });
  await RakeEvent.create({
    telegramId: ID_VIP,
    tableId: 'cash-arena-vip',
    handNumber: 1,
    amount: 1_000,
    arena: true,
    at: duranteLaSemana,
  });
  await RakeEvent.create({
    telegramId: ID_VIP,
    tableId: 'cash-normal-vip',
    handNumber: 1,
    amount: 500,
    arena: false,
    at: duranteLaSemana,
  });

  const estadoVip = await rakebackService.getStatus(ID_VIP, ahora);
  check('el 3-Bet cuenta TODO el rake cash, incluido Arena', estadoVip.claimableUnits === 150, `claimable=${estadoVip.claimableUnits}`);
  const arenaVip = await rakebackService.getArenaStatus(ID_VIP, ahora);
  check('Arena calcula su 15% solo sobre el rake de Arena', arenaVip.claimableUnits === 150, `claimable=${arenaVip.claimableUnits}`);

  const pagoBase = await rakebackService.payWeeklyRakeback(ID_VIP, ahora);
  const pagoArena = await rakebackService.payArenaWeekly(ID_VIP, ahora);
  check('el 3-Bet paga 150 unidades', pagoBase.paid === 150, `pagado=${pagoBase.paid}`);
  check('Arena paga otras 150 unidades', pagoArena.paid === 150, `pagado=${pagoArena.paid}`);
  check('el jugador cobra 300 en total, no 150', (await saldo(ID_VIP)) === 300, `saldo=${await saldo(ID_VIP)}`);

  const payoutsBase = await RakebackPayout.countDocuments({ telegramId: ID_VIP });
  const payoutsArena = await ArenaPayout.countDocuments({ telegramId: ID_VIP });
  check('cada programa guarda su propio pago', payoutsBase === 1 && payoutsArena === 1, `base=${payoutsBase} arena=${payoutsArena}`);

  console.log('\n=== 7. Arena no activa el 3-Bet Club ===\n');
  const estado3Bet = await rakebackService.getStatus(ID, ahora);
  check('jugar en Arena no crea una membresía', estado3Bet.active === false);
  check('tampoco genera rakeback del 3-Bet', estado3Bet.claimableUnits === 0);

  console.log('\n=== 8. Reintento seguro de un profit share failed ===\n');
  const ID_ARENA_FALLO = 881004;
  await crearUsuario(ID_ARENA_FALLO, 0);
  await RakeEvent.create({
    telegramId: ID_ARENA_FALLO,
    tableId: 'cash-arena-fallo',
    handNumber: 1,
    amount: 1_000,
    arena: true,
    at: duranteLaSemana,
  });
  await ArenaPayout.create({
    telegramId: ID_ARENA_FALLO,
    weekKey: clave,
    rakeUnits: 1_000,
    profitSharePercent: 15,
    amountUnits: 150,
    creditKey: `arena_profit_share:${clave}`,
    status: 'failed',
    error: 'fallo simulado antes de acreditar',
  });

  const pagoFallido = await rakebackService.payArenaWeekly(
    ID_ARENA_FALLO,
    ahora,
  );
  check(
    'un failed de Arena se reintenta y paga 150',
    pagoFallido.paid === 150,
    `pagó=${pagoFallido.paid}`,
  );
  check(
    'el saldo de Arena sube exactamente 150',
    (await saldo(ID_ARENA_FALLO)) === 150,
    `saldo=${await saldo(ID_ARENA_FALLO)}`,
  );
  check(
    'el registro de Arena queda paid',
    (await ArenaPayout.findOne({
      telegramId: ID_ARENA_FALLO,
      weekKey: clave,
    }))?.status === 'paid',
  );
  const segundoIntento = await rakebackService.payArenaWeekly(
    ID_ARENA_FALLO,
    ahora,
  );
  check(
    'el segundo intento de Arena paga 0',
    segundoIntento.paid === 0 && (await saldo(ID_ARENA_FALLO)) === 150,
    `pagó=${segundoIntento.paid} saldo=${await saldo(ID_ARENA_FALLO)}`,
  );

  console.log(`\n${'='.repeat(56)}`);
  console.log(`Resultado: ${ok} correctos, ${fail} fallidos`);
  if (fail > 0) {
    console.log('Un fallo aquí es dinero que se paga mal o no se paga.');
  }
  console.log('='.repeat(56));

  await db.collection('users').deleteMany({});
  await db.collection('vips').deleteMany({});
  await db.collection('rakeevents').deleteMany({});
  await db.collection('rakebackpayouts').deleteMany({});
  await db.collection('arenapayouts').deleteMany({});
  await db.collection('transactions').deleteMany({});
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('ERROR DEL TEST:', error);
  process.exit(1);
});
