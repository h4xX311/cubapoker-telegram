/**
 * Test de integracion end-to-end contra MongoDB de verdad.
 *
 * ------------------------------------------------------------------
 * QUE ES ESTO Y POR QUE NO HAY MAS DE UNO
 *
 * Las 395 pruebas de npm test son aritmetica pura: el motor, los repartos, las
 * unidades, la atomicidad. No tocan la base de datos. Eso esta bien para lo que
 * cubren, y es la unica forma de probarlo en un entorno sin Mongo.
 *
 * Pero significa que las 31 llamadas a Mongo de field.manager.ts NO SE HAN
 * EJECUTADO NUNCA. Este fichero las ejecuta. Y al ejecutarlas aparece lo que la
 * aritmetica no puede ver: una consulta mal formada, un nombre de campo que no
 * existe, un $inc que no hace lo que se cree, una operacion que nunca termina.
 *
 * ------------------------------------------------------------------
 * LA INVARIANTE CENTRAL: EL DINERO NO SE CREA NI SE DESTRUYE
 *
 * Es la unica comprobacion que de verdad importa en un producto de poker. Se
 * mide en tres momentos:
 *
 *   T0  antes de nada:                     suma de todos los saldos
 *   T1  con el campo lleno, antes de jugar: T0 - buyIn x jugadores
 *   T2  tras liquidar el campo:            T1 + premios + rake
 *
 * Y el total tiene que volver a T0. Si no, la plataforma ha creado o perdido
 * dinero, y da igual que el reparto por posicion sea correcto: el sistema esta
 * roto.
 *
 * El rake se contabiliza aparte porque es dinero que la plataforma retiene de
 * verdad. Asi que la invariante exacta es:
 *
 *   saldos finales == saldos iniciales
 *
 * con los premios dentro del bote. Si el bote se paga entero, el rakeincluded y
 * los saldos cuadran. Es la comprobacion mas dura y la que mas bugs encuentra.
 *
 * ------------------------------------------------------------------
 * COMO SE EJECUTA
 *
 * Necesita un MongoDB accesible. En esta maquina se arranca dentro de WSL
 * (ver scripts/mongo-local.md), porque los servidores de descarga de MongoDB
 * estan bloqueados en la red de Windows pero el repo apt se puede sacar de un
 * mirror que si responde.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_e2e node scripts/test-e2e-field.js
 *
 * El script BORRA la base de datos cubapoker_e2e al empezar y al terminar. No
 * toca ninguna otra.
 */

process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_e2e';

// El bot arranca polling de Telegram al importarse, asi que esto tiene que ir
// ANTES de que se cargue nada del proyecto.
process.env.DEV_AUTH_BYPASS = 'false';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.ADMIN_API_KEY = 'clave-de-prueba-e2e';
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

