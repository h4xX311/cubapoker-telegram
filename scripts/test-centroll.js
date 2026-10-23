/**
 * EL CENTROLL COBRA UNA VEZ, ANOTA A QUIEN, Y DEVUELVE SI NO ARRANCA.
 *
 * ------------------------------------------------------------------
 * LO QUE ESTABA ROTO, Y NO SE VEIA
 *
 * `centroll.service.ts` creaba el campo asi:
 *
 *     return Field.create({ kind: 'centroll', buyIn, ... });
 *
 * Y el esquema decia:
 *
 *     kind: { type: String, enum: ['cash', 'freeroll'] }
 *     buyInUnits: { type: Number, required: true }
 *
 * O sea: `centroll` no era un `kind` valido, y `buyIn` no era una clave del esquema (la
 * buena es `buyInUnits`, que ademas era obligatoria). Mongoose no avisa de las claves que
 * sobran, solo del enum y del required.
 *
 * Resultado: **el centroll no se podia abrir nunca.** El jugador pulsaba y veia "no se pudo".
 *
 * Comprobado antes de arreglarlo, con `scripts/test-centroll-creable.js`:
 *
 *     kind=cash      -> creado
 *     kind=centroll  -> FALLA: `centroll` is not a valid enum value for path `kind`
 *
 * ------------------------------------------------------------------
 * LO QUE SE COMPRUEBA AQUI
 *
 * 1. Se abre y se puede entrar: el jugador paga y queda anotado.
 * 2. El bote es exactamente lo cobrado (sin el bug de escrituras perdidas).
 * 3. Pulsar JUGAR dos veces NO cobra dos veces.
 * 4. Si el centroll no arranca, se devuelve el buy-in. Y solo una vez.
 *
 * Ejecutar (Mongo local esta en WSL):
 *     cd "$HOME/cp" && npm run build
 *     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_centroll \
 *       node scripts/test-centroll.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { centrollService } = require('../dist/game/centroll.service');
const { Field } = require('../dist/models/Field');
const { User } = require('../dist/models/User');
const { CENTROLL } = require('../dist/config/product');
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
  // 1. ABRIR Y ENTRAR
  // ==================================================================
  console.log('=== 1. Se puede entrar en un centroll ===\n');

  let campoId = null;
  for (const id of IDS) {
    try {
      const r = await centrollService.register(id, 'C' + String(id).slice(-3));
      campoId = r.fieldId;
      console.log(`  ${id} entro en ${r.fieldId} (${r.queued ? 'en cola' : 'sentado'})`);
    } catch (e) {
      console.log(`\x1b[31m  ${id} NO pudo entrar: ${e.message}\x1b[0m`);
      mal++;
    }
  }

  comprobar('el centroll se abrio', campoId !== null, 'no se abrio ninguno');

  const campo = await Field.findOne({ fieldId: campoId });
  console.log(
    `  campo: espera=${campo.waiting} sentados=${campo.seated} ` +
    `cobrado=${campo.buyInsCollected} registrados=${(campo.registrations ?? []).length}`,
  );

  comprobar(
    `el campo anota a los ${IDS.length} que pagaron`,
    (campo.registrations ?? []).length === IDS.length,
    `hay ${(campo.registrations ?? []).length}`,
  );

  comprobar(
    `el bote es exactamente ${buyIn * IDS.length}`,
    campo.buyInsCollected === buyIn * IDS.length,
    `hay ${campo.buyInsCollected}`,
  );

  for (const id of IDS) {
    const s = await saldoDe(id);
    comprobar(
      `a ${id} se le cobro UNA vez`,
      s === SALDO - buyIn,
      `tenia ${SALDO}, ahora ${s}`,
    );
  }

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

  comprobar('el segundo intento se rechaza', bloqueado, 'entró otra vez');
  comprobar(
    `a ${IDS[0]} NO se le cobro dos veces`,
    (await saldoDe(IDS[0])) === SALDO - buyIn,
    `tiene ${await saldoDe(IDS[0])}, esperado ${SALDO - buyIn}`,
  );

  const campo2 = await Field.findOne({ fieldId: campoId });
  comprobar(
    'el bote no subio con el segundo intento',
    campo2.buyInsCollected === buyIn * IDS.length,
    `hay ${campo2.buyInsCollected}`,
  );

  // ==================================================================
  // 3. DEVOLVER SI NO ARRANCA
  // ==================================================================
  console.log('\n=== 3. Si no arranca, se devuelve ===\n');

  const antes = await saldoDe(IDS[1]);
  const devuelto = await centrollService.refundIfNotStarted(IDS[1]);

  console.log(`  devuelto a ${IDS[1]}: ${formatUnits(devuelto)} USDT`);
  comprobar('devuelve el buy-in', devuelto === buyIn, `devolvio ${devuelto}`);
  comprobar(
    `el saldo de ${IDS[1]} vuelve a ${SALDO}`,
    (await saldoDe(IDS[1])) === SALDO,
    `antes ${antes}, ahora ${await saldoDe(IDS[1])}`,
  );

  const campo3 = await Field.findOne({ fieldId: campoId });
  comprobar(
    'el bote baja lo devuelto',
    campo3.buyInsCollected === buyIn * (IDS.length - 1),
    `hay ${campo3.buyInsCollected}`,
  );
  comprobar(
    'y la entrada queda marcada como devuelta',
    (campo3.registrations ?? []).find((r) => r.telegramId === IDS[1])?.status === 'refunded',
    `estado=${(campo3.registrations ?? []).find((r) => r.telegramId === IDS[1])?.status}`,
  );

  // ==================================================================
  // 4. Y NO SE DEVUELVE DOS VECES
  // ==================================================================
  console.log('\n=== 4. Devolver dos veces no paga dos veces ===\n');

  const otraVez = await centrollService.refundIfNotStarted(IDS[1]);
  comprobar('la segunda devolucion devuelve 0', otraVez === 0, `devolvio ${otraVez}`);
  comprobar(
    `el saldo de ${IDS[1]} sigue en ${SALDO}`,
    (await saldoDe(IDS[1])) === SALDO,
    `tiene ${await saldoDe(IDS[1])}`,
  );

  // ==================================================================
  // 5. CONCURRENCIA: 10 a la vez, el bote tiene que cuadrar
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

  const campoCon = await Field.findOne({ kind: 'centroll' });
  const camposVivos = await Field.countDocuments({
    kind: 'centroll',
    status: { $in: ['filling', 'running', 'final'] },
  });

  comprobar(
    'se abrio UN solo centroll',
    camposVivos === 1,
    `hay ${camposVivos} campos vivos a la vez`,
  );
  comprobar(
    `el bote es ${buyIn * buenos.length} (lo cobrado de verdad)`,
    campoCon.buyInsCollected === buyIn * buenos.length,
    `hay ${campoCon.buyInsCollected}, faltan ${buyIn * buenos.length - campoCon.buyInsCollected}`,
  );
  comprobar(
    'las entradas anotadas son las mismas que los cobros',
    (campoCon.registrations ?? []).length === buenos.length,
    `${(campoCon.registrations ?? []).length} entradas para ${buenos.length} cobros`,
  );

  let cobradoReal = 0;
  for (const id of C) cobradoReal += SALDO - (await saldoDe(id));
  comprobar(
    'el bote es exactamente lo que salio de las carteras',
    cobradoReal === campoCon.buyInsCollected,
    `carteras ${cobradoReal}, campo ${campoCon.buyInsCollected}`,
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
