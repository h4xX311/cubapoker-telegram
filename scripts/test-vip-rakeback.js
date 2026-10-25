/**
 * 3-BET CLUB: RAKEBACK SEMANAL
 * ============================
 *
 * Comprueba el dinero, no la interfaz:
 *
 *   - La compra descuenta exactamente 35 USDT (35.000 unidades).
 *   - VIP Arena no se puede comprar.
 *   - El rake de una mano se atribuye a los humanos según lo que aportaron.
 *   - El rakeback de la semana cerrada es el 10% y se paga una sola vez.
 *   - Una membresía vencida esta semana todavía cobra la semana pasada.
 *   - Renovar suma días al final, no reinicia el periodo.
 *
 * Ejecutar:
 *   npm run build
 *   MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_vip_test \
 *     node scripts/test-vip-rakeback.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../dist/models/User');
const { VIP, VIP_CONFIG } = require('../dist/models/VIP');
const { RakeEvent, RakebackPayout } = require('../dist/models/Rakeback');
const { Transaction } = require('../dist/models/Transaction');
const { monetizationService } = require('../dist/services/monetization.service');
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
    console.log(`  FALLA ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const crearUsuario = (id, saldo) =>
  User.create({
    telegramId: id,
    firstName: 'VIP' + String(id).slice(-3),
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
      'mongodb://127.0.0.1:37017/cubapoker_vip_test',
  );
  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({});
  await db.collection('vips').deleteMany({});
  await db.collection('rakebackpayouts').deleteMany({});
  await db.collection('arenapayouts').deleteMany({});
  await db.collection('rakeevents').deleteMany({});
  await db.collection('transactions').deleteMany({});

  const ID = 880001;
  const ID_VENCIDO = 880002;
  const ID_SIN_VIP = 880003;
  const ID_CONCURRENTE = 880004;
  const ID_RENOVAR_VENCIDO = 880005;
  await crearUsuario(ID, 200_000);
  await crearUsuario(ID_VENCIDO, 200_000);
  await crearUsuario(ID_SIN_VIP, 0);
  await crearUsuario(ID_CONCURRENTE, 100_000);
  await crearUsuario(ID_RENOVAR_VENCIDO, 100_000);

  console.log('\n=== 1. Compra del plan mensual ===\n');
  const comprado = await monetizationService.purchaseVIP(ID, 'basic');
  check('la compra devuelve true', comprado === true);
  check(
    'descuenta 35 USDT (35.000 unidades)',
    (await saldo(ID)) === 165_000,
    `saldo=${await saldo(ID)}`,
  );

  const vip = await VIP.findOne({ telegramId: ID });
  check('guarda el nivel basic', vip?.level === 'basic', `nivel=${vip?.level}`);
  check(
    'guarda 10% de rakeback, no un descuento de rake',
    vip?.rakebackPercent === 10 && vip?.rakeDiscount === 0,
    `rakeback=${vip?.rakebackPercent} rakeDiscount=${vip?.rakeDiscount}`,
  );
  check(
    'el precio del plan es 35 USDT',
    VIP_CONFIG.basic.price === 35_000,
    `precio=${VIP_CONFIG.basic.price}`,
  );
  const txCompra = await Transaction.findOne({
    telegramId: ID,
    type: 'vip_purchase',
  });
  check(
    'el libro guarda unidades internas, no 35.000 USDT',
    txCompra?.amount === 35_000 && txCompra?.currency === 'CUP',
    `amount=${txCompra?.amount} currency=${txCompra?.currency}`,
  );

  check(
    'VIP Arena no aparece como plan de membresía',
    VIP_CONFIG.elite === undefined,
    `planes=${Object.keys(VIP_CONFIG).join(',')}`,
  );
  const saldoAntesArena = await saldo(ID);
  const arenaComoPlan = await monetizationService.purchaseVIP(ID, 'elite');
  check('VIP Arena no se puede comprar como plan', arenaComoPlan === false);
  check(
    'el intento de comprar VIP Arena no toca el saldo',
    (await saldo(ID)) === saldoAntesArena,
    `saldo=${await saldo(ID)}`,
  );

  console.log('\n=== 2. Atribución del rake por jugador ===\n');
  const mesa = {
    tableId: 'cash-vip-test',
    kind: 'cash',
    hand: { handNumber: 7 },
    seats: [
      { kind: 'human', playerId: String(ID), totalBet: 60 },
      { kind: 'human', playerId: String(ID_VENCIDO), totalBet: 40 },
      { kind: 'bot', playerId: 'bot-1', totalBet: 999 },
    ],
  };
  await rakebackService.recordTableRake(mesa, 100);

  const eventos = await RakeEvent.find({ tableId: 'cash-vip-test' }).sort({
    amount: -1,
  });
  check('se anotan solo los humanos', eventos.length === 2, `hay ${eventos.length}`);
  check(
    'el que aportó 60 recibe 60 de rake',
    eventos.find((e) => e.telegramId === ID)?.amount === 60,
    `amount=${eventos.find((e) => e.telegramId === ID)?.amount}`,
  );
  check(
    'el que aportó 40 recibe 40 de rake',
    eventos.find((e) => e.telegramId === ID_VENCIDO)?.amount === 40,
    `amount=${eventos.find((e) => e.telegramId === ID_VENCIDO)?.amount}`,
  );

  // La misma mano no puede contarse dos veces si finishHand se reintenta.
  await rakebackService.recordTableRake(mesa, 100);
  const repetidos = await RakeEvent.countDocuments({
    tableId: 'cash-vip-test',
  });
  check(
    'reintentar la misma mano no duplica el rake',
    repetidos === 2,
    `hay ${repetidos}`,
  );

  console.log('\n=== 3. Rakeback de la semana cerrada ===\n');
  const ahora = new Date();
  const inicioSemana = startOfWeekUtc(ahora);
  const inicioPrevia = new Date(inicioSemana.getTime() - 7 * 86_400_000);
  const clave = weekKeyOf(inicioPrevia);

  // La membresía se compró hoy; para probar la semana pasada se mueve el inicio.
  await VIP.updateOne(
    { telegramId: ID },
    {
      $set: {
        startDate: new Date(inicioPrevia.getTime() - 86_400_000),
        endDate: new Date(ahora.getTime() + 10 * 86_400_000),
      },
    },
  );

  await RakeEvent.create([
    {
      telegramId: ID,
      tableId: 'cash-vip-test',
      handNumber: 8,
      amount: 6_000,
      at: new Date(inicioPrevia.getTime() + 3_600_000),
    },
    {
      telegramId: ID,
      tableId: 'cash-vip-test',
      handNumber: 9,
      amount: 4_000,
      at: new Date(inicioPrevia.getTime() + 7_200_000),
    },
  ]);

  const estado = await rakebackService.getStatus(ID, ahora);
  check('la membresía está activa', estado.active === true);
  check(
    'suma los 10.000 de rake de la semana',
    estado.rakeUnits === 10_000,
    `rake=${estado.rakeUnits}`,
  );
  check(
    'el 10% son 1.000 unidades',
    estado.estimatedUnits === 1_000 && estado.claimableUnits === 1_000,
    `estimado=${estado.estimatedUnits} cobrable=${estado.claimableUnits}`,
  );
  check('la clave es la del lunes pasado', estado.weekKey === clave);

  const saldoAntesPago = await saldo(ID);
  const pago1 = await rakebackService.payWeeklyRakeback(ID, ahora);
  check('paga 1.000 unidades', pago1.paid === 1_000, `pagó=${pago1.paid}`);
  check(
    'el saldo retirable sube exactamente 1.000',
    (await saldo(ID)) === saldoAntesPago + 1_000,
    `saldo=${await saldo(ID)}`,
  );

  const registro = await RakebackPayout.findOne({ telegramId: ID, weekKey: clave });
  check('el pago queda marcado como paid', registro?.status === 'paid');
  const tx = await Transaction.findOne({ telegramId: ID, type: 'vip_rakeback' });
  check('queda una transacción de rakeback', Boolean(tx), `tx=${tx?._id}`);
  check(
    'el rakeback se anota en unidades internas, no en USDT',
    tx?.amount === 1_000 && tx?.currency === 'CUP',
    `amount=${tx?.amount} currency=${tx?.currency}`,
  );

  const saldoDespues = await saldo(ID);
  const pago2 = await rakebackService.payWeeklyRakeback(ID, ahora);
  check('el segundo cobro paga 0', pago2.paid === 0, `pagó=${pago2.paid}`);
  check(
    'el segundo cobro no toca el saldo',
    (await saldo(ID)) === saldoDespues,
    `saldo=${await saldo(ID)}`,
  );

  console.log('\n=== 4. Membresía vencida esta semana ===\n');
  await monetizationService.purchaseVIP(ID_VENCIDO, 'basic');
  await VIP.updateOne(
    { telegramId: ID_VENCIDO },
    {
      $set: {
        startDate: new Date(inicioPrevia.getTime() - 86_400_000),
        endDate: new Date(ahora.getTime() - 86_400_000),
        rakebackPercent: 10,
      },
    },
  );
  await RakeEvent.create({
    telegramId: ID_VENCIDO,
    tableId: 'cash-vip-test',
    handNumber: 10,
    amount: 5_000,
    at: new Date(inicioPrevia.getTime() + 10_000_000),
  });

  const estadoVencido = await rakebackService.getStatus(ID_VENCIDO, ahora);
  check('la membresía ya no está activa', estadoVencido.active === false);
  check(
    'pero todavía cobra la semana pasada (500)',
    estadoVencido.claimableUnits === 500,
    `cobrable=${estadoVencido.claimableUnits}`,
  );
  // Se usa el job, no el cobro manual: si el job solo buscara membresías con
  // `endDate > now`, esta se quedaría sin pagar para siempre.
  const saldoVencidoAntes = await saldo(ID_VENCIDO);
  const lote = await rakebackService.payDuePayouts(ahora);
  check(
    'el job incluye a la membresía vencida y paga 500',
    lote.totalPaid === 500,
    `pagó=${lote.totalPaid}`,
  );
  check(
    'el saldo de la membresía vencida sube 500',
    (await saldo(ID_VENCIDO)) === saldoVencidoAntes + 500,
    `saldo=${await saldo(ID_VENCIDO)}`,
  );

  console.log('\n=== 5. Renovación ===\n');
  const antesRenovar = await VIP.findOne({ telegramId: ID });
  const finAnterior = antesRenovar.endDate.getTime();
  await monetizationService.purchaseVIP(ID, 'basic');
  const despuesRenovar = await VIP.findOne({ telegramId: ID });
  check(
    'renovar suma 30 días al final',
    Math.abs(despuesRenovar.endDate.getTime() - (finAnterior + 30 * 86_400_000)) < 1000,
    `antes=${new Date(finAnterior).toISOString()} despues=${despuesRenovar.endDate.toISOString()}`,
  );
  check(
    'renovar conserva el inicio original',
    despuesRenovar.startDate.getTime() === antesRenovar.startDate.getTime(),
  );

  console.log('\n=== 6. Compras concurrentes ===\n');
  const antesConcurrente = Date.now();
  const compras = await Promise.all([
    monetizationService.purchaseVIP(ID_CONCURRENTE, 'basic'),
    monetizationService.purchaseVIP(ID_CONCURRENTE, 'basic'),
  ]);
  check(
    'las dos compras simultáneas se completan',
    compras.every((r) => r === true),
    `resultados=${compras.join(',')}`,
  );
  check(
    'se cobran los dos pagos (70 USDT)',
    (await saldo(ID_CONCURRENTE)) === 30_000,
    `saldo=${await saldo(ID_CONCURRENTE)}`,
  );
  const vipConcurrente = await VIP.findOne({ telegramId: ID_CONCURRENTE });
  const diasConcurrente =
    (vipConcurrente.endDate.getTime() - antesConcurrente) / 86_400_000;
  check(
    'las dos compras suman 60 días al final',
    diasConcurrente > 59.9 && diasConcurrente < 60.1,
    `días=${diasConcurrente.toFixed(3)}`,
  );
  check(
    'queda una sola membresía, no dos',
    (await VIP.countDocuments({ telegramId: ID_CONCURRENTE })) === 1,
  );

  console.log('\n=== 7. Renovar una membresía vencida liquida la semana ===\n');
  await VIP.create({
    telegramId: ID_RENOVAR_VENCIDO,
    level: 'basic',
    startDate: new Date(ahora.getTime() - 31 * 86_400_000),
    endDate: new Date(ahora.getTime() - 86_400_000),
    rakebackPercent: 10,
    rakeDiscount: 0,
  });
  await RakeEvent.create({
    telegramId: ID_RENOVAR_VENCIDO,
    tableId: 'cash-renovar-test',
    handNumber: 1,
    amount: 1_000,
    at: new Date(inicioPrevia.getTime() + 10_000_000),
  });

  const renovado = await monetizationService.purchaseVIP(
    ID_RENOVAR_VENCIDO,
    'basic',
  );
  check('la recompra se completa', renovado === true);
  const pagoVencido = await RakebackPayout.findOne({
    telegramId: ID_RENOVAR_VENCIDO,
  });
  check(
    'la semana vieja se paga antes de reiniciar el periodo',
    pagoVencido?.status === 'paid' && pagoVencido?.amountUnits === 100,
    `status=${pagoVencido?.status} amount=${pagoVencido?.amountUnits}`,
  );
  check(
    'el saldo suma el rakeback y descuenta los 35 USDT',
    (await saldo(ID_RENOVAR_VENCIDO)) === 65_100,
    `saldo=${await saldo(ID_RENOVAR_VENCIDO)}`,
  );
  const vipRenovado = await VIP.findOne({
    telegramId: ID_RENOVAR_VENCIDO,
  });
  check(
    'el nuevo periodo empieza ahora, no conserva el inicio viejo',
    vipRenovado.startDate.getTime() > ahora.getTime() - 60_000,
    `inicio=${vipRenovado.startDate.toISOString()}`,
  );

  console.log('\n=== 8. Sin membresía ===\n');
  const sinVip = await rakebackService.getStatus(ID_SIN_VIP, ahora);
  check('no está activa', sinVip.active === false);
  check('no hay rakeback cobrable', sinVip.claimableUnits === 0);

  console.log(`\n${'='.repeat(56)}`);
  console.log(`Resultado: ${ok} correctos, ${fail} fallidos`);
  if (fail > 0) {
    console.log('Un fallo aquí es dinero que se paga mal o no se paga.');
  }
  console.log('='.repeat(56));

  await db.collection('users').deleteMany({});
  await db.collection('vips').deleteMany({});
  await db.collection('rakebackpayouts').deleteMany({});
  await db.collection('arenapayouts').deleteMany({});
  await db.collection('rakeevents').deleteMany({});
  await db.collection('transactions').deleteMany({});
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('ERROR DEL TEST:', error);
  process.exit(1);
});
