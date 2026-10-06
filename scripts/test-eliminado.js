/**
 * Test de las fichas de un eliminado, que son del bote del campo.
 *
 * ------------------------------------------------------------------
 * EL BUG
 *
 * `collectEliminations` deja A PROPOSITO las fichas del eliminado en su asiento. El
 * comentario del propio codigo lo explica:
 *
 *   "No se ponen a cero aqui: desaparecerian de la contabilidad y el campo devolveria
 *    menos de lo que cobro."
 *
 * La idea era que las recogiera `settleField` al final del campo. Pero entre una cosa y
 * otra el asiento se marca `out` y se suelta del array, y las fichas se van con el:
 *
 *   1. { $set: { 'seats.$[s].status': 'out' } }        con arrayFilters s.status=eliminated
 *   2. table.seats = table.seats.filter(s => s.status !== 'out')
 *
 * Para cuando le toca a `settleField` de barrer el bote, ya no estan en ningun sitio.
 *
 * Medido jugando un campo entero: 2 155 unidades de 14 000, el 15 % del bote. Ocho
 * eliminados, unos 270 cada uno. El campo se liquidaba igual y los premios se pagaban,
 * de modo que nadie se enteraba: el dinero se perdia sin dejar rastro.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTE TEST NO ES EL DE INTEGRACION
 *
 * Porque el de integracion tarda veinte minutos y dice "faltan 2 155 unidades" sin
 * decir donde. Este monta un campo con las cifras exactas y comprueba, punto por punto,
 * que las fichas de un eliminado siguen existiendo DESPUES de que su asiento se suelta.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_eliminado node scripts/test-eliminado.js
 */

process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_eliminado';

// El bot arranca polling de Telegram al importarse, asi que esto va ANTES de cargar
// nada del proyecto.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const mongoose = require('mongoose');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const note = (m) => console.log(`      \x1b[2m${m}\x1b[0m`);

const finish = async () => {
  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch { /* nada que hacer al salir */ }
  process.exit(fail > 0 ? 1 : 0);
};

main().catch(async (e) => {
  console.error('\n\x1b[31mEl test reviento antes de terminar:\x1b[0m');
  console.error(e);
  fail++;
  await finish();
});

const FIELD_ID = 'elim-t1';

// Tres jugadores de buy-in 1 000. Dos se eliminan y uno gana.
const BUY_IN = 1000;
const JUGADORES = 3;
const BUY_INS = BUY_IN * JUGADORES;          // 3 000
const FICHAS_ELIMINADO_A = 270;             // lo que le queda al primer eliminado
const FICHAS_ELIMINADO_B = 185;             // y al segundo
const FICHAS_GANADOR = 1000;
const SIN_FICHA = 0;

const IDS = [730_000_000, 730_000_001, 730_000_002];

// El dinero del campo, donde este. Si esta suma no cuadra con lo que entro, se ha
// perdido dinero por el camino, y esto es lo que dice donde.
const dineroDelCampo = async () => {
  const { Table } = require('../dist/models/Table');
  const { Field } = require('../dist/models/Field');

  const tablas = await Table.find({ 'field.fieldId': FIELD_ID });
  let enMesas = 0;
  for (const t of tablas) {
    for (const s of t.seats) enMesas += Math.max(0, s.chips) + Math.max(0, s.bet);
    enMesas += Math.max(0, t.hand.pot || 0);
  }
  const doc = await Field.findOne({ fieldId: FIELD_ID });
  return { enMesas, deadChips: Math.max(0, doc?.deadChips || 0) };
};

