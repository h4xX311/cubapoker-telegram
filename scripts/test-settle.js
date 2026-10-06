/**
 * Test de la liquidacion del campo (`settleField`), sin jugar el campo entero.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTE TEST EXISTE
 *
 * `test-e2e-engine.js` juega un campo completo y al final detecta que la
 * contabilidad no cuadra. Eso dice QUE falla, no POR QUE, y cuesta veinte minutos
 * por intento. Aqui se monta a mano un campo con las cifras exactas de un caso
 * concreto y se liquida, en segundos. Cuando la liquidacion este bien, este test
 * pasa; cuando el campo real falle, este test dice por que.
 *
 * ------------------------------------------------------------------
 * EL CASO QUE REPRODUCE
 *
 * Tres jugadores de buy-in 1 000. El campo ha juntado 3 000 unidades, repartidas
 * asi por el sistema:
 *
 *   asiento del ganador      1 600
 *   asiento del eliminado        0   (sus fichas se fueron a `deadChips`)
 *   `deadChips`                 900   (el eliminado las sacado de la mesa)
 *   bote de una mano en curso    500   (nadie ha llegado al showdown)
 *   ----------------------------------
 *   total                       3 000   = lo que entrar, ni una unidad menos
 *
 * ------------------------------------------------------------------
 * LOS TRES FALLOS QUE ESTE TEST ATRAPA
 *
 * 1. `hand.pot` NO SE BARRE.
 *    El barrido suma `seat.chips` y `seat.bet`, pero el bote de la mano que esta
 *    en curso no. Esas 500 unidades no se pagan y no se ponen a cero: desaparecen.
 *
 * 2. EL DESAJUSTE SE REBAUTIZA COMO RAKE.
 *    Con el fallo 1, lo barrido son 2 500 y el neto que la plataforma debe
 *    repartir son 2 850. El codigo hace `rake = buyInsCollected - repartido`, y
 *    eso da un rake de 500 en vez de 150: un 16,7 % en vez del 5 % documentado.
 *    Lo que pasa es que la plataforma se esta apuntando como ingreso el dinero que
 *    ha perdido por el fallo 1. Convertir una fuga en ingresos es lo peor que
 *    puede hacer la contabilidad: esconde el bug y encima parece un buen mes.
 *
 * 3. `deadChips` NO SE PONE A CERO.
 *    Se suma a lo barrido, se paga a los jugadores... y el documento del campo
 *    sigue diciendo que tiene 900 fichas dentro. Todo lo que lea el campo despues
 *    las cuenta otra vez. El campo queda diciendo que debe dinero que ya entrego.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_settle node scripts/test-settle.js
 */

process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_settle';

// El bot arranca polling de Telegram al importarse, asi que esto va ANTES de cargar
// nada del proyecto.
process.env.DEV_AUTH_BYPASS = 'false';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.ADMIN_API_KEY = 'clave-de-prueba-settle';
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

// --------------------------------------------------------------------------
// Las cifras del caso. Estan aqui arriba, en constantes, porque el resto del test
// se deduce de ellas: si se cambian, el caso sigue siendo coherente.
// --------------------------------------------------------------------------
const BUY_IN = 1000;
const JUGADORES = 3;
const BUY_INS_COLLECTED = BUY_IN * JUGADORES;   // 3 000
const CHIPS_GANADOR = 1600;
const DEAD_CHIPS = 900;
const POT_EN_CURSO = 500;
// 1 600 + 900 + 500 = 3 000. Las tres fichas juntas son lo que entro.

const RAKE_ESPERADO = Math.floor((BUY_INS_COLLECTED * 5) / 100);   // 150

const IDS = [700_000_000, 700_000_001, 700_000_002];

