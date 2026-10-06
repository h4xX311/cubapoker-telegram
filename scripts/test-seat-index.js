/**
 * Test de los indices de asiento, y del problema queoducia un indice repetido.
 *
 * ------------------------------------------------------------------
 * EL BUG
 *
 * Tres sitios asignaban el indice de un asiento como `seats.length`:
 *
 *   buildSeat              index: table.seats.length
 *   checkMerges            const newIndex = target.seats.length
 *   forceMergeIntoOne      index: keeper.seats.length
 *
 * Eso solo es correcto si los indices son 0, 1, 2, 3... sin huecos. Y en un campo
 * dejan de serlo en cuanto se libera un asiento: cuando un eliminado pasa a `out`,
 * `finishHand` lo quita del array y los demas conservan el indice que tenian.
 *
 * Una mesa de 7 con el asiento 2 liberado queda con los indices [0, 1, 3, 4, 5, 6].
 * `seats.length` dice 6, pero el 6 ya esta ocupado. El siguiente jugador que se
 * sienta recibe el 6 y se queda con DOS ASIENTOS EN EL MISMO INDICE.
 *
 * ------------------------------------------------------------------
 * POR QUE UN INDICE REPETIDO ES UN BUG DE DINERO
 *
 * El indice de asiento es la IDENTIDAD del jugador dentro del motor: se pasa como id
 * en `engine.performAction(index.toString(), ...)` y se busca por el en
 * `resolveActingSeat` y en `syncEngineToTable`. Con dos asientos en el mismo indice:
 *
 *   - el motor registra DOS jugadores con el mismo id, y `performAction` actua
 *     siempre sobre el primero: el segundo no juega nunca.
 *   - `syncEngineToTable` busca por indice y encuentra el primero: las fichas del
 *     segundo asiento no se escriben jams.
 *
 * Ese asiento queda huerfano. `isSeated` lo ve ocupado (mira por `playerId`), asi que
 * nadie vuelve a sentarlo, pero el motor no lo juega, no se elimina y no cobra
 * posicion. El campo se queda con un jugador que no existe para nadie y con fichas
 * congeladas.
 *
 * Visto jugando un campo entero: la mesa final acabo con los indices
 * [1, 2, 3, 3, 4] y 12,98 USDT de fichas quietas durante 2 500 rondas.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_indices node scripts/test-seat-index.js
 */

process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_indices';

// El bot arranca polling de Telegram al importarse, asi que esto va ANTES de cargar
// nada del proyecto.
process.env.DEV_AUTH_BYPASS = 'false';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.ADMIN_API_KEY = 'clave-de-prueba-indices';
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

/** Como se ven los indices de una mesa, en una linea. */
const lista = (seats) => seats.map((s) => s.index).join(',');

