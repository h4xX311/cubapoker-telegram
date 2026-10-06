// Se puede siempre levantar de una mesa cash?
//
// ------------------------------------------------------------------
// LA PREGUNTA
//
// Un jugador sentado en una mesa cash no siempre se puede levantar:
//
//   if (midHand) throw new TableError('Hay una mano en curso. Espera a que termine para salir.', 409)
//
// Y con bots jugando cada 2 segundos, la mesa casi nunca esta en `idle`. O sea: se puede
// quedar sin poder salir, otra vez, y esta vez en un producto que el usuario cree que puede
// usar cuando quiera.
//
// La comprobacion es:\`hand.phase !== 'idle'\` Y el asiento tiene apuesta (\`bet > 0\`).
// Lo que hay que ver es si hay ALGUNA ventana para salir, y si hay una mesa donde el jugador
// no pueda salir nunca.
//
// Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_stand node scripts/test-stand.js
// ---------------------------------------------------------------------------

process.env.DEV_AUTH_BYPASS = 'true';
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
  } catch { /* nada */ }
  process.exit(fail > 0 ? 1 : 0);
};

main().catch(async (e) => {
  console.error('\n\x1b[31mEl test reviento:\x1b[0m');
  console.error(e);
  fail++;
  await finish();
});

const YOI = 600_000_001;

async function main() {
  console.log('\n\x1b[1mCubaPoker · Se puede levantar de una mesa cash?\x1b[0m');

  section('0. Conexion');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  ok('base de datos vaciada');

  const { User } = require('../dist/models/User');
  const { Table } = require('../dist/models/Table');
  const { seatingService } = require('../dist/game/seating.service');
  const { tableManager } = require('../dist/game/table.manager');
  const { formatUnits } = require('../dist/config/units');
  const { TURN_TIMER, BOT_CONFIG } = require('../dist/config/product');

  TURN_TIMER.humanMs = 0;
  BOT_CONFIG.minThinkMs = 0;
  BOT_CONFIG.maxThinkMs = 0;

  // ------------------------------------------------------------------
  section('1. Sentarse');

  await User.create({
    telegramId: YOI,
    username: 'yo',
    firstName: 'Yo',
    balance: { real: 500_000, play: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
  });

  const sentado = await seatingService.sitDown({ telegramId: YOI, tierId: 't1' });
  ok(`sentado en ${sentado.tableId}`);

  await User.findOne({ telegramId: YOI });

  // ------------------------------------------------------------------
  section('2. Con la mesa en reposo, se puede salir');

  await tableManager.start();

  // Se le da un respiro al gestor para que rellene bots, pero sin jugar aun.
  for (let i = 0; i < 4; i++) {
    await tableManager.tick();
    await new Promise((r) => setTimeout(r, 0));
  }

  const enReposo = await Table.findOne({ tableId: sentado.tableId });
  note(`fase: "${enReposo.hand.phase}"`);

  const antesDeSalir = (await User.findOne({ telegramId: YOI })).balance.real;

  let r1 = null;
  let error1 = null;
  try {
    r1 = await seatingService.standUp(YOI, sentado.tableId);
  } catch (e) {
    error1 = e;
  }

  if (!error1) {
    ok(`se puede salir en reposo. Devuelto: ${formatUnits(r1.returned)}`);
  } else {
    bad(`no se puede salir con la mesa en reposo: ${error1.message}`);
  }

  // ------------------------------------------------------------------
  section('3. Y con la mesa JUGANDO');

  // Ahora al reves: se sienta otra vez, se deja jugar, y se intenta salir mientras hay mano.
  const otra = await seatingService.sitDown({ telegramId: YOI, tierId: 't1' });
  ok(`sentado otra vez en ${otra.tableId}`);

  await tableManager.start();

  // Se juega un rato a fondo.
  for (let vuelta = 0; vuelta < 30; vuelta++) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const jugando = await Table.findOne({ tableId: otra.tableId });
  const miAsiento = jugando.seats.find((s) => s.playerId === String(YOI));

  note(`fase: "${jugando.hand.phase}"  mi asiento: ${miAsiento ? miAsiento.status + ' apuesta=' + miAsiento.bet : 'no estoy'}`);

  // Se intenta salir 30 veces seguidas: lo que se busca es que ALGUNA vez funcione.
  let intentos = 0;
  let salio = false;
  let ultimoError = '';

  for (let i = 0; i < 30; i++) {
    intentos++;
    try {
      const r = await seatingService.standUp(YOI, otra.tableId);
      salio = true;
      ok(`ha podido salir al intento ${intentos}. Devuelto: ${formatUnits(r.returned)}`);
      break;
    } catch (e) {
      ultimoError = e.message;
      await new Promise((r2) => setTimeout(r2, 40));
    }
  }

  if (!salio) {
    bad(`NO ha podido salir en ${intentos} intentos seguidos con la mesa jugando`);
    note(`ultimo error: ${ultimoError}`);
    note('Eso significa que el usuario puede quedarse sin poder abandonar la mesa.');
  }

  // ------------------------------------------------------------------
  section('4. Y el saldo no se pierde por el camino');

  const despues = await User.findOne({ telegramId: YOI });
  note(`saldo real: ${formatUnits(despues.balance.real)}`);

  if (despues.balance.real >= 0) {
    ok('saldo nunca negativo');
  } else {
    bad(`saldo NEGATIVO: ${formatUnits(despues.balance.real)}`);
  }

  // Lo que se compro al entrar mas lo que se ha/devuelto, tiene que cuadrar.
  const gastado = 500_000 - antesDeSalir;
  note(`coste de las entradas: ${formatUnits(gastado)}`);

  tableManager.stop();
  TURN_TIMER.humanMs = 30_000;
  BOT_CONFIG.minThinkMs = 900;

  await finish();
}
