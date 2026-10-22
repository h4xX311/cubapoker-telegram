/**
 * CUANDO UN CAMPO SE CANCELA, EL DINERO VUELVE. Y VUELVE UNA SOLA VEZ.
 *
 * ------------------------------------------------------------------
 * EL BUG QUE ESTE TEST ATRAPA
 *
 * `register()` cobraba el buy-in y subia un contador:
 *
 *     await this.chargeBuyIn(telegramId, tier.buyInUnits);
 *     await Field.updateOne({ _id }, { $inc: { waiting: 1, buyInsCollected: tier.buyInUnits } });
 *
 * No guardaba QUIEN pago. Solo un numero. Asi que cuando el campo se cancelaba no habia a
 * quien devolverle nada: la lista de registrados salia vacia.
 *
 * Medido antes de escribir la devolucion: tres jugadores, 3.000 unidades cobradas, campo
 * cancelado, **0 devueltas**.
 *
 * ------------------------------------------------------------------
 * LA REGLA, QUE ESTA DECIDIDA (DECISIONES.md)
 *
 *   A  'todos'      Campo de PRACTICA: recupera todo el mundo, sentados y eliminados.
 *   B  'soloVivos'  Campo con PREMIO REAL: los sentados recuperan; los eliminados no,
 *                   porque sus fichas ya fueron al bote.
 *
 * Por defecto, un campo con buy-in usa B. Es la que no fabrica dinero.
 *
 * ------------------------------------------------------------------
 * LAS TRES COSAS QUE SE COMPRUEBAN
 *
 * 1. La regla A devuelve a los tres.
 * 2. La regla B devuelve a los vivos y NO al eliminado.
 * 3. Cancelar dos veces no paga dos veces. Esto no es un detalle: en un panel que se puede
 *    pulsar dos veces, o con un reintento tras un corte, pagar doble es el fallo mas caro
 *    que puede tener una devolucion.
 *
 * Ejecutar (Mongo local esta en WSL):
 *     cd "$HOME/cp" && npm run build
 *     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_cancelar \
 *       node scripts/test-cancelar-campo.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { fieldManager } = require('../dist/game/field.manager');
const { Field } = require('../dist/models/Field');
const { User } = require('../dist/models/User');
const { getTier } = require('../dist/config/product');

let ok = 0;
let mal = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    ok++;
    console.log(`\x1b[32m  ok \x1b[0m ${nombre}`);
  } else {
    mal++;
    console.log(`\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' — ' + detalle : ''}`);
  }
}

const NIVEL = 't1';
const buyIn = getTier(NIVEL).buyInUnits;

const saldoDe = async (id) => (await User.findOne({ telegramId: id }))?.balance?.real ?? 0;

const crearJugador = (id, saldo) =>
  User.create({
    telegramId: id,
    firstName: 'J' + String(id).slice(-3),
    balance: { real: saldo, play: 0, realFromPrizes: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
    activeTableId: null,
  });

/** Prepara N jugadores con saldo y registra a todos por la via real. */
async function registrarGrupo(db, ids, saldoInicial, nivel = NIVEL) {
  for (const id of ids) {
    await db.collection('users').deleteMany({ telegramId: id });
    await crearJugador(id, saldoInicial);
  }

  let campoId = null;
  for (const id of ids) {
    const r = await fieldManager.register(id, nivel);
    campoId = r.fieldId;
  }
  return campoId;
}