async function main() {
  console.log('\n\x1b[1mCubaPoker · Las fichas de un eliminado son del bote\x1b[0m');
  note(`MONGODB_URI = ${process.env.MONGODB_URI}`);

  section('0. Conexion');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  note(`MongoDB ${hello.version} en ${mongoose.connection.host}:${mongoose.connection.port}`);
  await mongoose.connection.dropDatabase();
  ok('conectado y base de datos vaciada');

  const { User } = require('../dist/models/User');
  const { Field } = require('../dist/models/Field');
  const { Table } = require('../dist/models/Table');
  const { fieldManager } = require('../dist/game/field.manager');

  // ===================================================================
  section('1. Un campo con dos eliminados y sus fichas a la vista');

  await User.insertMany(IDS.map((telegramId, i) => ({
    telegramId,
    username: `jugador${i}`,
    firstName: `Jugador ${i}`,
    balance: { real: 5000, play: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  })));

  const campo = await Field.create({
    fieldId: FIELD_ID,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    buyInUnits: BUY_IN,
    targetField: JUGADORES,
    waiting: 0,
    seated: JUGADORES,
    eliminated: 0,
    playersRemaining: JUGADORES,
    paidPositionsLeft: 5,
    rakeCollected: 0,
    deadChips: 0,
    buyInsCollected: BUY_INS,
    tables: [],
    plannedTables: 1,
    startedAt: new Date(),
  });

  const asiento = (index, telegramId, chips, status = 'active') => ({
    index,
    kind: 'human',
    playerId: String(telegramId),
    displayName: `Jugador ${telegramId}`,
    chips,
    bet: 0,
    totalBet: BUY_IN,
    status,
    joinedAt: new Date(),
  });

  // Los tres en la misma mesa, la mano en reposo. Dos ya sin fichas (eliminados) y el
  // tercero con las suyas.
  await Table.create({
    tableId: `${FIELD_ID}-t1`,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: BUY_IN,
    maxSeats: 7,
    field: {
      fieldId: FIELD_ID, tableNumber: 1, targetField: JUGADORES,
      seated: JUGADORES, paidPositions: 0, fieldStatus: 'running',
    },
    hand: {
      handNumber: 12, phase: 'idle', communityCards: [],
      pot: 0, currentBet: 0, actingSeat: -1,
    },
    stats: { handsPlayed: 12, rakeCollected: 0, prizePaid: 0 },
    seats: [
      asiento(0, IDS[0], SIN_FICHA, 'eliminated'),
      asiento(1, IDS[1], SIN_FICHA, 'eliminated'),
      asiento(2, IDS[2], FICHAS_GANADOR, 'active'),
    ],
  });

  // Las fichas que un eliminado puede acabar teniendo cuando el motor le devuelve
  // fichas de una mano antes de quedarse sin nada. Son las que hay que salvar.
  //
  // Aqui se ponen a proposito: los eliminados conservan parte de su stack. Es
  // exactamente el caso que rompia, porque el codigo asumia que un eliminado siempre
  // llega a cero y por eso no las movia a ninguna parte.
  const antes = await Table.findOne({ tableId: `${FIELD_ID}-t1` });
  antes.seats[0].chips = FICHAS_ELIMINADO_A;
  antes.seats[1].chips = FICHAS_ELIMINADO_B;
  await antes.save();

  const estado = await dineroDelCampo();
  const totalEsperado = FICHAS_ELIMINADO_A + FICHAS_ELIMINADO_B + FICHAS_GANADOR;

  note(`asiento 0 (eliminado): ${FICHAS_ELIMINADO_A} fichas`);
  note(`asiento 1 (eliminado): ${FICHAS_ELIMINADO_B} fichas`);
  note(`asiento 2 (vivo):      ${FICHAS_GANADOR} fichas`);
  note(`dinero en el campo: ${estado.enMesas} en mesas + ${estado.deadChips} en el bote`);

  if (estado.enMesas === totalEsperado) {
    ok(`el campo tiene sus ${totalEsperado} fichas antes de soltar a nadie`);
  } else {
    bad(`el campo tiene ${estado.enMesas}, esperado ${totalEsperado}`);
  }

  // ===================================================================
  section('2. Marcar `out` a los eliminados');

  // Esto lo hace `collectEliminations` al adjudicar la posicion. El asiento se marca,
  // pero las fichas se quedan donde estan a proposito.
  await Table.updateOne(
    { tableId: `${FIELD_ID}-t1` },
    { $set: { 'seats.$[s].status': 'out' } },
    { arrayFilters: [{ 's.status': 'eliminated' }] },
  );

  const marcados = await Table.findOne({ tableId: `${FIELD_ID}-t1` });
  note(`asientos tras marcar: ${marcados.seats.map((s) => `${s.index}:${s.status}:${s.chips}`).join(' ')}`);

  const conOut = marcados.seats.filter((s) => s.status === 'out');
  if (conOut.length === 2) ok('los dos eliminados estan `out`');
  else bad(`${conOut.length} asientos out, esperados 2`);

  const fichasEnOut = conOut.reduce((s, x) => s + Math.max(0, x.chips), 0);
  if (fichasEnOut === FICHAS_ELIMINADO_A + FICHAS_ELIMINADO_B) {
    ok(`los asientos out conservan sus ${fichasEnOut} fichas: todavia no se han soltado`);
  } else {
    bad(`los asientos out tienen ${fichasEnOut} fichas, esperado ${FICHAS_ELIMINADO_A + FICHAS_ELIMINADO_B}`);
  }

  // ===================================================================
  section('3. Soltarlos: SUS FICHAS TIENEN QUE IR AL BOTE DEL CAMPO');

  // Este es el momento en que el bug destruia el dinero. El asiento se quita del array
  // y, si sus fichas no van antes a `deadChips`, desaparecen.
  const fichasAlBote = await fieldManager.liberarAsientosLiquidados(campo, marcados);
  const esperadoAlBote = FICHAS_ELIMINADO_A + FICHAS_ELIMINADO_B;

  if (fichasAlBote === esperadoAlBote) {
    ok(`${fichasAlBote} fichas han pasado al bote del campo`);
  } else {
    bad(`han pasado ${fichasAlBote} fichas al bote, esperado ${esperadoAlBote}`);
  }

  const trasLiberar = await Table.findOne({ tableId: `${FIELD_ID}-t1` });
  note(`asientos tras soltar: ${trasLiberar.seats.map((s) => `${s.index}:${s.status}:${s.chips}`).join(' ')}`);

  if (trasLiberar.seats.length === 1) ok('solo queda el jugador vivo');
  else bad(`quedan ${trasLiberar.seats.length} asientos, esperado 1`);

  if (trasLiberar.seats[0] && trasLiberar.seats[0].chips === FICHAS_GANADOR) {
    ok(`el vivo conserva sus ${FICHAS_GANADOR} fichas: no le ha tocado nada`);
  } else {
    bad(`el vivo tiene ${trasLiberar.seats[0]?.chips} fichas, esperado ${FICHAS_GANADOR}`);
  }

  // ===================================================================
  section('4. LA PRUEBA QUE IMPORTA: el dinero sigue existiendo');

  const final = await dineroDelCampo();
  const total = final.enMesas + final.deadChips;

  note(`mesas ${final.enMesas} + bote ${final.deadChips} = ${total}`);

  if (total === totalEsperado) {
    ok(`NO SE HA PERDIDO NI UNA FICHA: siguen siendo ${totalEsperado}`);
  } else {
    bad(
      `SE HAN PERDIDO ${totalEsperado - total} FICHAS`,
      'Es el bug: el asiento se ha quitado del array y sus fichas se han ido con el.',
    );
  }

  if (final.deadChips === esperadoAlBote) {
    ok(`las fichas estan en \`deadChips\`, que es donde las recoge \`settleField\``);
  } else {
    bad(`\`deadChips\` vale ${final.deadChips}, esperado ${esperadoAlBote}`);
  }

  // ===================================================================
  section('5. Y las carteras no se han tocado');

  // Un eliminado pierde sus fichas: van al bote, no a su cartera. Es el dreno que ya se
  // corrigio antes, y este test lo vuelve a comprobar para que el arreglo de la fuga no
  // lo haya reintroducido por el otro lado.
  const totales = await User.aggregate([
    { $group: { _id: null, real: { $sum: '$balance.real' }, play: { $sum: '$balance.play' } } },
  ]);
  const real = totales[0]?.real ?? 0;
  const play = totales[0]?.play ?? 0;

  note(`carteras: ${real} en real, ${play} en promocion`);

  if (real === 15_000 && play === 0) {
    ok('las carteras siguen intactas: nadie ha recuperado fichas');
  } else {
    bad(
      `las carteras han cambiado: real=${real} (esperado 15000), play=${play} (esperado 0)`,
      'Si un eliminado recupera fichas, el buy-in vuelve a su cartera y el ciclo se ' +
      'puede repetir gratis.',
    );
  }

  // ===================================================================
  section('6. Soltar dos veces no crea ni duplica dinero');

  const otra = await fieldManager.liberarAsientosLiquidados(campo, trasLiberar);
  const trasSegunda = await dineroDelCampo();

  if (otra === 0) ok('una segunda pasada no mueve nada: no hay ya asientos `out`');
  else bad(`una segunda pasada movio ${otra} fichas`);

  if (trasSegunda.enMesas + trasSegunda.deadChips === total) {
    ok(`el total sigue siendo ${total}: repetir la operacion es idempotente`);
  } else {
    bad(`el total cambio a ${trasSegunda.enMesas + trasSegunda.deadChips}`);
  }

  await finish();
}