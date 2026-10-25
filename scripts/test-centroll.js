/**
 * EL CENTROLL COBRA UNA VEZ, ARRANCA CON BOTS Y DEVUELVE SI NO ARRANCA.
 *
 * ------------------------------------------------------------------
 * LO QUE CAMBIO
 *
 * El centroll ya no espera a 100 humanos. Cada mesa que tenga al menos un
 * humano se completa con bots hasta `CENTROLL.minPlayersPerTable` (2) y
 * arranca. Los bots no pagan buy-in; si ganan una posicion, su premio se queda
 * en la casa.
 *
 * Esto cambia el modelo de concurrencia que comprobaba el test anterior:
 * antes, 10 personas que pulsaban JUGAR a la vez compartian un solo campo de
 * 100. Ahora cada una tiene su propio centroll instantaneo contra un bot. Lo
 * que sigue siendo obligatorio es que el dinero cuadre: 10 cobros, 10 entradas,
 * 10 botes de 10 unidades.
 *
 * Se comprueba:
 *
 *   1. Un humano cobra una vez y arranca contra un bot con stack completo.
 *   2. Pulsar JUGAR dos veces NO cobra dos veces.
 *   3. Si un campo se queda en `filling`, se devuelve el buy-in. Y solo una vez.
 *   4. Diez a la vez: cada uno tiene su campo, pero el dinero total cuadra.
 *
 * Ejecutar (Mongo local esta en WSL):
 *     npm run build
 *     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_centroll \
 *       node scripts/test-centroll.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { centrollService } = require('../dist/game/centroll.service');
const { Field } = require('../dist/models/Field');
const { Table } = require('../dist/models/Table');
const { User } = require('../dist/models/User');
const { CENTROLL, FREEROLL_PAYOUT } = require('../dist/config/product');
const { usdtToUnits, formatUnits } = require('../dist/config/units');

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

const buyIn = usdtToUnits(CENTROLL.buyInUsdt);
const SALDO = buyIn * 5;

const saldoDe = async (id) => (await User.findOne({ telegramId: id }))?.balance?.real ?? 0;

const crearJugador = (id, saldo) =>
  User.create({
    telegramId: id,
    firstName: 'C' + String(id).slice(-3),
    balance: { real: saldo, play: 0, realFromPrizes: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
    activeTableId: null,
  });

const mesasDe = (fieldId) => Table.find({ 'field.fieldId': fieldId });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const IDS = [720010001, 720010002, 720010003];

  // Base limpia: este test no debe ver campos de una pasada anterior.
  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});
  for (const id of IDS) await db.collection('users').deleteMany({ telegramId: id });

  for (const id of IDS) await crearJugador(id, SALDO);

  console.log(`Buy-in del centroll: ${formatUnits(buyIn)} USDT (${buyIn} unidades)\n`);

  // ==================================================================
  // 1. UN HUMANO ARRANCA CONTRA UN BOT
  // ==================================================================
  console.log('=== 1. Un humano arranca contra un bot ===\n');

  const r1 = await centrollService.register(IDS[0], 'C001');
  console.log(`  ${IDS[0]} entro en ${r1.fieldId} (${r1.queued ? 'en cola' : 'sentado'})`);

  const campo = await Field.findOne({ fieldId: r1.fieldId });
  console.log(
    `  campo: estado=${campo.status} espera=${campo.waiting} sentados=${campo.seated} ` +
    `restantes=${campo.playersRemaining} cobrado=${campo.buyInsCollected} ` +
    `registrados=${(campo.registrations ?? []).length}`,
  );

  comprobar('el centroll se abrio y arranco', campo.status === 'running', `estado=${campo.status}`);
  comprobar(
    'el campo anota a 1 humano',
    (campo.registrations ?? []).length === 1,
    `hay ${(campo.registrations ?? []).length}`,
  );
  comprobar(
    `el bote es exactamente ${buyIn} (solo paga el humano)`,
    campo.buyInsCollected === buyIn,
    `hay ${campo.buyInsCollected}`,
  );
  comprobar(
    'playersRemaining cuenta al humano y al bot',
    campo.playersRemaining === 2,
    `hay ${campo.playersRemaining}`,
  );

  const mesas = await mesasDe(r1.fieldId);
  comprobar('se creo una mesa', mesas.length === 1, `hay ${mesas.length}`);
  if (mesas.length === 1) {
    const humanos = mesas[0].seats.filter((s) => s.kind === 'human' && s.status !== 'out');
    const bots = mesas[0].seats.filter((s) => s.kind === 'bot' && s.status !== 'out');
    comprobar('hay 1 humano sentado', humanos.length === 1, `hay ${humanos.length}`);
    comprobar('hay 1 bot de relleno', bots.length === 1, `hay ${bots.length}`);
    comprobar(
      'el bot tiene el stack completo del torneo (1.000 fichas)',
      bots[0]?.chips === CENTROLL.startingChips,
      `chips=${bots[0]?.chips}`,
    );
    comprobar(
      'el humano tambien tiene 1.000 fichas',
      humanos[0]?.chips === CENTROLL.startingChips,
      `chips=${humanos[0]?.chips}`,
    );
  }

  comprobar(
    `a ${IDS[0]} se le cobro UNA vez`,
    (await saldoDe(IDS[0])) === SALDO - buyIn,
    `tenia ${SALDO}, ahora ${await saldoDe(IDS[0])}`,
  );

  // Un segundo humano que llega despues no entra en el campo ya arrancado:
  // abre su propio centroll. Es la consecuencia de arrancar al minimo.
  const r2 = await centrollService.register(IDS[1], 'C002');
  comprobar(
    'otro humano abre un centroll distinto, no uno ya arrancado',
    r2.fieldId !== r1.fieldId,
    `mismo campo ${r2.fieldId}`,
  );

  // ==================================================================
  // 2. PULSAR DOS VECES NO COBRA DOS VECES
  // ==================================================================
  console.log('\n=== 2. Entrar dos veces no cobra dos veces ===\n');

  let bloqueado = false;
  try {
    await centrollService.register(IDS[0]);
  } catch (e) {
    bloqueado = true;
    console.log(`  rechazado: ${e.message}`);
  }

  comprobar('el segundo intento se rechaza', bloqueado, 'entro otra vez');
  comprobar(
    `a ${IDS[0]} NO se le cobro dos veces`,
    (await saldoDe(IDS[0])) === SALDO - buyIn,
    `tiene ${await saldoDe(IDS[0])}, esperado ${SALDO - buyIn}`,
  );

  const campo2 = await Field.findOne({ fieldId: r1.fieldId });
  comprobar(
    'el bote no subio con el segundo intento',
    campo2.buyInsCollected === buyIn,
    `hay ${campo2.buyInsCollected}`,
  );

  // ==================================================================
  // 3. DEVOLVER SI NO ARRANCA
  // ==================================================================
  console.log('\n=== 3. Si no arranca, se devuelve ===\n');

  // Se monta un campo en `filling` a mano: en el flujo normal el centroll
  // arranca al instante, y la devolucion solo aplica a un campo que se quedo
  // atascado (por ejemplo, tras un reinicio antes de completar la mesa).
  await User.updateOne({ telegramId: IDS[2] }, { $inc: { 'balance.real': -buyIn } });
  const campoAtascado = await Field.create({
    fieldId: `centroll-refund-${Date.now().toString(36)}`,
    kind: 'centroll',
    tierId: `centroll-refund-${Date.now().toString(36)}`,
    status: 'filling',
    buyInUnits: buyIn,
    buyInsCollected: buyIn,
    targetField: CENTROLL.targetField,
    waiting: 0,
    seated: 1,
    playersRemaining: 1,
    paidPositionsLeft: FREEROLL_PAYOUT.length,
    registrations: [
      {
        telegramId: IDS[2],
        username: 'C003',
        buyIn,
        status: 'seated',
        at: new Date(),
      },
    ],
    tables: [],
  });

  const antes = await saldoDe(IDS[2]);
  const devuelto = await centrollService.refundIfNotStarted(IDS[2]);

  console.log(`  devuelto a ${IDS[2]}: ${formatUnits(devuelto)} USDT`);
  comprobar('devuelve el buy-in', devuelto === buyIn, `devolvio ${devuelto}`);
  comprobar(
    `el saldo de ${IDS[2]} vuelve a ${SALDO}`,
    (await saldoDe(IDS[2])) === SALDO,
    `antes ${antes}, ahora ${await saldoDe(IDS[2])}`,
  );

  const campo3 = await Field.findOne({ fieldId: campoAtascado.fieldId });
  comprobar(
    'el bote baja lo devuelto',
    campo3.buyInsCollected === 0,
    `hay ${campo3.buyInsCollected}`,
  );
  comprobar(
    'y la entrada queda marcada como devuelta',
    (campo3.registrations ?? []).find((r) => r.telegramId === IDS[2])?.status === 'refunded',
    `estado=${(campo3.registrations ?? []).find((r) => r.telegramId === IDS[2])?.status}`,
  );

  // ==================================================================
  // 4. Y NO SE DEVUELVE DOS VECES
  // ==================================================================
  console.log('\n=== 4. Devolver dos veces no paga dos veces ===\n');

  const otraVez = await centrollService.refundIfNotStarted(IDS[2]);
  comprobar('la segunda devolucion devuelve 0', otraVez === 0, `devolvio ${otraVez}`);
  comprobar(
    `el saldo de ${IDS[2]} sigue en ${SALDO}`,
    (await saldoDe(IDS[2])) === SALDO,
    `tiene ${await saldoDe(IDS[2])}`,
  );

  // ==================================================================
  // 5. CONCURRENCIA: 10 A LA VEZ, CADA UNO CON SU BOT
  // ==================================================================
  console.log('\n=== 5. Diez entrando a la vez ===\n');

  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});

  const C = Array.from({ length: 10 }, (_, i) => 720020001 + i);
  for (const id of C) {
    await db.collection('users').deleteMany({ telegramId: id });
    await crearJugador(id, SALDO);
  }

  const res = await Promise.allSettled(C.map((id) => centrollService.register(id)));
  const buenos = res.filter((r) => r.status === 'fulfilled');
  const fallos = res.filter((r) => r.status === 'rejected');

  console.log(`  ${buenos.length} entraron, ${fallos.length} fallaron`);
  for (const f of fallos.slice(0, 2)) console.log(`    ${f.reason?.message}`);

  const campos = await Field.find({
    kind: 'centroll',
    status: { $in: ['filling', 'running', 'final'] },
  });

  comprobar(
    'cada humano que pago tiene su campo (no se pierde ninguno)',
    campos.length === buenos.length,
    `${campos.length} campos para ${buenos.length} cobros`,
  );

  let potTotal = 0;
  let registrosTotal = 0;
  let mesasCorrectas = 0;
  for (const c of campos) {
    potTotal += c.buyInsCollected;
    registrosTotal += (c.registrations ?? []).length;
    const mesasCampo = await mesasDe(c.fieldId);
    if (mesasCampo.length === 1) {
      const humanos = mesasCampo[0].seats.filter(
        (s) => s.kind === 'human' && s.status !== 'out',
      );
      const bots = mesasCampo[0].seats.filter(
        (s) => s.kind === 'bot' && s.status !== 'out',
      );
      if (humanos.length === 1 && bots.length === 1) mesasCorrectas++;
    }
  }

  comprobar(
    `el bote total es ${buyIn * buenos.length} (lo cobrado de verdad)`,
    potTotal === buyIn * buenos.length,
    `hay ${potTotal}, faltan ${buyIn * buenos.length - potTotal}`,
  );
  comprobar(
    'las entradas anotadas son las mismas que los cobros',
    registrosTotal === buenos.length,
    `${registrosTotal} entradas para ${buenos.length} cobros`,
  );
  comprobar(
    'cada campo tiene 1 humano y 1 bot sentados',
    mesasCorrectas === campos.length,
    `${mesasCorrectas} de ${campos.length}`,
  );

  let cobradoReal = 0;
  for (const id of C) cobradoReal += SALDO - (await saldoDe(id));
  comprobar(
    'el bote total es exactamente lo que salio de las carteras',
    cobradoReal === potTotal,
    `carteras ${cobradoReal}, campo ${potTotal}`,
  );

  // ==================================================================
  console.log(`\n${'='.repeat(56)}`);
  console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
  if (mal > 0) {
    console.log('');
    console.log('Un centroll cobra saldo REAL: cada fallo de aqui es dinero de alguien.');
  }
  console.log('='.repeat(56));

  for (const id of [...IDS, ...(typeof C !== 'undefined' ? C : [])]) {
    await db.collection('users').deleteMany({ telegramId: id });
  }
  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});

  await mongoose.disconnect();
  process.exit(mal > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERROR DEL TEST:', e);
  process.exit(1);
});