async function main() {
  console.log('\n\x1b[1mCubaPoker · Liquidacion del campo\x1b[0m');
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
  const { PAID_POSITIONS } = require('../dist/config/product');

  // ------------------------------------------------------------------
  section('1. Un campo con las cifras del caso');

  // Cada jugador entra con lo justo para pagar su buy-in y algo mas, para que se
  // vea que el premio sale del bote y no de un saldo que ya era suyo.
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

  const FIELD_ID = 'settle-t1';

  const campo = await Field.create({
    fieldId: FIELD_ID,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    buyInUnits: BUY_IN,
    targetField: JUGADORES,
    waiting: 0,
    seated: JUGADORES,
    eliminated: 2,
    playersRemaining: 1,
    paidPositionsLeft: PAID_POSITIONS,
    rakeCollected: 0,
    deadChips: DEAD_CHIPS,
    buyInsCollected: BUY_INS_COLLECTED,
    tables: [],
    plannedTables: 1,
    startedAt: new Date(),
  });

  // La mesa: un asiento con el ganador y uno vacio (el eliminado), mas un bote de
  // mano a medio jugar. Esta es la parte que importa: el bote en curso es justo lo
  // que el barrido no miraba.
  const mesa = await Table.create({
    tableId: `${FIELD_ID}-t1`,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: BUY_IN,
    maxSeats: 7,
    field: {
      fieldId: FIELD_ID,
      tableNumber: 1,
      targetField: JUGADORES,
      seated: JUGADORES,
      paidPositions: 0,
      fieldStatus: 'running',
    },
    hand: {
      handNumber: 7,
      phase: 'flop',
      communityCards: ['As', 'Kd', '7c'],
      pot: POT_EN_CURSO,
      currentBet: 10,
      actingSeat: -1,
      dealerSeat: 0,
      startedAt: new Date(),
    },
    stats: { handsPlayed: 7, rakeCollected: 0, prizePaid: 0 },
    seats: [
      {
        index: 0,
        kind: 'human',
        playerId: String(IDS[0]),
        displayName: 'Jugador 0',
        chips: CHIPS_GANADOR,
        bet: 0,
        totalBet: BUY_IN,
        status: 'active',
        isDealer: true,
        joinedAt: new Date(),
      },
      {
        index: 1,
        kind: 'human',
        playerId: String(IDS[1]),
        displayName: 'Jugador 1',
        chips: 0,
        bet: 0,
        totalBet: BUY_IN,
        status: 'out',
        joinedAt: new Date(),
      },
    ],
  });

  ok(`campo creado: ${BUY_INS_COLLECTED} unidades recogidas, ${DEAD_CHIPS} de eliminados`);
  ok(`mesa creada: ganador con ${CHIPS_GANADOR}, mano en curso con ${POT_EN_CURSO} en el bote`);

  // ------------------------------------------------------------------
  section('2. Lo que hay en el campo antes de liquidar');

  /**
   * Todo el dinero del campo, donde este ESTE. Es la unica pregunta que importa:
   * si la suma no es la que entro, ya hay una fuga antes de empezar a pagar.
   */
  const dineroEnElCampo = async () => {
    const tablas = await Table.find({ 'field.fieldId': FIELD_ID });
    let enMesas = 0;
    for (const t of tablas) {
      for (const s of t.seats) enMesas += Math.max(0, s.chips) + Math.max(0, s.bet);
      enMesas += Math.max(0, t.hand.pot || 0);
    }
    const doc = await Field.findOne({ fieldId: FIELD_ID });
    return enMesas + Math.max(0, doc.deadChips || 0);
  };

  const saldosTotales = async () => {
    const agg = await User.aggregate([
      { $group: { _id: null, total: { $sum: { $add: ['$balance.real', '$balance.play'] } } } },
    ]);
    return agg[0]?.total ?? 0;
  };

  const antes = await dineroEnElCampo();
  note(`dinero en el campo: ${antes}`);
  note(`  asiento ganador ${CHIPS_GANADOR} + deadChips ${DEAD_CHIPS} + bote en curso ${POT_EN_CURSO}`);

  if (antes === BUY_INS_COLLECTED) ok(`el campo tiene exactamente lo que entro: ${antes}`);
  else bad(`el campo tiene ${antes}, pero entraron ${BUY_INS_COLLECTED}`);

  const saldosAntes = await saldosTotales();
  note(`saldos de los jugadores antes: ${saldosAntes}`);

  // ------------------------------------------------------------------
  section('3. Liquidar');

  const ganador = mesa.seats.find((s) => s.index === 0);
  const resultado = await fieldManager.settleField(campo, ganador);

  const repartido = resultado.totalPaid;
  const reembolsado = resultado.refunded;
  note(`repartido ${repartido}, reembolsado ${reembolsado}`);
  note(`rake esperado: ${RAKE_ESPERADO} (5 % de ${BUY_INS_COLLECTED})`);

  // ------------------------------------------------------------------
  section('4. Lo que exigimos');

  // --- 4.1: el rake es el 5 %, ni una unidad mas --------------------------
  const campoDespues = await Field.findOne({ fieldId: FIELD_ID });
  const rakeRegistrado = campoDespues.rakeCollected;

  if (rakeRegistrado === RAKE_ESPERADO) {
    ok(`el rake es el 5 % del bote: ${rakeRegistrado}`);
  } else if (rakeRegistrado > RAKE_ESPERADO) {
    bad(
      `EL RAKE ES ${rakeRegistrado}, Y EL 5 % SON ${RAKE_ESPERADO}`,
      `Se esta apuntando como ingreso ${rakeRegistrado - RAKE_ESPERADO} unidades que no son ` +
      'de la plataforma. Eso solo pasa cuando lo barrido no cuadra: el codigo usa ' +
      '`rake = bote - repartido`, y con fichas perdidas en el camino la fuga se ' +
      'convierte en ganancia.',
    );
  } else {
    bad(`el rake es ${rakeRegistrado}, esperado ${RAKE_ESPERADO}: la plataforma regala parte`);
  }

  // --- 4.2: no queda ni una ficha dentro del campo -----------------------
  const despues = await dineroEnElCampo();

  if (despues === 0) {
    ok('el campo queda vacio: ni fichas en asientos, ni bote, ni deadChips');
  } else {
    const donde = [];
    const tablas = await Table.find({ 'field.fieldId': FIELD_ID });
    for (const t of tablas) {
      for (const s of t.seats) {
        if (s.chips > 0 || s.bet > 0) donde.push(`mesa ${t.tableId} asiento ${s.index}`);
      }
      if ((t.hand.pot || 0) > 0) donde.push(`mesa ${t.tableId} bote en curso`);
    }
    if ((campoDespues.deadChips || 0) > 0) donde.push(`deadChips ${campoDespues.deadChips}`);
    bad(`QUEDAN ${despues} UNIDADES DENTRO DEL CAMPO`, donde.join(', '));
  }

  // --- 4.3: el bote de una mano en curso se paga -------------------------
  // Por separado del punto anterior, porque es el fallo concreto: el barrido mira
  // los asientos y se olvida de `hand.pot`.
  const mesasDespues = await Table.find({ 'field.fieldId': FIELD_ID });
  const potVivo = mesasDespues.reduce((s, t) => s + Math.max(0, t.hand.pot || 0), 0);
  if (potVivo === 0) ok('el bote de la mano en curso se ha liquidado con el resto');
  else bad(`quedan ${potVivo} unidades en un bote sin acabar, y no se han pagado`);

  // --- 4.4: `deadChips` a cero -------------------------------------------
  const dead = campoDespues.deadChips || 0;
  if (dead === 0) ok('`deadChips` vuelve a 0: el campo ya no dice que debe lo que entrego');
  else bad(`\`deadChips\` sigue en ${dead} despues de pagarlo`, 'Se paga a los jugadores y ademas queda escrito en el campo. Todo lo que lea el campo despues lo cuenta dos veces.');

  // --- 4.5: el dinero no se crea ni se destruye --------------------------
  //
  // OJO CON COMO SE CUENTA EL RAKE, porque en una primera version de esta prueba se
  // conto dos veces y dio un fallo falso:
  //
  // El rake NO se descuenta de ninguna cartera. Nobody pierde 150 de su saldo en el
  // momento de liquidar. Lo que pasa es que esas 150 fichas estaban en la mesa y NO
  // se repartieron: el barrido las puso a cero y se quedaron en la plataforma. El
  // rake es, literalmente, dinero que estaba en el campo y no salio de el.
  //
  // Por eso los saldos de los jugadores suben exactamente por lo repartido, y el
  // efecto del rake se ve en las fichas del campo, no en las carteras.
  const saldosDespues = await saldosTotales();

  const esperado = saldosAntes + repartido + reembolsado;

  if (saldosDespues === esperado) {
    ok(
      `los saldos suben solo por lo repartido: +${repartido} de premio. ` +
      `El rake (${rakeRegistrado}) no sale de ninguna cartera: son fichas que no se ` +
      'repartieron.',
    );
  } else {
    bad(
      `LOS SALDOS NO CUADRAN: hay ${saldosDespues} y deberia haber ${esperado}`,
      `Diferencia de ${saldosDespues - esperado}. Repartido ${repartido}, ` +
      `rake ${rakeRegistrado}, reembolsado ${reembolsado}.`,
    );
  }

  // Y el rake tiene que ser exactamente lo que se ha quedado la plataforma: lo que
  // entro menos lo que salio. Es la comprobacion de que el 5 % no es un numero de
  // adorno.
  const retenido = BUY_INS_COLLECTED - repartido - reembolsado;
  if (retenido === rakeRegistrado) {
    ok(`lo retenido son ${retenido}, y el campo registra rake ${rakeRegistrado}: la misma cifra`);
  } else {
    bad(
      `el campo registra un rake de ${rakeRegistrado} pero de verdad se han retenido ${retenido}`,
      'Si estas dos cifras no coinciden, el panel de operador esta mintiendo.',
    );
  }

  // --- 4.6: el campo queda cerrado y no se liquida dos veces -------------
  if (campoDespues.status === 'finished') ok('el campo queda en `finished`');
  else bad(`el campo quedo en "${campoDespues.status}", deberia ser "finished"`);

  const otra = await fieldManager.settleField(campo, ganador);
  if (otra.totalPaid === 0) ok('una segunda liquidacion no paga nada');
  else bad(`una segunda liquidacion pago ${otra.totalPaid}: el campo paga dos veces`);

  const saldosTrasSegunda = await saldosTotales();
  if (saldosTrasSegunda === saldosDespues) ok('los saldos no cambian al liquidar por segunda vez');
  else bad(`los saldos cambiaron al repetir la liquidacion: ${saldosDespues} -> ${saldosTrasSegunda}`);

  // --- 4.7: el premio va a `balance.play`, no a `balance.real` -----------
  const ganadorDoc = await User.findOne({ telegramId: IDS[0] });
  const enReal = ganadorDoc.balance.real;
  const enPlay = ganadorDoc.balance.play;

  if (enPlay >= repartido && enReal === 5000) {
    ok(`el premio (${repartido}) esta en \`balance.play\`, y \`balance.real\` intacto (${enReal})`);
  } else {
    bad(
      `el premio no esta donde debe: real=${enReal} (esperado 5000), play=${enPlay} ` +
      `(esperado al menos ${repartido})`,
    );
  }

  // ------------------------------------------------------------------
  section('5. La cuenta que lo resume');

  console.log('');
  console.log(`  Entraron al campo ......... ${BUY_INS_COLLECTED}`);
  console.log(`  Repartido a jugadores ..... ${repartido}`);
  console.log(`  Rake de la plataforma ..... ${rakeRegistrado}  (el 5 % son ${RAKE_ESPERADO})`);
  console.log(`  Quedado en el campo ....... ${despues}`);
  console.log('');

  if (repartido + rakeRegistrado !== BUY_INS_COLLECTED) {
    bad(
      `el bote no cuadra: ${repartido} repartidos + ${rakeRegistrado} de rake son ` +
      `${repartido + rakeRegistrado}, y entraron ${BUY_INS_COLLECTED}. ` +
      `Faltan ${BUY_INS_COLLECTED - repartido - rakeRegistrado}.`,
    );
  } else {
    ok(`${repartido} + ${rakeRegistrado} = ${BUY_INS_COLLECTED}: el bote entero tiene dueño`);
  }

  // ------------------------------------------------------------------
  section('6. El caso contrario: fichas que NO estan');

  // Un campo donde se ha perdido dinero por el camino. Es el caso que mas dano ha
  // hecho: antes la diferencia se rebautizaba como rake y el mes salia bien.
  //
  // Aqui el bote dice 3 000, pero solo hay 2 400 en las mesas. Faltan 600.
  const FIELD2 = 'settle-t1-perdidas';

  await Field.create({
    fieldId: FIELD2,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    buyInUnits: BUY_IN,
    targetField: JUGADORES,
    waiting: 0,
    seated: JUGADORES,
    eliminated: 2,
    playersRemaining: 1,
    paidPositionsLeft: PAID_POSITIONS,
    rakeCollected: 0,
    deadChips: 0,
    buyInsCollected: BUY_INS_COLLECTED,
    tables: [],
    plannedTables: 1,
    startedAt: new Date(),
  });

  const mesa2 = await Table.create({
    tableId: `${FIELD2}-t1`,
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: BUY_IN,
    maxSeats: 7,
    field: {
      fieldId: FIELD2,
      tableNumber: 1,
      targetField: JUGADORES,
      seated: JUGADORES,
      paidPositions: 0,
      fieldStatus: 'running',
    },
    hand: { handNumber: 3, phase: 'idle', communityCards: [], pot: 0, currentBet: 0, actingSeat: -1 },
    stats: { handsPlayed: 3, rakeCollected: 0, prizePaid: 0 },
    seats: [{
      index: 0,
      kind: 'human',
      playerId: String(IDS[0]),
      displayName: 'Jugador 0',
      // 2 400 en vez de los 3 000 que entraron: 600 se han perdido.
      chips: 2400,
      bet: 0,
      totalBet: BUY_IN,
      status: 'active',
      joinedAt: new Date(),
    }],
  });

  const campo2 = await Field.findOne({ fieldId: FIELD2 });
  const ganador2 = mesa2.seats[0];

  note('el campo declara 3 000 recogidos pero solo tiene 2 400 en la mesa');
  const r2 = await fieldManager.settleField(campo2, ganador2);
  const campo2Despues = await Field.findOne({ fieldId: FIELD2 });

  // Lo que NO puede pasar: que la falta de 600 aparezca como ingreso.
  if (campo2Despues.rakeCollected === RAKE_ESPERADO) {
    ok(
      `el rake se queda en el 5 % real (${RAKE_ESPERADO}) aunque falten fichas`,
    );
  } else {
    bad(
      `EL RAKE ES ${campo2Despues.rakeCollected} Y DEBERIA SER ${RAKE_ESPERADO}`,
      `Se estan apuntando como ingresos ${campo2Despues.rakeCollected - RAKE_ESPERADO} ` +
      'unidades que se han perdido por el camino. Esto es lo que hacia que el rake ' +
      'saliera del 53 % en vez del 5 %.',
    );
  }

  // Y lo repartido no puede ser mas que lo que habia.
  if (r2.totalPaid <= 2400) {
    ok(`se reparten ${r2.totalPaid}, que no es mas de lo que habia en la mesa`);
  } else {
    bad(`se repartieron ${r2.totalPaid} con solo 2 400 en la mesa: se crea dinero`);
  }

  // Y el campo tiene que quedar acknowledging que no pudo pagar el bote entero.
  if (campo2Despues.rakeCollected + r2.totalPaid < BUY_INS_COLLECTED) {
    ok(
      `el campo acknowledges que no pudo pagar el bote entero: ` +
      `${campo2Despues.rakeCollected} de rake + ${r2.totalPaid} repartido = ` +
      `${campo2Despues.rakeCollected + r2.totalPaid}, de ${BUY_INS_COLLECTED} que entraron`,
    );
    note(
      'Antes esto se escondia: la diferencia se llamaba "rake" y el balance del mes ' +
      'salia bien. Ahora sale a la luz como lo que es: dinero perdido.',
    );
  } else {
    bad(
      `el campo pretende haber repartido todo el bote (${campo2Despues.rakeCollected} + ` +
      `${r2.totalPaid}) sin tener las fichas`,
    );
  }

  await finish();
}