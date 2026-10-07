/**
 * PROVOCA LA CARRERA DE ESCRITURA Y COMPRUEBA QUE YA NO PASA.
 *
 * ------------------------------------------------------------------
 * QUE ERA
 *
 * El tick del motor y la peticion HTTP (sentarse / levantarse) escriben el MISMO documento de
 * mesa. El motor se serializaba consigo mismo con `withTableLock`, pero el servicio de
 * asientos guardaba FUERA del cerrojo una copia leida antes. En produccion:
 *
 *     VersionError: No matching document found for id "6ac520e3..." version 66
 *       modifiedPaths "seats, seats.3, seats.3.handsWon, seats.4, hand, hand.phase,
 *       hand.communityCards, hand.actingSeat, seats.1.status, seats.4.chips"
 *
 * Mongo resuelve por version y descarta UNA de las dos escrituras. Con fichas de por medio eso
 * es: o el asiento no se guarda (y el jugador esta "sentado" sin estarlo), o la mano pierde un
 * estado. Ninguna de las dos es aceptable.
 *
 * ------------------------------------------------------------------
 * QUE HACE ESTE TEST
 *
 * Monta el caso real: N operaciones de escritura concurrentes sobre la MISMA mesa, en el mismo
 * instante. Si los caminos comparten el cerrojo, se serializan y todas se conservan. Si no,
 * se pierde alguna y salta `VersionError`.
 *
 * Se mide lo que importa: que no se pierda ninguna escritura. No que "no salte un error",
 * porque un error tambien puede aparecer y recuperar bien: lo que no se admite es perder datos.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Table } = require('../dist/models/Table');
const { tableManager } = require('../dist/game/table.manager');

const TID = 600000001;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Base limpia para el test.
  await db.collection('tables').deleteMany({ tableId: 'test-carrera' });
  await db.collection('users').deleteMany({ telegramId: TID });
  await db
    .collection('users')
    .insertOne({
      telegramId: TID,
      firstName: 'Carrera',
      balance: { real: 1000000, play: 0 },
      stats: {
        handsPlayed: 0, handsWon: 0, tablesJoined: 0,
        freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
      },
      activeTableId: null,
    });

  const creada = await Table.create({
    tableId: 'test-carrera',
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    buyInUnits: 1000,
    smallBlind: 5,
    bigBlind: 10,
    maxSeats: 7,
    field: { tableNumber: 1, targetField: 0, fieldStatus: 'running' },
    seats: [{ index: 0, kind: 'bot', playerId: 'bot-1', displayName: 'Bot', chips: 1000, bet: 0, status: 'active' }],
    hand: { handNumber: 0, phase: 'idle', pot: 0, currentBet: 0, communityCards: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log(`Mesa de prueba creada: ${creada.tableId}`);
  console.log('Lanzando 40 escrituras concurrentes sobre la MISMA mesa...');

  const errores = [];
  const RIVALES = 40;

  // Cada escritura hace lo que hace el motor y lo que hace el servicio: tocar el documento y
  // guardarlo. Alternando entre tocar `hand` y tocar `seats`, que es exactamente lo que
  // chocaba en produccion (modifiedPaths con las dos cosas mezcladas).
  const trabajo = Array.from({ length: RIVALES }, (_, i) =>
    tableManager.withTableLock('test-carrera', async () => {
      const t = await Table.findOne({ tableId: 'test-carrera' });

      if (i % 2 === 0) {
        // Camino del motor: avanza la mano.
        t.hand.handNumber = (t.hand.handNumber ?? 0) + 1;
        t.hand.pot = (t.hand.pot ?? 0) + 1;
      } else {
        // Camino del servicio: marca al jugador.
        t.seats[0].chips = 1000 + i;
      }

      await t.save();
    }).catch((e) => {
      errores.push(e.constructor.name + ': ' + e.message.slice(0, 90));
    }),
  );

  await Promise.all(trabajo);

  // El contador final tiene que cuadrar exactamente con las escrituras que se hicieron.
  const final = await Table.findOne({ tableId: 'test-carrera' });
  const esperadosPares = Math.ceil(RIVALES / 2);

  console.log('');
  console.log(`Errores: ${errores.length}`);
  for (const e of errores.slice(0, 4)) console.log('  ' + e);

  console.log('');
  console.log(`manos esperadas: ${esperadosPares} · manos guardadas: ${final.hand.handNumber}`);
  const manosOk = final.hand.handNumber === esperadosPares;
  console.log(`  ${manosOk ? 'OK' : 'FALLA'}: ningun avance de mano se perdio`);

  const limpio = errores.length === 0 && manosOk;
  console.log('');
  console.log(limpio
    ? 'RESULTADO: ninguna escritura se perdio. El cerrojo funciona.'
    : 'RESULTADO: se perdieron escrituras. El cerrojo NO cubre todos los caminos.');

  await db.collection('tables').deleteMany({ tableId: 'test-carrera' });
  await db.collection('users').deleteMany({ telegramId: TID });
  await mongoose.disconnect();
  process.exit(limpio ? 0 : 1);
})().catch((e) => { console.error('ERROR DEL TEST:', e); process.exit(1); });