async function main() {
  console.log('\n\x1b[1mCubaPoker · Indices de asiento\x1b[0m');
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
  section('1. Elegir el indice libre, sin huecos ni repeticiones');

  // Es aritmetica, asi que se prueban todos los casos raros que se tercian.
  const libre = (indices) =>
    fieldManager.primerIndiceLibre(indices.map((i) => ({ index: i })));

  const casos = [
    [[], 0, 'mesa vacia: el primero es el 0'],
    [[0], 1, 'una mesa con el 0: el siguiente es el 1'],
    [[0, 1, 2], 3, 'mesa llena y contigua: el siguiente es el siguiente'],
    [[1, 2, 3], 0, 'hueco al principio: se reutiliza el 0'],
    [[0, 2, 3], 1, 'hueco en medio: se reutiliza el 1'],
    [[0, 1, 3, 4, 5, 6], 2, 'hueco al final de una lista larga: se reutiliza el 2'],
    [[0, 1, 3, 4, 5], 2, 'hueco antes del ultimo: se rellena'],
    [[2, 4, 6], 0, 'indices muy separados: se empieza por el 0'],
    [[0, 1, 2, 3, 4, 5, 6], 7, 'mesa de 7 llena: el 7'],
    // El caso que rompia el codigo: dos con el mismo indice.
    [[0, 1, 3, 3], 2, 'hay un indice repetido: se elige el hueco, no el length'],
    [[0, 1, 3, 3, 4], 2, 'repetido en medio: idem'],
    // Y el caso del dato sucio, por si el esquema deja pasar algo raro.
    [[0, 1, undefined], 2, 'un indice undefined no ocupa sitio'],
    [[0, 1, -1], 2, 'un indice negativo no cuenta como ocupado'],
    [[0, 1, 2.7], 2, 'un indice decimal no ocupa sitio: el 2 sigue libre'],
  ];

  for (const [indices, esperado, porque] of casos) {
    const got = libre(indices);
    if (got === esperado) {
      ok(`[${indices.join(',') || 'vacio'}] -> ${got}: ${porque}`);
    } else {
      bad(
        `[${indices.join(',') || 'vacio'}] devolvio ${got}, esperado ${esperado}`,
        porque,
      );
    }
  }

  // Lo que hacia el codigo viejo, para que se vea la diferencia y no se vuelva.
  const viejo = (seats) => seats.length;
  const conHueco = [0, 1, 3, 4, 5, 6];
  note('');
  note(`mesa con el 2 liberado: indices [${conHueco.join(',')}]`);
  note(`  el codigo viejo devolvia ${viejo(conHueco)} -> choca con el 6 que ya esta ocupado`);
  note(`  ahora devuelve ${libre(conHueco)} -> es justo el hueco`);

  if (viejo(conHueco) !== libre(conHueco)) {
    ok('el cambio de regla no es cosmetico: los dos dan numeros distintos');
  }

  // ===================================================================
  section('2. Una fusion de verdad, contra MongoDB');

  const IDS = [710_000_000, 710_000_001, 710_000_002, 710_000_003, 710_000_004,
    710_000_005, 710_000_006, 710_000_007];

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

  const FIELD_ID = 'idx-t1';

  const campo = await Field.create({
    fieldId: FIELD_ID,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    buyInUnits: 1000,
    targetField: 8,
    waiting: 0,
    seated: 8,
    eliminated: 0,
    playersRemaining: 8,
    paidPositionsLeft: 5,
    rakeCollected: 0,
    deadChips: 0,
    buyInsCollected: 8000,
    tables: [],
    plannedTables: 2,
    startedAt: new Date(),
  });

  const asiento = (index, telegramId, chips = 1000) => ({
    index,
    kind: 'human',
    playerId: String(telegramId),
    displayName: `Jugador ${telegramId}`,
    chips,
    bet: 0,
    totalBet: 1000,
    status: 'active',
    joinedAt: new Date(),
  });

  // La mesa origen: un solo jugador activo, que es lo que dispara la fusion
  // (`MERGE_BELOW` es 4).
  await Table.create({
    tableId: `${FIELD_ID}-t1`,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 1000,
    maxSeats: 7,
    field: {
      fieldId: FIELD_ID, tableNumber: 1, targetField: 8,
      seated: 1, paidPositions: 0, fieldStatus: 'running',
    },
    hand: { handNumber: 1, phase: 'idle', communityCards: [], pot: 0, currentBet: 0, actingSeat: -1 },
    stats: { handsPlayed: 1, rakeCollected: 0, prizePaid: 0 },
    seats: [asiento(0, IDS[0])],
  });

  // La mesa destino CON UN HUECO: el asiento 2 se libero antes y nadie renumero.
  // Esta es la situacion real de un campo a mitad de partida.
  const destinoIndices = [0, 1, 3, 4, 5, 6];
  await Table.create({
    tableId: `${FIELD_ID}-t2`,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 1000,
    maxSeats: 7,
    field: {
      fieldId: FIELD_ID, tableNumber: 2, targetField: 8,
      seated: destinoIndices.length, paidPositions: 0, fieldStatus: 'running',
    },
    hand: { handNumber: 1, phase: 'idle', communityCards: [], pot: 0, currentBet: 0, actingSeat: -1 },
    stats: { handsPlayed: 1, rakeCollected: 0, prizePaid: 0 },
    seats: destinoIndices.map((i, k) => asiento(i, IDS[1 + k])),
  });

  note(`origen t1: 1 jugador, indice [0]`);
  note(`destino t2: 6 jugadores, indices [${destinoIndices.join(',')}] (falta el 2)`);
  note('la mesa destino tiene hueco, que es lo normal en un campo en marcha');

  await fieldManager.checkMerges(campo);

  const destino = await Table.findOne({ tableId: `${FIELD_ID}-t2` });
  const origen = await Table.findOne({ tableId: `${FIELD_ID}-t1` });

  note('');
  note(`t1 quedo con [${lista(origen.seats)}], status ${origen.status}`);
  note(`t2 quedo con [${lista(destino.seats)}]`);

  // --- lo que exige este test ---
  const indices = destino.seats.map((s) => Number(s.index));
  const repetidos = indices.filter((i, k) => indices.indexOf(i) !== k);

  if (repetidos.length === 0) {
    ok(`t2 no tiene ningun indice repetido: [${indices.join(',')}]`);
  } else {
    bad(
      `t2 TIENE ${repetidos.length} INDICE(S) REPETIDO(S): [${indices.join(',')}]`,
      'Un indice repetido mete a dos jugadores en la misma identidad dentro del ' +
      'motor: uno no juega nunca y el otro no ve sus fichas escritas.',
    );
  }

  if (new Set(indices).size === indices.length) {
    ok(`${indices.length} asientos, ${new Set(indices).size} identidades distintas`);
  } else {
    bad(`${indices.length} asientos pero solo ${new Set(indices).size} identidades`);
  }

  // Y el jugador movido tiene que estar ahi, con fichas, no duplicado.
  const movido = destino.seats.find((s) => s.playerId === String(IDS[0]));
  if (movido && movido.chips === 1000) {
    ok(`el jugador movido esta en t2 con sus ${movido.chips} fichas, indice ${movido.index}`);
  } else {
    bad(
      `el jugador movido no esta bien: ${movido ? `indice ${movido.index}, ${movido.chips} fichas` : 'no esta en la mesa'}`,
    );
  }

  // Ningun jugador repetido en la mesa.
  const jugadores = destino.seats.map((s) => s.playerId);
  if (new Set(jugadores).size === jugadores.length) {
    ok('ningun jugador esta dos veces en la misma mesa');
  } else {
    bad(`hay jugadores repetidos: ${jugadores.join(', ')}`);
  }

  // Y la fichas: ni se crean ni se pierden en una fusion.
  const fichasT1 = origen.seats.reduce((s, x) => s + x.chips, 0);
  const fichasT2 = destino.seats.reduce((s, x) => s + x.chips, 0);
  note('');
  note(`fichas: t1 ${fichasT1} + t2 ${fichasT2} = ${fichasT1 + fichasT2}`);

  if (fichasT1 + fichasT2 === 7000) {
    ok('la fusion no ha creado ni perdido fichas: siguen siendo 7 000');
  } else {
    bad(`las fichas suman ${fichasT1 + fichasT2}, y eran 7 000`);
  }

  await finish();
}