async function limpiar(db, ids) {
  for (const id of ids) await db.collection('users').deleteMany({ telegramId: id });
  await db.collection('tables').deleteMany({});
  await db.collection('fields').deleteMany({});
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  await limpiar(db, []);
  await db.collection('fields').deleteMany({});

  const SALDO = buyIn * 5;

  // ==================================================================
  // 1. REGLA A: campo de practica, recupera TODO el mundo
  // ==================================================================
  console.log('=== 1. Regla A: cancelar devolviendo a todos ===\n');

  const A = [710010001, 710010002, 710010003];
  const campoA = await registrarGrupo(db, A, SALDO);

  const antesA = {};
  for (const id of A) antesA[id] = await saldoDe(id);
  console.log(`  saldo tras pagar el buy-in: ${A.map((i) => antesA[i]).join(', ')}`);

  const fA = await Field.findOne({ fieldId: campoA });
  comprobar(
    `el campo anota a los ${A.length} que pagaron`,
    (fA.registrations ?? []).length === A.length,
    `hay ${(fA.registrations ?? []).length} entradas`,
  );
  comprobar(
    `cada entrada guarda su telegramId`,
    A.every((id) => (fA.registrations ?? []).some((r) => r.telegramId === id)),
    `ids: ${(fA.registrations ?? []).map((r) => r.telegramId).join(', ')}`,
  );

  const resA = await fieldManager.cancelarCampo(campoA, { politica: 'todos', motivo: 'test' });
  console.log(`  cancelado: devuelto=${resA.devuelto} a ${resA.jugadores} jugadores`);

  const fA2 = await Field.findOne({ fieldId: campoA });
  comprobar('el campo queda CANCELADO', fA2.status === 'cancelled', `estado=${fA2.status}`);
  comprobar(
    `devuelve exactamente ${buyIn * A.length} unidades`,
    resA.devuelto === buyIn * A.length,
    `devuelto ${resA.devuelto}`,
  );
  comprobar(
    'no retiene nada',
    resA.retenido === 0,
    `retenido ${resA.retenido}`,
  );

  for (const id of A) {
    const ahora = await saldoDe(id);
    comprobar(
      `a ${id} le vuelve su buy-in`,
      ahora === SALDO,
      `tenia ${SALDO}, pago ${buyIn}, ahora ${ahora}`,
    );
  }

  // ==================================================================
  // 2. IDEMPOTENCIA: cancelar otra vez NO paga otra vez
  // ==================================================================
  console.log('\n=== 2. Cancelar dos veces no paga dos veces ===\n');

  const resA2 = await fieldManager.cancelarCampo(campoA, { politica: 'todos' });
  comprobar('la segunda cancelacion no devuelve nada', resA2.devuelto === 0, `devuelto ${resA2.devuelto}`);
  comprobar('y dice que ya estaba', resA2.yaEstaba === true, `yaEstaba=${resA2.yaEstaba}`);

  for (const id of A) {
    const ahora = await saldoDe(id);
    comprobar(
      `a ${id} NO se le paga dos veces`,
      ahora === SALDO,
      `esperado ${SALDO}, tiene ${ahora} (doblo)`,
    );
  }

  // ==================================================================
  // 3. REGLA B: campo con premio real, el eliminado NO recupera
  // ==================================================================
  console.log('\n=== 3. Regla B: el eliminado no recupera ===\n');

  const B = [710020001, 710020002, 710020003];
  const campoB = await registrarGrupo(db, B, SALDO);

  // Se marca a uno como eliminado, que es lo que hace `collectEliminations` cuando sus
  // fichas ya fueron al bote.
  await Field.updateOne(
    { fieldId: campoB, 'registrations.telegramId': B[0] },
    { $set: { 'registrations.$.status': 'eliminated' } },
  );

  const antesB = {};
  for (const id of B) antesB[id] = await saldoDe(id);

  // Sin `politica`, un campo `cash` usa 'soloVivos'.
  const resB = await fieldManager.cancelarCampo(campoB);
  console.log(
    `  cancelado: devuelto=${resB.devuelto} a ${resB.jugadores} jugadores, ` +
    `retenido=${resB.retenido}`,
  );

  comprobar(
    `devuelve solo a los ${B.length - 1} vivos`,
    resB.devuelto === buyIn * (B.length - 1),
    `devuelto ${resB.devuelto}, esperado ${buyIn * (B.length - 1)}`,
  );
  comprobar(
    `retiene el buy-in del eliminado (${buyIn})`,
    resB.retenido === buyIn,
    `retenido ${resB.retenido}`,
  );

  const eliminado = await saldoDe(B[0]);
  comprobar(
    `el eliminado ${B[0]} NO recupera nada`,
    eliminado === antesB[B[0]],
    `tenia ${antesB[B[0]]} y ahora tiene ${eliminado}`,
  );

  for (const id of B.slice(1)) {
    const ahora = await saldoDe(id);
    comprobar(
      `el vivo ${id} recupera su buy-in`,
      ahora === SALDO,
      `tenia ${SALDO}, pago ${buyIn}, ahora ${ahora}`,
    );
  }

  // ==================================================================
  // 4. LA CUENTA GLOBAL
  // ==================================================================
  console.log('\n=== 4. La cuenta global ===\n');

  const fB2 = await Field.findOne({ fieldId: campoB });
  comprobar(
    'el campo cancelado dice retener lo que no devolvio',
    fB2.buyInsCollected === buyIn,
    `buyInsCollected=${fB2.buyInsCollected}`,
  );
  comprobar(
    'el campo cancelado queda a cero jugadores',
    fB2.playersRemaining === 0 && fB2.waiting === 0 && fB2.seated === 0,
    `vivos=${fB2.playersRemaining} espera=${fB2.waiting} sentados=${fB2.seated}`,
  );

  // ==================================================================
  console.log(`\n${'='.repeat(56)}`);
  console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
  if (mal > 0) {
    console.log('');
    console.log('Una devolucion que no cuadra es dinero de jugadores que no vuelve.');
    console.log('Una que se paga dos veces es dinero de la plataforma que se va.');
  }
  console.log('='.repeat(56));

  await limpiar(db, [...A, ...B]);

  await mongoose.disconnect();
  process.exit(mal > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERROR DEL TEST:', e);
  process.exit(1);
});
