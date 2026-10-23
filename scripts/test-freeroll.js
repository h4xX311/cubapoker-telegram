/**
 * EL FREEROLL HORARIO, DE PUNTA A PUNTA
 * =====================================
 *
 * ------------------------------------------------------------------
 * QUE SE COMPRUEBA, Y POR QUE CADA COSA
 *
 * 1. El reloj abre un campo para la proxima hora, con premio y registro tardio.
 * 2. Inscribirse es GRATIS: no toca `balance.real` ni `balance.play`.
 * 3. Apuntarse dos veces no duplica la entrada.
 * 4. Diez a la vez dejan diez entradas, no once ni cinco.
 * 5. A su hora arranca solo, aunque haya menos de dos humanos: se rellena con bots.
 * 6. El registro tardio sienta a un jugador con el torneo ya empezado.
 * 7. EL PREMIO VA A `balance.play`, NO A `balance.real`.
 *
 * El punto 7 es el que decide si el producto regala dinero o no. Se comprueba con saldo
 * antes y despues, no leyendo el codigo.
 *
 * Ejecutar:
 *     cd "$HOME/cp" && npm run build
 *     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_freeroll \
 *       node scripts/test-freeroll.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Field } = require('../dist/models/Field');
const { Table } = require('../dist/models/Table');
const { User } = require('../dist/models/User');
const { freerollManager } = require('../dist/game/freeroll.service');
const { fieldManager } = require('../dist/game/field.manager');
const { FREEROLL_PAYOUT } = require('../dist/config/product');
const { usdtToUnits, formatUnits } = require('../dist/config/units');
const {
  MINUTOS_REGISTRO_TARDIO,
  premioHorarioUnits,
} = require('../dist/config/freeroll');

let ok = 0;
let mal = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    ok++;
    console.log(`\x1b[32m  ok \x1b[0m ${nombre}`);
  } else {
    mal++;
    console.log(
      `\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' — ' + detalle : ''}`,
    );
  }
}

const SALDO = usdtToUnits(20);

const saldoDe = async (id) => {
  const u = await User.findOne({ telegramId: id });
  return { real: u?.balance?.real ?? 0, play: u?.balance?.play ?? 0 };
};

const crearJugador = (id) =>
  User.create({
    telegramId: id,
    firstName: 'F' + String(id).slice(-4),
    balance: { real: SALDO, play: 0, realFromPrizes: 0 },
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

const limpiar = async () => {
  const db = mongoose.connection.db;
  await db.collection('fields').deleteMany({ kind: 'freeroll' });
  await db.collection('tables').deleteMany({});
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const A = 730010001;
  const B = 730010002;
  const C = 730010003;
  const D = 730010004;
  const CONC = Array.from({ length: 10 }, (_, i) => 730020001 + i);
  const TODOS = [A, B, C, D, ...CONC];

  await limpiar();
  for (const id of TODOS) {
    await db.collection('users').deleteMany({ telegramId: id });
    await crearJugador(id);
  }

  // ==================================================================
  console.log('=== 1. El reloj abre el proximo freeroll ===\n');

  const abierto = await freerollManager.asegurarAbierto();

  comprobar('se abre un campo', !!abierto, 'no se abrio ninguno');
  comprobar(
    'el campo es de tipo freeroll',
    abierto.kind === 'freeroll',
    `kind=${abierto.kind}`,
  );
  comprobar(
    'el buy-in es 0 (es gratis)',
    abierto.buyInUnits === 0,
    `buyInUnits=${abierto.buyInUnits}`,
  );
  comprobar(
    `el premio es ${formatUnits(premioHorarioUnits())} USDT (lo pone la casa)`,
    abierto.prizePoolUnits === premioHorarioUnits(),
    `prizePoolUnits=${abierto.prizePoolUnits}`,
  );
  comprobar(
    'hay hora de inicio',
    !!abierto.scheduledStartAt &&
      new Date(abierto.scheduledStartAt).getTime() > Date.now(),
    `inicio=${abierto.scheduledStartAt}`,
  );

  const minutosTardio =
    (new Date(abierto.lateRegUntil).getTime() -
      new Date(abierto.scheduledStartAt).getTime()) /
    60000;
  comprobar(
    `el registro tardio dura ${MINUTOS_REGISTRO_TARDIO} minutos`,
    minutosTardio === MINUTOS_REGISTRO_TARDIO,
    `son ${minutosTardio} minutos`,
  );

  // ==================================================================
  console.log('\n=== 2. Inscribirse es gratis ===\n');

  const antes = await saldoDe(A);
  await freerollManager.registrar(A, 'Ana', abierto.fieldId);
  const despues = await saldoDe(A);

  comprobar(
    'no se descuenta nada de balance.real',
    despues.real === antes.real,
    `${antes.real} -> ${despues.real}`,
  );
  comprobar(
    'no se descuenta nada de balance.play',
    despues.play === antes.play,
    `${antes.play} -> ${despues.play}`,
  );

  const f1 = await Field.findOne({ fieldId: abierto.fieldId });
  comprobar(
    'el campo anota la inscripcion',
    (f1.registrations ?? []).length === 1,
    `${(f1.registrations ?? []).length} entradas`,
  );
  comprobar(
    'el bote de entradas sigue en 0',
    f1.buyInsCollected === 0,
    `buyInsCollected=${f1.buyInsCollected}`,
  );

  // ==================================================================
  console.log('\n=== 3. Apuntarse dos veces no duplica ===\n');

  let duplicado = false;
  try {
    await freerollManager.registrar(A, 'Ana', abierto.fieldId);
  } catch (e) {
    duplicado = true;
    console.log(`  rechazado: ${e.message}`);
  }

  const f2 = await Field.findOne({ fieldId: abierto.fieldId });
  comprobar('el segundo intento se rechaza', duplicado, 'entro otra vez');
  comprobar(
    'sigue habiendo una sola entrada',
    (f2.registrations ?? []).length === 1,
    `${(f2.registrations ?? []).length} entradas`,
  );

  // ==================================================================
  console.log('\n=== 4. Diez a la vez ===\n');

  await limpiar();
  const fConcurrente = await freerollManager.asegurarAbierto();

  const res = await Promise.allSettled(
    CONC.map((id) => freerollManager.registrar(id, 'C' + id, fConcurrente.fieldId)),
  );
  const buenos = res.filter((r) => r.status === 'fulfilled');
  const fallos = res.filter((r) => r.status === 'rejected');

  console.log(`  ${buenos.length} entraron, ${fallos.length} fallaron`);
  for (const f of fallos.slice(0, 2)) {
    console.log(`    ${f.reason?.message}`);
  }

  const f4 = await Field.findOne({ fieldId: fConcurrente.fieldId });
  comprobar(
    'las diez inscripciones quedan anotadas',
    (f4.registrations ?? []).length === 10,
    `${(f4.registrations ?? []).length} entradas`,
  );
  comprobar(
    'no se abre un segundo campo para la misma hora',
    (await Field.countDocuments({
      kind: 'freeroll',
      status: { $in: ['filling', 'running', 'final'] },
    })) === 1,
    'hay mas de un campo vivo',
  );

  // ==================================================================
  console.log('\n=== 5. Arranca a su hora, con bots si hace falta ===\n');

  // Se adelanta el reloj del campo: es la unica forma de probar el arranque sin esperar
  // una hora. El registro tardio se mantiene abierto.
  await Field.updateOne(
    { fieldId: fConcurrente.fieldId },
    {
      $set: {
        scheduledStartAt: new Date(Date.now() - 5_000),
        lateRegUntil: new Date(Date.now() + 12 * 60_000),
      },
    },
  );

  const arranque = await freerollManager.procesar();
  console.log(`  arrancados=${arranque.arrancados} cancelados=${arranque.cancelados}`);

  const f5 = await Field.findOne({ fieldId: fConcurrente.fieldId });
  comprobar(
    'el campo pasa a running',
    f5.status === 'running',
    `status=${f5.status}`,
  );
  comprobar(
    'cuenta a los diez jugadores',
    f5.playersRemaining === 10,
    `playersRemaining=${f5.playersRemaining}`,
  );

  const mesas = await Table.find({ 'field.fieldId': fConcurrente.fieldId });
  comprobar('hay al menos una mesa', mesas.length >= 1, `${mesas.length} mesas`);

  const humanos = mesas.reduce(
    (n, t) => n + t.seats.filter((s) => s.kind === 'human').length,
    0,
  );
  comprobar(
    'los diez humanos estan sentados',
    humanos === 10,
    `${humanos} humanos sentados`,
  );

  const mesasConHumano = mesas.filter((t) =>
    t.seats.some((s) => s.kind === 'human'),
  );
  const mesasConDos = mesasConHumano.filter(
    (t) => t.seats.filter((s) => s.status === 'active' && s.chips > 0).length >= 2,
  );
  comprobar(
    'cada mesa con humanos tiene al menos 2 asientos activos',
    mesasConDos.length === mesasConHumano.length,
    `${mesasConDos.length} de ${mesasConHumano.length}`,
  );

  // ==================================================================
  console.log('\n=== 6. Registro tardio con el torneo empezado ===\n');

  const antesD = await saldoDe(D);
  const tardio = await freerollManager.registrar(D, 'Dora', fConcurrente.fieldId);
  const despuesD = await saldoDe(D);

  comprobar('entra con el torneo en marcha', tardio.late === true, `late=${tardio.late}`);
  comprobar('y queda sentado', tardio.seated === true, 'quedo en cola');
  comprobar(
    'sin pagar nada',
    despuesD.real === antesD.real && despuesD.play === antesD.play,
    'le cobraron la entrada',
  );

  const f6 = await Field.findOne({ fieldId: fConcurrente.fieldId });
  comprobar(
    'el campo lo cuenta como vivo',
    f6.playersRemaining === 11,
    `playersRemaining=${f6.playersRemaining}`,
  );

  // ==================================================================
  console.log('\n=== 5b. Un solo humano: se rellena con bots y arranca ===\n');

  await limpiar();
  const fSolo = await freerollManager.asegurarAbierto();
  await freerollManager.registrar(A, 'Ana', fSolo.fieldId);

  const fSoloAntes = await Field.findOne({ fieldId: fSolo.fieldId });
  comprobar(
    'hay un solo humano apuntado',
    (fSoloAntes.registrations ?? []).length === 1,
    `${(fSoloAntes.registrations ?? []).length} entradas`,
  );

  await Field.updateOne(
    { fieldId: fSolo.fieldId },
    {
      $set: {
        scheduledStartAt: new Date(Date.now() - 5_000),
        lateRegUntil: new Date(Date.now() + 12 * 60_000),
      },
    },
  );

  const arranqueSolo = await freerollManager.procesar();
  const fSoloDespues = await Field.findOne({ fieldId: fSolo.fieldId });

  comprobar(
    'el torneo arranca con un solo humano',
    arranqueSolo.arrancados === 1 && fSoloDespues.status === 'running',
    `arrancados=${arranqueSolo.arrancados}, status=${fSoloDespues.status}`,
  );

  const mesaSolo = await Table.findOne({ 'field.fieldId': fSolo.fieldId });
  const botsSolo = (mesaSolo?.seats ?? []).filter(
    (s) => s.kind === 'bot' && s.chips > 0,
  );
  const activosSolo = (mesaSolo?.seats ?? []).filter(
    (s) => s.status === 'active' && s.chips > 0,
  );

  comprobar(
    'entra al menos un bot de relleno',
    botsSolo.length >= 1,
    `${botsSolo.length} bots`,
  );
  comprobar(
    'el bot entra con las mismas fichas que el humano (no con dos ciegas)',
    botsSolo.every((b) => b.chips === 1000),
    `fichas de los bots: ${botsSolo.map((b) => b.chips).join(', ')}`,
  );
  comprobar(
    'la mesa tiene al menos 2 asientos activos',
    activosSolo.length >= 2,
    `${activosSolo.length} activos`,
  );

  // ==================================================================
  console.log('\n=== 7. EL PREMIO VA A SALDO DE PROMOCION ===\n');

  // Campo aparte para liquidar limpiamente, con tres posiciones ya adjudicadas.
  const premio = usdtToUnits(10);
  const fPremio = await Field.create({
    fieldId: 'freeroll-test-premio',
    kind: 'freeroll',
    tierId: 'freeroll-test-premio',
    status: 'final',
    buyInUnits: 0,
    prizePoolUnits: premio,
    scheduledStartAt: new Date(Date.now() - 60_000),
    lateRegUntil: new Date(Date.now() - 60_000),
    startChips: 1000,
    smallBlind: 5,
    bigBlind: 10,
    targetField: 300,
    waiting: 0,
    seated: 3,
    playersRemaining: 1,
    paidPositionsLeft: 3,
    plannedTables: 1,
    tables: [],
    buyInsCollected: 0,
    results: [
      {
        position: 2,
        telegramId: B,
        username: 'Beto',
        amount: 0,
        tableId: 'freeroll-test-premio-t1',
      },
      {
        position: 3,
        telegramId: C,
        username: 'Caro',
        amount: 0,
        tableId: 'freeroll-test-premio-t1',
      },
    ],
  });

  const mesaPremio = await Table.create({
    tableId: 'freeroll-test-premio-t1',
    kind: 'freeroll',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 0,
    startChips: 1000,
    maxSeats: 7,
    seats: [
      {
        index: 0,
        kind: 'human',
        playerId: String(A),
        displayName: 'Ana',
        chips: 3000,
        bet: 0,
        totalBet: 0,
        status: 'active',
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
        handsPlayed: 0,
        handsWon: 0,
        netChips: 0,
        joinedAt: new Date(),
      },
    ],
    field: {
      fieldId: fPremio.fieldId,
      tableNumber: 1,
      targetField: 300,
      registered: 3,
      seated: 1,
      fieldStatus: 'final',
    },
    hand: {
      handNumber: 0,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      actingSeat: -1,
      dealerSeat: 0,
    },
  });

  const antesPremio = {
    A: await saldoDe(A),
    B: await saldoDe(B),
    C: await saldoDe(C),
  };

  const liquidacion = await fieldManager.settleField(fPremio, mesaPremio.seats[0]);

  console.log(
    `  repartido=${formatUnits(liquidacion.totalPaid)} USDT ` +
    `en ${liquidacion.paid.length} plazas`,
  );

  const despuesPremio = {
    A: await saldoDe(A),
    B: await saldoDe(B),
    C: await saldoDe(C),
  };

  const esperado = FREEROLL_PAYOUT.map((p) => Math.floor((premio * p) / 100));
  console.log(
    `  esperado: ${esperado.map(formatUnits).join(' / ')} USDT (50% / 30% / 20%)`,
  );

  comprobar(
    'el ganador cobra el 50% en balance.play',
    despuesPremio.A.play - antesPremio.A.play === esperado[0],
    `play +${despuesPremio.A.play - antesPremio.A.play}, esperado +${esperado[0]}`,
  );
  comprobar(
    'el 2.º cobra el 30% en balance.play',
    despuesPremio.B.play - antesPremio.B.play === esperado[1],
    `play +${despuesPremio.B.play - antesPremio.B.play}, esperado +${esperado[1]}`,
  );
  comprobar(
    'el 3.º cobra el 20% en balance.play',
    despuesPremio.C.play - antesPremio.C.play === esperado[2],
    `play +${despuesPremio.C.play - antesPremio.C.play}, esperado +${esperado[2]}`,
  );

  comprobar(
    'NADIE cobra en balance.real (no es retirable)',
    despuesPremio.A.real === antesPremio.A.real &&
      despuesPremio.B.real === antesPremio.B.real &&
      despuesPremio.C.real === antesPremio.C.real,
    `real A ${antesPremio.A.real}->${despuesPremio.A.real}, ` +
    `B ${antesPremio.B.real}->${despuesPremio.B.real}, ` +
    `C ${antesPremio.C.real}->${despuesPremio.C.real}`,
  );

  const fCerrado = await Field.findOne({ fieldId: fPremio.fieldId });
  comprobar(
    'un freeroll no cobra rake',
    fCerrado.rakeCollected === 0,
    `rake=${fCerrado.rakeCollected}`,
  );
  comprobar(
    'el campo queda cerrado',
    fCerrado.status === 'finished',
    `status=${fCerrado.status}`,
  );

  // ==================================================================
  console.log(`\n${'='.repeat(56)}`);
  console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
  if (mal > 0) {
    console.log('');
    console.log('Un freeroll reparte premios de la casa: cada fallo es dinero regalado.');
  }
  console.log('='.repeat(56));

  await limpiar();
  for (const id of TODOS) {
    await db.collection('users').deleteMany({ telegramId: id });
  }

  await mongoose.disconnect();
  process.exit(mal > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERROR DEL TEST:', e);
  process.exit(1);
});