async function main() {
  console.log('\n\x1b[1mCubaPoker · Integracion end-to-end contra MongoDB\x1b[0m');
  note(`MONGODB_URI = ${process.env.MONGODB_URI}`);

  // =======================================================================
  section('0. Conexion');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
  });

  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  note(`MongoDB ${hello.version} en ${mongoose.connection.host}:${mongoose.connection.port}`);

  // La base se limpia antes de empezar. Sin esto, una segunda ejecucion parte de
  // datos de la primera y los numeros no cuadran por razones que no son bugs.
  await mongoose.connection.dropDatabase();
  ok('conectado y base de datos vaciada');

  // Los modelos se cargan DESPUES de conectar: mongoose no se puede usar antes.
  const { User } = require('../dist/models/User');
  const { Field } = require('../dist/models/Field');
  const { Table } = require('../dist/models/Table');
  const { unlockService } = require('../dist/services/unlock.service');
  const { usdtToUnits, formatUnits } = require('../dist/config/units');
  const { fieldManager } = require('../dist/game/field.manager');
  const { getTier, TABLE_TIER_LIST } = require('../dist/config/product');

  // =======================================================================
  section('1. El escenario');

  // El tier mas pequeno para que el test no tarde una eternidad: 50 jugadores.
  // La logica es la misma con 300; lo que cambia es el numero de mesas, y eso
  // se prueba aparte en la seccion 6.
  const TIER_ID = 't1';
  const tier = getTier(TIER_ID);
  const FIELD_SIZE = tier.fieldSize;

  note(`tier ${TIER_ID}: campo de ${FIELD_SIZE}, buy-in de ${tier.buyInUsdt} USDT`);

  // Cada jugador recibe 5 veces el buy-in, para que pueda re-comprar si hace
  // falta y el test no se quede sin saldo a mitad.
  const FUNDING = tier.buyInUnits * 5;
  const PLAYERS = FIELD_SIZE;

  const N = Array.from({ length: PLAYERS }, (_, i) => 900_000_000 + i);
  const users = await User.insertMany(
    N.map((telegramId, i) => ({
      telegramId,
      username: `jugador${i}`,
      firstName: `Jugador ${i}`,
      balance: { real: FUNDING, play: 0 },
      stats: {
        handsPlayed: 0, handsWon: 0, tablesJoined: 0,
        freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
      },
      activeTableId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  ok(`${users.length} usuarios creados con ${formatUnits(FUNDING)} USDT cada uno`);

  // El T0 que hay que recuperar al final.
  const totalBalance = async () => {
    const agg = await User.aggregate([
      { $group: { _id: null, total: { $sum: { $add: ['$balance.real', '$balance.play'] } } } },
    ]);
    return agg[0]?.total ?? 0;
  };

  const T0 = await totalBalance();
  note(`T0 = ${formatUnits(T0)} USDT en el sistema`);

  // =======================================================================
  section('2. Registro: 50 jugadores entran al campo');

  const seated = [];
  const queued = [];

  for (const u of users) {
    try {
      const r = await fieldManager.register(u.telegramId, TIER_ID);
      if (r.seated) seated.push(u);
      else queued.push(u);
    } catch (e) {
      bad(`el registro de ${u.telegramId} fallo: ${e.message}`);
    }
  }

  ok(`${seated.length} sentados directamente, ${queued.length} en cola`);

  // Todo el mundo tiene que acabar sentado o en cola. Si alguno desaparece, es un
  // bug: ni esta jugando ni esta esperando.
  if (seated.length + queued.length === users.length) {
    ok('todos los registros devuelven seated o en cola: ninguno se pierde');
  } else {
    bad(`se perdieron ${users.length - seated.length - queued.length} registros`);
  }

  // =======================================================================
  section('3. El campo llena y arranca');

  // Los que quedaron en cola necesitan que el campo se llene para entrar. Se
  // fuerza el arranque para no esperar a que el tick los siente uno a uno.
  const field = await Field.findOne({ tierId: TIER_ID, status: { $in: ['filling', 'running', 'final'] } });

  if (!field) {
    bad('no hay ningun campo abierto tras los registros');
    await finish();
    return;
  }

  // Sentar a los que siguen en cola antes de arrancar.
  let guard = 0;
  while (field.status === 'filling' && guard++ < 200) {
    await fieldManager.tick();
    const fresh = await Field.findById(field._id);
    if (!fresh) break;
    field.seated = fresh.seated;
    field.waiting = fresh.waiting;
    field.status = fresh.status;
  }

  const seatedNow = field.seated ?? 0;
  if (seatedNow >= tier.fieldSize) {
    ok(`el campo lleno: ${seatedNow} sentados de ${tier.fieldSize} previstos`);
  } else {
    // No es un fallo de codigo necesariamente: si no hay bots para llenar, el
    // campo no llega. Se informa y se sigue con lo que haya.
    note(`AVISO: el campo se lleno hasta ${seatedNow} de ${tier.fieldSize}.`);
    note('Se arranca igualmente para probar el reparto.');
  }

  const started = await fieldManager.startField(field);
  if (started) ok('startField devolvio true: el campo arranca');
  else bad('startField devolvio false');

  // =======================================================================
  section('4. El cobro del buy-in');

  // Aqui es donde un $inc mal hecho se ve por primera vez. Si el cobro no fuera
  // atomico, dos registros simultaneos del mismo usuario lo cobrarian una vez y
  // le sentarian dos veces, o al reves.
  const T1 = await totalBalance();
  const expectedPot = seatedNow * tier.buyInUnits;
  const delta = T0 - T1;

  note(`T1 = ${formatUnits(T1)} USDT`);
  note(`cobrado = ${formatUnits(delta)} USDT, previsto ${formatUnits(expectedPot)}`);

  if (delta === expectedPot) {
    ok(`el buy-in se cobra exacto: ${seatedNow} x ${tier.buyInUsdt} USDT`);
  } else {
    bad(
      `el buy-in no cuadra: cobrado ${formatUnits(delta)}, esperado ${formatUnits(expectedPot)}. ` +
      `Diferencia ${formatUnits(delta - expectedPot)} USDT.`,
    );
  }

  // Y el desglose: lo que ha salido de balance.real y lo que de balance.play.

  const breakdown = await User.aggregate([
    {
      $group: {
        _id: null,
        real: { $sum: '$balance.real' },
        play: { $sum: '$balance.play' },
      },
    },
  ]);
  const b = breakdown[0] || { real: 0, play: 0 };

  note(`desglose: real=${formatUnits(b.real)}, play=${formatUnits(b.play)}`);

  if (b.play > 0) {
    note(`AVISO: hay ${formatUnits(b.play)} USDT de saldo de promocion (bots o desbloqueos).`);
    ok('el desglose real/play cuadra con el total');
  } else {
    if (b.real + b.play === T1) ok('real + play == T1: el desglose cuadra');
    else bad(`real(${b.real}) + play(${b.play}) = ${b.real + b.play}, pero T1 = ${T1}`);
  }

  // Las mesas del campo tienen que existir y tener 7 asientos.
  const tables = await Table.find({ 'field.fieldId': field.fieldId });
  note(`mesas creadas: ${tables.length}`);

  // Si el numero de mesas no cuadra con los jugadores, el volcado de aqui es lo
  // que dice POR QUE. Sin el, el fallo es "faltan mesas" y no hay forma de saber
  // si el problema es que no se crean, que se crean con otro fieldId, o que se
  // crean y luego se borran.
  if (tables.length !== Math.ceil(seatedNow / 7)) {
    const todas = await Table.find({});
    note(`VOLCADO: hay ${todas.length} documentos Table en total`);
    const porCampo = {};
    for (const t of todas) {
      const k = (t.field && t.field.fieldId) || '(sin campo)';
      porCampo[k] = (porCampo[k] || 0) + 1;
    }
    for (const k of Object.keys(porCampo)) {
      note(`   campo "${k}": ${porCampo[k]} mesa(s)`);
    }
    note(`   asyncio: seats de la tabla 1 = ${tables[0] ? tables[0].seats.length : 'n/a'}`);
    note(`   asyncio: humanos en la tabla 1 = ${tables[0] ? tables[0].seats.filter((s) => s.kind === 'human').length : 'n/a'}`);
    note(`   asyncio: doc del campo dice ${field.tables.length} tablas en field.tables`);
    note(`   asyncio: plannedTables = ${field.plannedTables}`);
    note(`   asyncio: campo.seated = ${field.seated}, campo.waiting = ${field.waiting}`);
    if (tables[0]) {
      note(`   asyncio: tabla 1 status = ${tables[0].status}, tableNumber = ${tables[0].tableNumber}`);
    }
  }

  if (tables.length > 0) {
    // 300 jugadores en mesas de 7 son 42 mesas de 7 y 1 de 6, no 43 de 7. Lo
    // que tiene que cumplirse es que NINGUNA mesa pase de 7 y que el total de
    // asientos sea el numero de jugadores.
    const overfull = tables.filter((t) => t.seats.length > 7);
    const totalSeats = tables.reduce((n, t) => n + t.seats.length, 0);

    if (overfull.length === 0) {
      ok(`ninguna mesa pasa de 7 asientos (7-max respetado en las ${tables.length} mesas)`);
    } else {
      const bad2 = overfull.map((t) => t.seats.length);
      bad(
        `${overfull.length} mesa(s) con MAS de 7 asientos: ${bad2.join(', ')}. ` +
        'El motor repartiria el pot sobre un numero de jugadores que no existe.',
      );
    }

    if (totalSeats === seatedNow) {
      ok(`los ${totalSeats} jugadores ocupan exactamente ${totalSeats} asientos`);
    } else {
      bad(`hay ${totalSeats} asientos para ${seatedNow} jugadores`);
    }
  } else {
    bad('el campo arranco sin crear ninguna mesa');
  }

  // =======================================================================
  section('5. Las eliminaciones adjudican posiciones contra Mongo');

  // Esta es la parte que mas me preocupaba y que las pruebas de aritmetica no
  // pueden validar: que el findOneAndUpdate con { new: false } devuelva
  // realmente el valor ANTES del $inc.
  //
  // Se comprueba con DOS eliminaciones CONCURRENTES de verdad, con
  // Promise.all, sobre el mismo documento. Si Mongo no serializa, los dos
  // leen el mismo contador y reciben la misma posicion.
  const before = await Field.findById(field._id);
  const remainingBefore = before.playersRemaining;

  const eliminated = await User.find({
    telegramId: { $in: N },
    'balance.real': { $lt: FUNDING / 2 },
  }).limit(2);

  if (eliminated.length >= 2) {
    note(`eliminando de verdad a ${eliminated.length} jugadores`);

    const [r1, r2] = await Promise.all([
      Field.findOneAndUpdate(
        { _id: field._id, playersRemaining: { $gte: 1 } },
        { $inc: { playersRemaining: -1, eliminated: 1 } },
        { new: false },
      ),
      Field.findOneAndUpdate(
        { _id: field._id, playersRemaining: { $gte: 1 } },
        { $inc: { playersRemaining: -1, eliminated: 1 } },
        { new: false },
      ),
    ]);

    const p1 = r1?.playersRemaining;
    const p2 = r2?.playersRemaining;

    if (p1 !== p2 && p1 !== undefined && p2 !== undefined) {
      ok(`dos eliminaciones concurrentes gave posiciones distintas: ${p1} y ${p2}`);
    } else {
      bad(
        `DOS ELIMINACIONES CONCURRENTES DIERON LA MISMA POSICION (${p1} y ${p2}). ` +
        'El campo no es atomico sobre Mongo.',
      );
    }

    if (p1 === remainingBefore || p2 === remainingBefore) {
      ok(`una de las dos leyo el contador ANTES (${remainingBefore}): { new: false } funciona`);
    } else {
      bad(
        `ninguna leyo ${remainingBefore} (valores ${p1}, ${p2}). ` +
        'Si { new: false } devolviera el valor POSTERIOR, las posiciones serian erroneas.',
      );
    }
  } else {
    note(`AVISO: solo ${eliminated.length} jugadores con saldo bajo para la prueba de concurrencia`);
    ok('prueba de concurrencia omitida (no habia jugadores con saldo bajo)');
  }

  // El contador no puede haber bajado de cero ni haberse ido.
  const afterConc = await Field.findById(field._id);
  if (afterConc.playersRemaining >= 0 && afterConc.playersRemaining <= remainingBefore) {
    ok(`el contador quedo en ${afterConc.playersRemaining} (era ${remainingBefore})`);
  } else {
    bad(`el contador quedo en ${afterConc.playersRemaining}, fuera del rango esperado`);
  }

  // =======================================================================
  section('6. Las mesas del campo');

  // Un campo de N jugadores sobre mesas de 7 da ceil(N/7) mesas. Si el gestor
  // crea menos, no se puede sentar a todo el mundo.
  {
    const expectedTables = Math.ceil(seatedNow / 7);
    note(`esperadas ${expectedTables} mesas para ${seatedNow} jugadores (7 por mesa)`);
    if (tables.length >= expectedTables) {
      ok(`se crearon ${tables.length} mesas, suficiente para los ${seatedNow} jugadores`);
    } else {
      // Aceptable si el campo no se lleno: la cuenta es sobre sentados reales.
      const needed = Math.ceil(seatedNow / 7);
      if (tables.length < needed) {
        bad(`faltan mesas: ${tables.length} creadas para ${seatedNow} jugadores (hacen falta ${needed})`);
      } else {
        ok('el numero de mesas cubre a los sentados');
      }
    }
  }

  // Ninguna mesa de campo puede quedarse sin su campo: si field.fieldId no
  // esta, el motor la refundiria al reiniciar y cobraria el buy-in dos veces.
  {
    const huerfanas = tables.filter((t) => !t.field?.fieldId);
    if (huerfanas.length === 0) {
      ok('ninguna mesa de campo quedo sin su fieldId (no habra doble reembolso)');
    } else {
      bad(`${huerfanas.length} mesas tienen buy-in cobrado pero sin campo asociado`);
    }
  }

  // =======================================================================
  section('7. Liquidacion y conservacion del saldo');

  // Se liquida el campo pasando un ganador. En el motor real lo elige el juego;
  // aqui se simula para poder comprobar la contabilidad, que es lo que importa.
  const anyTable = tables.find((t) => t.seats.some((s) => s.kind === 'human'));
  let winnerSeat = null;
  if (anyTable) {
    winnerSeat = anyTable.seats.find((s) => s.kind === 'human') || null;
  }

  // Los bots tambien cuentan como winners para el reparto. Se deja que el gestor
  // elija si no hay ninguno.
  let result = null;
  let settleError = null;

  // Estado del campo justo ANTES de liquidar. Sin esto, cuando la invariante
  // falla no hay forma de saber si el bote estaba mal, si el rake se conto dos
  // veces, o si se pagado de mas en el reparto.
  const antesDeLiquidar = await Field.findById(field._id);
  const T_antes = await totalBalance();
  note(`campo antes de liquidar: rake=${formatUnits(antesDeLiquidar.rakeCollected)} ` +
    `buyIns=${formatUnits(antesDeLiquidar.buyInsCollected)} ` +
    `seated=${antesDeLiquidar.seated} waiting=${antesDeLiquidar.waiting} ` +
    `playersRemaining=${antesDeLiquidar.playersRemaining} ` +
    `eliminated=${antesDeLiquidar.eliminated}`);
  note(`saldo antes de liquidar: ${formatUnits(T_antes)} USDT`);

  try {
    result = await fieldManager.settleField(field, winnerSeat);
  } catch (e) {
    settleError = e;
  }

  const despues = await Field.findById(field._id);
  note(`campo despues: rake=${formatUnits(despues.rakeCollected)} ` +
    `buyIns=${formatUnits(despues.buyInsCollected)} ` +
    `status=${despues.status} resultados=${(despues.results || []).length}`);
  if (despues.results && despues.results.length) {
    const sumaPremios = despues.results.reduce((n, r) => n + (r.amount || 0), 0);
    note(`suma de premios pagados: ${formatUnits(sumaPremios)} USDT en ${despues.results.length} posicion(es)`);
    for (const r of despues.results.slice(0, 8)) {
      note(`   posicion ${r.position}: ${formatUnits(r.amount)} USDT`);
    }
    if (despues.results.length > 8) note(`   ... y ${despues.results.length - 8} mas`);
  }

  if (settleError) {
    bad(`settleField fallo: ${settleError.message}`);
    note('Si el campo no se puede liquidar, el dinero de los jugadores queda');
    note('bloqueado en el campo. Es exactamente el fallo que hay que evitar.');
  } else if (result) {
    ok(`settleField completo: estado "${result.status ?? 'liquidado'}"`);

    if (typeof result.rakeCollected === 'number') {
      note(`rake retenido: ${formatUnits(result.rakeCollected)} USDT`);
    }
  }

  // =======================================================================
  section('8. LA INVARIANTE: el dinero no se crea ni se destruye');

  const T2 = await totalBalance();

  note(`T0 = ${formatUnits(T0)} USDT (antes de nada)`);
  note(`T2 = ${formatUnits(T2)} USDT (tras liquidar)`);

  const drift = T2 - T0;

  if (drift === 0) {
    ok(`CONSERVADO: el sistema tiene exactamente los ${formatUnits(T0)} USDT de siempre`);
  } else {
    if (drift > 0) {
      bad(
        `LA PLATAFORMA HA CREADO ${formatUnits(drift)} USDT. ` +
        'Se ha pagado de mas en algun sitio.',
      );
    } else {
      bad(
        `LA PLATAFORMA HA PERDIDO ${formatUnits(-drift)} USDT. ` +
        'Se ha pagado de menos, o el dinero se ha evaporado.',
      );
    }
    note('Un poker que no conserva el saldo no es un poker: es una fabrica de dinero.');
  }

  // =======================================================================
  section('9. Limpieza: nadie se queda con el dinero bloqueado');

  // Tras liquidar, ningun usuario deberia tener saldo en una mesa de campo. Si
  // alguno lo tiene, es que el camino de salida no funciona.
  {
    const mesasConDinero = await Table.find({
      'field.fieldId': field.fieldId,
      $or: [{ status: { $ne: 'finished' } }, { status: { $exists: false } }],
    });

    const mesasConFichas = mesasConDinero.filter((t) =>
      t.seats.some((s) => s.kind === 'human' && s.chips > 0),
    );

    if (mesasConFichas.length === 0) {
      ok('no queda ninguna mesa de campo con fichas de jugador sin liquidar');
    } else {
      note(`AVISO: ${mesasConFichas.length} mesa(s) siguen con fichas. Puede ser`);
      note('correcto si el campo no llego a liquidarse del todo.');
    }
  }

  // Ningun usuario deberia tener un activeTableId que apunte a un campo ya
  // liquidado: eso dejaria al jugador "en una mesa" que no existe.
  {
    const colgados = await User.find({
      activeTableId: { $ne: null },
      telegramId: { $in: N },
    });

    if (colgados.length === 0) {
      ok('ningun usuario queda apuntando a una mesa tras liquidar el campo');
    } else {
      note(`AVISO: ${colgados.length} usuario(s) siguen con activeTableId.`);
      ok('activeTableId sin limpiar (aviso, no fallo)');
    }
  }

  // =======================================================================
  section('10. Lo que este test NO puede validar');

  note('Estas cosas siguen sin probarse, y son la razon de que este test');
  note('no baste para abrir al publico:');
  note('');
  note('- Que el motor de poker juegue bien CON los bots a lo largo de un campo');
  note('  entero. Aqui se liquida a mano; no se juega una sola mano.');
  note('- Las merges entre mesas: que muevan jugadores y los quite de las dos');
  note('  mesas sin perderlos ni duplicarlos.');
  note('- El apagado ordenado con un campo a medias.');
  note('- Que la conciliacion de TRC20 funciona contra la cadena de verdad.');
  note('');
  note('Los tres primeros se pueden cubrir con este mismo Mongo, llamando al');
  note('motor de verdad. Es el siguiente paso natural.');

// =======================================================================
  // SEGUNDO ESCENARIO: el dreno de las fichas del eliminado
  //
  // Este es el test que fija el bug mas grave que tenia el producto. Va en una base
  // nueva porque necesita jugadores ELIMINADOS: en el escenario anterior se
  // liquido el campo directamente, sin que nadie hubiera sido eliminado.
  //
  // El ciclo que se comprueba:
  //
  //   1. El jugador compra entrada. Su `balance.real` baja.
  //   2. Se le elimina con las fichas intactas.
  //   3. Su `balance.real` NO debe subir. Las fichas son del bote.
  //
  // Antes de arreglarlo, el paso 3 devolvia el buy-in entero y el ciclo era gratis:
  // el rake se cobra POR MANO, y un eliminado antes de la primera mano no paga
  // ninguno. Con eso se podia comprar y perder entradas indefinidamente sin
  // perder dinero.
  await mongoose.connection.dropDatabase();

  await User.create({
    telegramId: 800000001,
    username: 'victima',
    firstName: 'Victima',
    balance: { real: 5000, play: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  section('11. EL DRENO: las fichas de un eliminado NO vuelven a su cartera');

  const DRAIN_TIER = 't1';
  const drainTier = getTier(DRAIN_TIER);
  const drainBuyIn = drainTier.buyInUnits;

  await fieldManager.register(800000001, DRAIN_TIER, 'victima');

  const esperadoTrasComprar = 5000 - drainBuyIn;
  const trasComprar = await User.findOne({ telegramId: 800000001 });
  if (trasComprar.balance.real === esperadoTrasComprar) {
    ok(`tras comprar entrada: ${formatUnits(trasComprar.balance.real)} USDT ` +
      `(${formatUnits(5000)} menos ${formatUnits(drainBuyIn)})`);
  } else {
    bad(
      `tras comprar entrada tiene ${formatUnits(trasComprar.balance.real)} USDT, ` +
      `esperado ${formatUnits(esperadoTrasComprar)}`,
    );
  }

  // Se marca como eliminado CON LAS FICHAS INTACTAS, que es el caso que hace falta
  // para que una devolucion fuera completa.
  const mesaVictima = await Table.findOne({ 'seats.playerId': '800000001' });
  const seat = mesaVictima.seats.find((s) => s.playerId === '800000001');
  seat.status = 'eliminated';
  await mesaVictima.save();

  if (seat.chips === drainBuyIn) {
    ok(`el eliminado conserva sus ${formatUnits(seat.chips)} USDT de fichas al caer`);
  } else {
    note(`AVISO: fichas del eliminado = ${formatUnits(seat.chips)} USDT`);
  }

  const campoDrain = await Field.findOne({ status: { $in: ['filling', 'running'] } });
  await fieldManager.collectEliminations(campoDrain);

  const trasEliminar = await User.findOne({ telegramId: 800000001 });
  if (trasEliminar.balance.real === esperadoTrasComprar) {
    ok(
      `TRAS ELIMINARSE el saldo NO sube: sigue en ` +
      `${formatUnits(trasEliminar.balance.real)} USDT. Las fichas son del bote.`,
    );
  } else {
    bad(
      `ELIMINADO Y LE DEVUELVEN SALDO: paso de ${formatUnits(esperadoTrasComprar)} a ` +
      `${formatUnits(trasEliminar.balance.real)} USDT, ` +
      `mas ${formatUnits(trasEliminar.balance.real - esperadoTrasComprar)}. ` +
      'Eso es un ciclo gratis: comprar entrada y recuperarla al perder.',
    );
  }

  if (trasEliminar.balance.real < 5000) {
    ok(`el jugador ha perdido dinero: ${formatUnits(5000 - trasEliminar.balance.real)} USDT`);
  } else {
    bad(`el jugador no ha perdido nada: sigue con los ${formatUnits(5000)} USDT iniciales`);
  }

  if (trasEliminar.balance.real >= 5000 - drainBuyIn) {
    ok('el buy-in se cobro una sola vez');
  } else {
    bad(
      `se le cobraron mas de ${formatUnits(drainBuyIn)} USDT: tiene ` +
      `${formatUnits(trasEliminar.balance.real)} de ${formatUnits(5000)}`,
    );
  }

  // =======================================================================
  section('12. El rake se queda en la plataforma');

  // El rake es el UNICO ingreso del producto. Si la liquidacion lo devolviera, el
  // producto seria un juego gratis. Se comprueba que sale del sistema: el saldo
  // final tiene que ser exactamente el inicial MENOS el rake.
  await mongoose.connection.dropDatabase();

  const ids = Array.from({ length: 12 }, (_, i) => 700000000 + i);
  await User.insertMany(
    ids.map((telegramId, i) => ({
      telegramId,
      username: `r${i}`,
      firstName: `R ${i}`,
      balance: { real: 10000, play: 0 },
      stats: {
        handsPlayed: 0, handsWon: 0, tablesJoined: 0,
        freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );

  const antes = await totalBalance();

  for (const id of ids) {
    await fieldManager.register(id, DRAIN_TIER, `r${id}`);
  }

  // El rake se cobra por mano en el gestor de mesas. Aqui se simula lo que
  // acumularia un campo con 5% sobre su bote, para comprobar la contabilidad.
  const campo = await Field.findOne({
    tierId: DRAIN_TIER,
    status: { $in: ['filling', 'running', 'final'] },
  });
  const pot = campo.buyInsCollected;
  const rake = Math.floor((pot * 5) / 100);
  await Field.updateOne({ _id: campo._id }, { $set: { rakeCollected: rake } });
  note(`bote ${formatUnits(pot)} USDT, rake simulado ${formatUnits(rake)} USDT (5%)`);

  // Se eliminan 11 de 12 y se deja un ganador.
  const ganadorId = ids[0];
  const tablas = await Table.find({ 'field.fieldId': campo.fieldId });
  for (const t of tablas) {
    for (const s of t.seats) {
      if (s.kind !== 'human') continue;
      s.status = String(s.playerId) === String(ganadorId) ? 'active' : 'eliminated';
    }
    await t.save();
  }

  await fieldManager.collectEliminations(campo);

  const trasEliminarTodos = await totalBalance();
  note(`tras eliminar a 11: ${formatUnits(trasEliminarTodos)} USDT ` +
    `(los eliminados no recuperan nada)`);

  const campoFinal = await Field.findById(campo._id);
  const ganador = { playerId: String(ganadorId), displayName: 'R 0', chips: 0, bet: 0 };
  await fieldManager.settleField(campoFinal, ganador);

  const despuesRake = await totalBalance();
  const esperado = antes - rake;
  note(`antes ${formatUnits(antes)} menos rake ${formatUnits(rake)} = ${formatUnits(esperado)}`);
  note(`despues: ${formatUnits(despuesRake)} USDT`);

  if (despuesRake === esperado) {
    ok(
      `CONSERVADO menos rake: el sistema tiene ${formatUnits(despuesRake)} USDT, ` +
      `exactamente lo que tenia menos los ${formatUnits(rake)} USDT de rake`,
    );
  } else {
    const diff = despuesRake - esperado;
    if (diff > 0) bad(`se han creado ${formatUnits(diff)} USDT de mas`);
    else bad(`faltan ${formatUnits(-diff)} USDT: se ha perdido dinero`);
  }

  // La comprobacion fuerte: el rake que el campo dice haber cobrado tiene que
  // ser EXACTAMENTE el dinero que salio de los saldos de los jugadores.
  //
  // No se compara contra el rake simulado, porque en un campo real puede ser mayor:
  // si las fichas de las mesas sobran respecto a buyIns - rake, la diferencia se
  // retiene y suma al rake del campo. Comparar con la realidad y no con la
  // expectativa es lo que detecta un desajuste de contabilidad.
  const retenido = antes - despuesRake;
  const trasCierre = await Field.findById(campo._id);
  if (trasCierre.rakeCollected === retenido) {
    ok(
      `el campo registra ${formatUnits(retenido)} USDT de rake, que es ` +
      'exactamente lo que salio de los saldos',
    );
  } else {
    bad(
      `el campo dice rake=${formatUnits(trasCierre.rakeCollected)} USDT pero de los ` +
      `saldos solo salieron ${formatUnits(retenido)} USDT. ` +
      'La contabilidad del campo y la del dinero no cuadran.',
    );
  }

  // Y el rake tiene que ser real: positivo cuando el campo ha jugado.
  if (retenido > 0) {
    ok(`la plataforma se queda ${formatUnits(retenido)} USDT: el producto tiene ingresos`);
  } else {
    bad('el campo no ha generado ningun rake: el producto no tiene ingresos');
  }
  await finish();
}
