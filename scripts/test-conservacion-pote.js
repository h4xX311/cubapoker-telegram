/**
 * EL BOTE DEL CAMPO TIENE QUE CUADRAR CON EL DINERO COBRADO.
 *
 * ------------------------------------------------------------------
 * EL FALLO QUE ESTE TEST ATRAPA
 *
 * `register()` hace el cobro en dos mitades:
 *
 *     await Field.updateOne({_id}, { $inc: { waiting: 1, buyInsCollected: buyIn } });
 *     field.waiting += 1;                                  // el objeto en memoria
 *     field.buyInsCollected += buyIn;                      // NO lo toca el $inc
 *     ...
 *     const seated = await this.trySeat(field);            // -> await field.save()
 *
 * Esas dos lineas en memoria NO son un error: `$inc` no modifica el documento que ya
 * tengo en memoria, asi que sumarlas ahi es lo que lo pone al dia con la base. Quitarlas
 * seria equivocarse al reves.
 *
 * El fallo es el `save()` de despues. `trySeat()` acaba en `await field.save()`, y mongoose
 * escribe TODOS los caminos que quedaron marcados como modificados, entre ellos
 * `buyInsCollected` y `waiting`. O sea: un `$inc` atomico seguido de un `$set` con un valor
 * leido hace rato.
 *
 * Con dos registros a la vez:
 *
 *     A lee buyInsCollected = 0        B lee buyInsCollected = 0
 *     A hace $inc  -> base = 1000      B hace $inc  -> base = 2000
 *     A en memoria = 1000              B en memoria = 1000   (¡LEIDO ANTES!)
 *     A save()     -> base = 1000      B save()     -> base = 1000
 *
 * `buyInsCollected` acaba en 1000 habiendo cobrado a 2 personas: **1000 unidades de la nada
 * y dos jugadores con las fichas fuera.**
 *
 * En poker real eso no es un numero feo. El bote del campo es el premio. Si el bote sale
 * corto, al ganador se le paga de menos y la diferencia sale de la plataforma.
 *
 * ------------------------------------------------------------------
 * COMO SE COMPRUEBA
 *
 * Por cuadrar, no por leer. Se registra a N jugadores de forma concurrente (que es lo que
 * pasa cuando abren el bot a la vez) y se mira si el contador del campo coincide con lo que
 * se les ha cobrado de verdad a sus carteras.
 *
 * Las dos cifras se calculan por separado y se comparan. Si el codigo mintiera sobre el
 * bote, aqui se veria.
 *
 * Ejecutar (Mongo local esta en WSL):
 *     cd "$HOME/cp" && npm run build
 *     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_pote \
 *       node scripts/test-conservacion-pote.js
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

const saldoDe = async (id) => (await User.findOne({ telegramId: id }))?.balance?.real ?? 0;

/** Reparte N idsStarting en 888M para que no choquen con usuarios reales. */
const idsDe = (n, base) => Array.from({ length: n }, (_, i) => base + i);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // ==================================================================
  // 1. SECUENCIAL: la referencia. 10 personas, uno detras de otro.
  // ==================================================================
  console.log('=== 1. Registro SECUENCIAL (debe cuadrar) ===\n');

  const A = idsDe(10, 880000001);
  const SALDO = buyIn * 20;
  for (const id of A) {
    await db.collection('users').deleteMany({ telegramId: id });
    await crearJugador(id, SALDO);
  }

  let campoId;
  for (const id of A) {
    const r = await fieldManager.register(id, NIVEL);
    campoId = r.fieldId;
  }

  const campoSec = await Field.findOne({ fieldId: campoId });
  const esperado = buyIn * A.length;

  console.log(`  ${A.length} jugadores, buy-in de ${buyIn} unidades`);
  console.log(`  bote del campo: ${campoSec.buyInsCollected} (esperado ${esperado})`);
  console.log(`  esperando=${campoSec.waiting}  sentados=${campoSec.seated}`);

  comprobar(
    `el bote secuencial es exactamente ${esperado}`,
    campoSec.buyInsCollected === esperado,
    `hay ${campoSec.buyInsCollected}, sobran/faltan ${campoSec.buyInsCollected - esperado}`,
  );

  let gastadoSec = 0;
  for (const id of A) gastadoSec += SALDO - (await saldoDe(id));

  comprobar(
    `a los ${A.length} se les ha cobrado ${esperado} en total`,
    gastadoSec === esperado,
    `cobrado ${gastadoSec}`,
  );

  // Limpieza antes del caso dificil
  await db.collection('fields').deleteMany({ fieldId: campoId });
  await db.collection('tables').deleteMany({ 'field.fieldId': campoId });
  for (const id of A) await db.collection('users').deleteMany({ telegramId: id });

  // ==================================================================
  // 2. CONCURRENTE: 20 registros a la vez. Esto es lo que pasa cuando
  //    el bot abre a un grupo de gente.
  // ==================================================================
  console.log('\n=== 2. Registro CONCURRENTE (el caso que rompe) ===\n');

  const B = idsDe(20, 880000101);
  for (const id of B) {
    await db.collection('users').deleteMany({ telegramId: id });
    await crearJugador(id, SALDO);
  }

  // Todos a la vez, sin esperar entre medias.
  const resultados = await Promise.allSettled(
    B.map((id) => fieldManager.register(id, NIVEL)),
  );

  const buenos = resultados.filter((r) => r.status === 'fulfilled');
  const fallos = resultados.filter((r) => r.status === 'rejected');
  campoId = buenos[0]?.value?.fieldId;

  console.log(`  ${buenos.length} registrados, ${fallos.length} con error`);
  for (const f of fallos.slice(0, 3)) console.log(`    fallo: ${f.reason?.message}`);
  const mismosCampos = new Set(buenos.map((r) => r.value.fieldId));
  console.log(`  campos usados: ${[...mismosCampos].join(', ')}`);

  comprobar(
    'todos los registros van al mismo campo',
    mismosCampos.size <= 1,
    `se han abierto ${mismosCampos.size} campos a la vez: el que elige el campo NO va protegido`,
  );

  const campoCon = await Field.findOne({ fieldId: campoId });
  const esperadoCon = buyIn * buenos.length;
  const perdido = esperadoCon - campoCon.buyInsCollected;

  console.log(`  bote del campo: ${campoCon.buyInsCollected} (esperado ${esperadoCon})`);
  console.log(
    perdido === 0
      ? '  sin diferencia'
      : `  DIFERENCIA: ${perdido > 0 ? 'FALTAN' : 'SOBRAN'} ${Math.abs(perdido)} unidades`,
  );

  comprobar(
    `el bote concurrente es exactamente ${esperadoCon}`,
    campoCon.buyInsCollected === esperadoCon,
    `hay ${campoCon.buyInsCollected}, diferencia ${perdido}`,
  );

  comprobar(
    `waiting + sentados = ${buenos.length} jugadores`,
    campoCon.waiting + campoCon.seated === buenos.length,
    `waiting=${campoCon.waiting} sentados=${campoCon.seated}, esperados ${buenos.length}`,
  );

  // ------------------------------------------------------------------
  // LA COMPROBACION QUE IMPORTA: EL BOTE CONTRA LAS CARTERAS
  //
  // El contador del campo puede cuadrar por casualidad y el dinero no estar ahi. Se
  // suman los saldos reales y se comparan con lo que el campo dice tener.
  // ------------------------------------------------------------------
  let cobradoReal = 0;
  for (const id of B) cobradoReal += SALDO - (await saldoDe(id));

  console.log(`  cobrado de las carteras: ${cobradoReal}`);
  console.log(`  dice el campo:           ${campoCon.buyInsCollected}`);

  comprobar(
    'el bote del campo es lo que salio de las carteras',
    cobradoReal === campoCon.buyInsCollected,
    `carteras ${cobradoReal}, campo ${campoCon.buyInsCollected}, diferencia ${cobradoReal - campoCon.buyInsCollected}`,
  );

  // ==================================================================
  console.log(`\n${'='.repeat(56)}`);
  console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
  if (mal > 0) {
    console.log('');
    console.log('Un bote que no cuadra con el dinero cobrado es dinero que aparece o');
    console.log('desaparece. Si la diferencia es negativa, al ganador se le paga de menos.');
  }
  console.log('='.repeat(56));

  for (const id of [...A, ...B]) await db.collection('users').deleteMany({ telegramId: id });
  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});

  await mongoose.disconnect();
  process.exit(mal > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERROR DEL TEST:', e);
  process.exit(1);
});
