/**
 * Se puede jugar una partida?
 *
 * ------------------------------------------------------------------
 * LA PREGUNTA
 *
 * Nadie ha podido jugar ni una mano. La interfaz no tiene ninguna via para ello: todo lo
 * que ofrece pasa por un campo, un freeroll o un centroll, y los tres arrancan cuando se
 * LLENAN. Con `fieldSize` a 300, eso significa 300 registros.
 *
 * Pero hay una cuarta via que SI existe y que la interfaz no usa: `POST /game/sit`, que
 * sienta al jugador en una mesa cash suelta. Ahi los bots rellenan los huecos mientras la
 * mesa este llenandose, y se puede jugar de inmediato.
 *
 * Este test comprueba esa via de punta a punta, con el codigo de produccion:
 *
 *   1. el usuario se sienta en una mesa
 *   2. los bots rellenan los asientos libres
 *   3. las manos avanzan de verdad
 *   4. los bots ACTUAN (no solo estan sentados)
 *   5. las fichas se mueven
 *
 * Si esto pasa, la logica de poker funciona y lo que falta es exponerla. Si falla, la
 * logica esta rota y hay que arreglarla antes de nada.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_play node scripts/test-play.js
 */

process.env.DEV_AUTH_BYPASS = 'true';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.ADMIN_API_KEY = 'clave-de-prueba';

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
  console.log('\n\x1b[1mCubaPoker · Se puede jugar una partida?\x1b[0m');

  section('0. Conexion');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  ok('base de datos vaciada');

  const { User } = require('../dist/models/User');
  const { Table } = require('../dist/models/Table');
  const { Field } = require('../dist/models/Field');
  const { seatingService } = require('../dist/game/seating.service');
  const { tableManager } = require('../dist/game/table.manager');
  const { decideAction } = require('../dist/game/bot.engine');
  const { formatUnits } = require('../dist/config/units');

  // Relojes a cero: aqui no hay nadie esperando, y queremos que el bot juegue ya.
  const { TURN_TIMER } = require('../dist/config/product');
  const { BOT_CONFIG } = require('../dist/config/product');
  const humanOriginal = TURN_TIMER.humanMs;
  const thinkOriginal = BOT_CONFIG.minThinkMs;
  TURN_TIMER.humanMs = 0;
  BOT_CONFIG.minThinkMs = 0;
  BOT_CONFIG.maxThinkMs = 0;

  // ------------------------------------------------------------------
  section('1. El usuario se sienta en una mesa cash');

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

  let sentado;
  try {
    sentado = await seatingService.sitDown({ telegramId: YOI, tierId: 't1' });
    ok(`sentado: mesa=${sentado.tableId}`);
  } catch (e) {
    bad(`no se pudo sentar: ${e.message}`);
    TURN_TIMER.humanMs = humanOriginal;
    BOT_CONFIG.minThinkMs = thinkOriginal;
    await finish();
    return;
  }

  const yo = await User.findOne({ telegramId: YOI });
  note(`saldo tras el buy-in: ${formatUnits(yo.balance.real)}`);

  const mesa = await Table.findOne({ tableId: sentado.tableId });
  if (!mesa) {
    bad(`la mesa ${sentado.tableId} no existe en la base de datos`);
    TURN_TIMER.humanMs = humanOriginal;
    BOT_CONFIG.minThinkMs = thinkOriginal;
    await finish();
    return;
  }

  const miAsiento = mesa.seats.find((s) => s.playerId === String(YOI));
  if (miAsiento && miAsiento.chips > 0) {
    ok(`estoy sentado con ${formatUnits(miAsiento.chips)} de stack`);
  } else {
    bad(`mi asiento esta mal: ${JSON.stringify(miAsiento)}`);
  }

  if (miAsiento && miAsiento.kind === 'human') {
    ok('mi asiento es `human`, no un bot disfrazado');
  } else {
    bad(`mi asiento es de tipo "${miAsiento?.kind}"`);
  }

  // ------------------------------------------------------------------
  section('2. Los bots rellenan');

  // El gestor los anade en su ciclo. Se le da un par de vueltas.
  for (let i = 0; i < 6; i++) {
    await tableManager.tick();
    await new Promise((r) => setTimeout(r, 0));
  }

  await Table.findOne({ tableId: sentado.tableId }).then((m) => Object.assign(mesa, m.seats ? { seats: m.seats } : {}));

  const trasBots = await Table.findOne({ tableId: sentado.tableId });
  const bots = trasBots.seats.filter((s) => s.kind === 'bot');
  const humanos = trasBots.seats.filter((s) => s.kind === 'human');

  note(`asientos: ${trasBots.seats.length}  bots=${bots.length}  humanos=${humanos.length}`);

  if (bots.length >= 2) ok(`hay ${bots.length} bots en la mesa`);
  else bad(`solo ${bots.length} bots: no se puede jugar con menos de 3`);

  if (humanos.length === 1) ok('sigue habiendo exactamente un humano: el mio');
  else bad(`hay ${humanos.length} humanos, deberia haber 1`);

  // ------------------------------------------------------------------
  section('3. Las manos avanzan de verdad');

  await tableManager.start();

  const manoInicial = trasBots.hand.handNumber;
  const fichasIniciales = trasBots.seats.reduce((s, x) => s + x.chips, 0);

  // Se dan vueltas al reloj hasta que el gestor juegue unas cuantas manos.
  for (let vuelta = 0; vuelta < 40; vuelta++) {
    await new Promise((r) => setTimeout(r, 0));
  }

  const trasJugar = await Table.findOne({ tableId: sentado.tableId });
  const fichasFinales = trasJugar.seats.reduce((s, x) => s + x.chips, 0);
  const boteFinal = Math.max(0, trasJugar.hand.pot || 0);

  note(`manos jugadas: ${trasJugar.hand.handNumber - manoInicial}`);
  note(`fichas en los asientos: ${fichasIniciales} -> ${fichasFinales}`);
  note(`bote en curso: ${formatUnits(boteFinal)}`);

  if (trasJugar.hand.handNumber > manoInicial) {
    ok(`se han jugado ${trasJugar.hand.handNumber - manoInicial} manos`);
  } else {
    bad('no se ha jugado NINGUNA mano: el gestor no avanza');
  }

  // ------------------------------------------------------------------
  section('4. Los bots ACTUAN, no solo estan sentados');

  // Que un bot tenga fichas no dice que juegue. Se mira si ha jugado: su contador de
  // manos, y su estilo en el historial.
  const botsConManos = trasJugar.seats.filter(
    (s) => s.kind === 'bot' && (s.handsPlayed || 0) > 0,
  );
  note(`bots con manos jugadas: ${botsConManos.length} de ${bots.length}`);

  if (botsConManos.length > 0) {
    ok(`${botsConManos.length} bots han jugado al menos una mano`);
  } else {
    bad('NINGUN bot ha jugado: estan sentados de adorno');
  }

  const conNet = trasJugar.seats.filter((s) => (s.netChips || 0) !== 0);
  if (conNet.length > 0) {
    ok(`las fichas se mueven: ${conNet.length} asientos con resultado distinto de cero`);
  } else {
    bad('las fichas no se mueven de un asiento a otro');
  }

  // ------------------------------------------------------------------
  section('5. La IA decide algo sensato');

  // Se le pregunta a la IA directamente con cartas de verdad, para no depender de que el
  // escenario haya salido de una manera u otra.
  const { createDeck } = require('../dist/game/card.utils');
  const mazo = createDeck();
  const { shuffleDeck } = require('../dist/game/card.utils');
  const barajado = shuffleDeck(mazo);

  const { botFactory } = require('../dist/game/bot.engine');
  const perfil = botFactory.create(1);

  const conBuenaMano = decideAction({
    hand: [
      { rank: 'A', suit: 's' },
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'd' },
    ],
    community: [
      { rank: 'K', suit: 's' },
      { rank: '2', suit: 'c' },
      { rank: '7', suit: 'h' },
    ],
    potSize: 100,
    toCall: 20,
    chips: 1000,
    profile: perfil,
    position: 2,
    playersLeft: 4,
  });

  const conMalaMano = decideAction({
    hand: [
      { rank: '7', suit: 's' },
      { rank: '3', suit: 'h' },
      { rank: '2', suit: 'd' },
    ],
    community: [
      { rank: 'K', suit: 's' },
      { rank: 'A', suit: 'c' },
      { rank: 'Q', suit: 'h' },
    ],
    potSize: 100,
    toCall: 20,
    chips: 1000,
    profile: perfil,
    position: 2,
    playersLeft: 4,
  });

  note(`con dos ases: ${conBuenaMano.action}`);
  note(`con 7-3-2:   ${conMalaMano.action}`);

  if (['raise', 'all_in', 'call'].includes(conBuenaMano.action)) {
    ok('con una mano fuerte no pliega');
  } else {
    bad(`con dos ases pliega: ${conBuenaMano.action}. La IA no sabe jugar.`);
  }

  // ------------------------------------------------------------------
  section('6. Limpieza');

  tableManager.stop();
  TURN_TIMER.humanMs = humanOriginal;
  BOT_CONFIG.minThinkMs = thinkOriginal;

  const finalUser = await User.findOne({ telegramId: YOI });
  if (finalUser.balance.real >= 0) {
    ok(`saldo real ${formatUnits(finalUser.balance.real)}, nunca negativo`);
  } else {
    bad(`saldo NEGATIVO: ${formatUnits(finalUser.balance.real)}`);
  }

  const campos = await Field.countDocuments({});
  if (campos === 0) ok('una mesa cash suelta no ha creado ningun campo');
  else bad(`se han creado ${campos} campos: shouldnaria haberse creado ninguno`);

  await finish();
}