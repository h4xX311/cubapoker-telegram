/**
 * Recompra cash y banco de tiempo.
 *
 * Es una prueba de integración porque las dos operaciones tocan el monedero y
 * el documento de la mesa a la vez. No levanta timers: manipula `lastActionAt`
 * y llama directamente al servicio.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_rebuy_test \
 *     node scripts/test-rebuy-timebank.js
 *
 * Si no hay `MONGODB_URI`, intenta `mongodb-memory-server`. En este equipo el
 * binario no siempre está disponible; por eso la suite estándar no lo incluye.
 */

require('dotenv').config();

process.env.DEV_AUTH_BYPASS = 'false';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const mongoose = require('mongoose');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d !== undefined) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

let mongod = null;

const conectar = async () => {
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create({
      binary: { version: process.env.MONGOMS_VERSION || '7.0.14' },
    });
    uri = mongod.getUri('cubapoker_rebuy_test');
    console.log(`MongoDB efímero: ${uri}`);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
};

const desconectar = async () => {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  } catch { /* nada */ }
  if (mongod) {
    try { await mongod.stop(); } catch { /* nada */ }
  }
};

const idMesa = () => `rebuy-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const crearUsuario = async (telegramId, saldo) => {
  const { User } = require('../dist/models/User');
  return User.create({
    telegramId,
    username: `jugador${telegramId}`,
    firstName: `Jugador ${telegramId}`,
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
};

const crearMesa = async (buyIn = 1000) => {
  const { Table } = require('../dist/models/Table');
  return Table.create({
    tableId: idMesa(),
    kind: 'cash',
    tierId: 't1',
    status: 'waiting',
    buyInUnits: buyIn,
    smallBlind: 5,
    bigBlind: 10,
    maxSeats: 7,
    seats: [],
    hand: {
      handNumber: 0,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      actingSeat: -1,
      dealerSeat: 0,
    },
    stats: { handsPlayed: 0, rakeCollected: 0, prizePaid: 0 },
    handHistory: [],
  });
};

async function main() {
  console.log('\n\x1b[1mCubaPoker · Recompra cash y banco de tiempo\x1b[0m');

  await conectar();
  await mongoose.connection.dropDatabase();

  const { Table } = require('../dist/models/Table');
  const { User } = require('../dist/models/User');
  const { seatingService } = require('../dist/game/seating.service');
  const { BOT_CONFIG, TURN_TIMER } = require('../dist/config/product');

  // Sin timers de bots: las pruebas conducen el estado a mano.
  const min = BOT_CONFIG.minThinkMs;
  const max = BOT_CONFIG.maxThinkMs;
  BOT_CONFIG.minThinkMs = 3_600_000;
  BOT_CONFIG.maxThinkMs = 3_600_000;

  try {
    section('1. Recompra sobre un asiento con cero fichas');
    {
      const telegramId = 900100001;
      await crearUsuario(telegramId, 10_000);
      const mesa = await crearMesa(1000);
      await seatingService.sitDown({ telegramId, tableId: mesa.tableId });

      const antes = await User.findOne({ telegramId });
      const saldoAntes = antes.balance.real;
      let actual = await Table.findOne({ tableId: mesa.tableId });
      const asiento = actual.seats.find((s) => s.playerId === String(telegramId));
      asiento.chips = 0;
      asiento.status = 'active';
      await actual.save();

      const resultado = await seatingService.rebuy(telegramId, mesa.tableId);
      actual = await Table.findOne({ tableId: mesa.tableId });
      const despues = await User.findOne({ telegramId });
      const recargado = actual.seats.find((s) => s.playerId === String(telegramId));

      if (recargado && recargado.chips === 1000 && resultado.rebought) {
        ok('la recompra devuelve exactamente 1000 unidades al asiento');
      } else {
        bad('el asiento no quedó con el buy-in', JSON.stringify(recargado));
      }
      if (saldoAntes - despues.balance.real === 1000) {
        ok('el monedero baja exactamente el buy-in, sin cargos ocultos');
      } else {
        bad(`el monedero bajó ${saldoAntes - despues.balance.real} en vez de 1000`);
      }
      if (actual.hand.phase === 'idle') {
        ok('la recompra no arranca una mano por su cuenta');
      } else {
        bad(`la recompra dejó la mesa en ${actual.hand.phase}`);
      }

      // Con fichas vivas no se puede hacer top-up.
      try {
        await seatingService.rebuy(telegramId, mesa.tableId);
        bad('segunda recompra con fichas fue aceptada');
      } catch (e) {
        ok('rechaza una segunda recompra con fichas vivas');
      }
    }

    section('2. Recompra cuando el asiento ya fue retirado');
    {
      const telegramId = 900100002;
      await crearUsuario(telegramId, 10_000);
      const mesa = await crearMesa(1000);
      await seatingService.sitDown({ telegramId, tableId: mesa.tableId });

      let actual = await Table.findOne({ tableId: mesa.tableId });
      actual.seats = actual.seats.filter(
        (s) => s.playerId !== String(telegramId),
      );
      await actual.save();
      await User.updateOne({ telegramId }, { $set: { activeTableId: null } });

      const antes = await User.findOne({ telegramId });
      const resultado = await seatingService.rebuy(telegramId, mesa.tableId);
      actual = await Table.findOne({ tableId: mesa.tableId });
      const despues = await User.findOne({ telegramId });
      const nuevo = actual.seats.find((s) => s.playerId === String(telegramId));

      if (nuevo && nuevo.chips === 1000 && resultado.rebought) {
        ok('vuelve a sentar al jugador en la misma mesa');
      } else {
        bad('la recompra no volvió a sentar al jugador', JSON.stringify(actual.seats));
      }
      if (antes.balance.real - despues.balance.real === 1000) {
        ok('la recompra sin asiento cobra una sola entrada');
      } else {
        bad(`cobró ${antes.balance.real - despues.balance.real} en vez de 1000`);
      }
      if (despues.activeTableId === mesa.tableId) {
        ok('el monedero queda vinculado a la mesa recargada');
      } else {
        bad(`activeTableId quedó en ${despues.activeTableId}`);
      }
    }

    section('3. Banco de tiempo: alarga el turno una sola vez');
    {
      const telegramId = 900100003;
      await crearUsuario(telegramId, 10_000);
      const mesa = await crearMesa(1000);
      await seatingService.sitDown({ telegramId, tableId: mesa.tableId });

      let actual = await Table.findOne({ tableId: mesa.tableId });
      const asiento = actual.seats.find((s) => s.playerId === String(telegramId));
      asiento.timeBankMs = TURN_TIMER.timeBankMs;
      actual.hand.phase = 'preflop';
      actual.hand.actingSeat = asiento.index;
      actual.hand.lastActionAt = new Date(Date.now() - 10_000);
      await actual.save();

      const ahora = Date.now();
      const r = await seatingService.useTimeBank(telegramId, mesa.tableId);
      actual = await Table.findOne({ tableId: mesa.tableId });
      const vencimiento = new Date(r.turnEndsAt).getTime();
      const restante = vencimiento - ahora;

      if (r.timeBankMs === 0) {
        ok('el banco queda a cero después de usarlo');
      } else {
        bad(`quedaron ${r.timeBankMs} ms de banco`);
      }
      if (restante >= 45_000 && restante <= 60_000) {
        ok(`el turno se alargó a ~${Math.round(restante / 1000)} s (20 s restantes + 30 s de banco)`);
      } else {
        bad(`el vencimiento quedó a ${Math.round(restante / 1000)} s, fuera del rango esperado`);
      }
      if (new Date(actual.hand.lastActionAt).getTime() > ahora) {
        ok('lastActionAt se movió al futuro para que el tick no corte antes');
      } else {
        bad('lastActionAt no se movió');
      }

      try {
        await seatingService.useTimeBank(telegramId, mesa.tableId);
        bad('se pudo usar el banco dos veces en la misma mano');
      } catch (e) {
        ok('rechaza usar el banco dos veces en la misma mano');
      }

      // No es tu turno: no se puede pedir tiempo.
      actual = await Table.findOne({ tableId: mesa.tableId });
      actual.hand.actingSeat = (actual.seats.find((s) => s.playerId === String(telegramId)).index + 1) % 7;
      await actual.save();
      try {
        await seatingService.useTimeBank(telegramId, mesa.tableId);
        bad('se pudo pedir tiempo fuera de turno');
      } catch (e) {
        ok('rechaza el banco de tiempo fuera de turno');
      }
    }
  } finally {
    BOT_CONFIG.minThinkMs = min;
    BOT_CONFIG.maxThinkMs = max;
    await desconectar();
  }

  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await desconectar();
  process.exit(1);
});
