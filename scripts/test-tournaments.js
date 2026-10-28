/**
 * TORNEOS PAGADOS Y SPIN & GO
 * ===========================
 *
 * Comprueba el dinero y las reglas que separan un torneo de un freeroll:
 *
 *   1. El buy-in se cobra una vez y el premio garantizado queda anotado.
 *   2. Un torneo pagado NO se rellena con bots.
 *   3. Arranca a su hora con dos humanos como minimo.
 *   4. Si no se llena, se cancela y devuelve el buy-in.
 *   5. El registro tardio sienta con el stack completo.
 *   6. Un Spin & Go de 3 plazas arranca al llenarse y paga al ganador.
 *   7. La liquidacion paga la garantia y registra el overlay de la casa.
 *
 * Necesita Mongo. Ejecutar:
 *
 *   npm run build
 *   $env:MONGODB_URI='mongodb://127.0.0.1:37017/cubapoker_tournaments'
 *   node scripts/test-tournaments.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Field } = require('../dist/models/Field');
const { Table } = require('../dist/models/Table');
const { User } = require('../dist/models/User');
const { VIP } = require('../dist/models/VIP');
const {
  tournamentManager,
  proximoInicio,
  spinSeCompleta,
  SPIN_COMPLETAR_MS,
  SPIN_REEMBOLSO_MS,
} = require('../dist/game/tournament.service');
const { fieldManager } = require('../dist/game/field.manager');
const {
  TOURNAMENT_EVENTS,
  getTournamentEvent,
} = require('../dist/config/product');
const { usdtToUnits, formatUnits } = require('../dist/config/units');

let ok = 0;
let mal = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    ok++;
    console.log(`\x1b[32m  ok \x1b[0m ${nombre}`);
  } else {
    mal++;
    console.log(
      `\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' — ' + detalle : ''}`,
    );
  }
}

const SALDO = usdtToUnits(20);

const crearJugador = (id) =>
  User.create({
    telegramId: id,
    firstName: 'T' + String(id).slice(-4),
    balance: { real: SALDO, play: 0, realFromPrizes: 0 },
    stats: {
      handsPlayed: 0,
      handsWon: 0,
      tablesJoined: 0,
      freerollsPlayed: 0,
      totalRakePaid: 0,
      totalFreerollWon: 0,
    },
    activeTableId: null,
  });

const saldoDe = async (id) =>
  (await User.findOne({ telegramId: id }))?.balance?.real ?? 0;

const mesasDe = (fieldId) => Table.find({ 'field.fieldId': fieldId });

const humanosYBot = (mesa) => ({
  humanos: mesa.seats.filter((s) => s.kind === 'human').length,
  bots: mesa.seats.filter((s) => s.kind === 'bot').length,
});

const cerrarCampo = async (field, minutosTarde) => {
  field.scheduledStartAt = new Date(Date.now() - 60_000);
  field.lateRegUntil = new Date(Date.now() + minutosTarde * 60_000);
  await field.save();
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Esta base es exclusiva del test: se parte de cero para que los campos de
  // una pasada anterior no cambien el reparto ni las cuentas.
  await db.collection('fields').deleteMany({});
  await db.collection('tables').deleteMany({});
  // Una pasada anterior pudo dejar una membresía de prueba con descuento. Si no
  // se borra, el jugador paga menos y el test de cancelación deja de comprobar
  // el buy-in completo.
  await db.collection('vips').deleteMany({});
  const ids = Array.from({ length: 12 }, (_, i) => 740010001 + i);
  for (const id of ids) {
    await db.collection('users').deleteMany({ telegramId: id });
    await crearJugador(id);
  }

  const [A, B, C, D, E, F, G, H, I] = ids;

  // ==================================================================
  console.log('=== 1. El catalogo y el lobby ===\n');

  const micro = getTournamentEvent('daily-micro');
  const spingo = getTournamentEvent('spingo-1');
  // Se usa un Spin de 5 USDT porque su campo se abre nuevo y sigue en
  // inscripcion; asi el descuento se prueba sobre un buy-in de 5 sin depender
  // de la ocurrencia programada que el test ya cancelo.
  const premiumEvent = getTournamentEvent('spingo-5');
  comprobar('existe el torneo diario', !!micro);
  comprobar(
    'el buy-in del diario es 1 USDT y el garantizado 100',
    micro.buyInUsdt === 1 && micro.guaranteedPrizeUsdt === 100,
    `buyIn=${micro?.buyInUsdt}, premio=${micro?.guaranteedPrizeUsdt}`,
  );
  comprobar(
    'el reparto del diario suma 100',
    micro.payout.reduce((a, b) => a + b, 0) === 100,
    JSON.stringify(micro.payout),
  );
  comprobar(
    'el Spin & Go tiene 3 plazas y paga [100]',
    spingo.maxPlayers === 3 &&
      spingo.payout.length === 1 &&
      spingo.payout[0] === 100,
    JSON.stringify(spingo),
  );

  const lobby = await tournamentManager.estado(A);
  comprobar('el lobby devuelve torneos programados', lobby.torneos.length >= 3);
  comprobar('el lobby devuelve los tres Spin & Go', lobby.spin.length === 3);
  const spinLobby = lobby.spin.find((e) => e.id === 'spingo-1');
  comprobar(
    'el Spin de 1 USDT garantiza 2,85 y muestra 0/3',
    spinLobby?.premioGarantizadoUsdt === 2.85 &&
      spinLobby?.fieldSize === 3 &&
      spinLobby?.jugadores === 0,
    JSON.stringify(spinLobby),
  );

  const inicio = proximoInicio(micro, new Date());
  comprobar(
    'la proxima ocurrencia es futura y tiene slot estable',
    inicio.getTime() > Date.now(),
    inicio.toISOString(),
  );
  comprobar(
    'el slot es unico por evento y hora',
    `tournament-${require('../dist/config/product').tournamentSlotKey(
      micro.id,
      inicio,
    )}`.includes('daily-micro'),
  );

  // ==================================================================
  console.log('\n=== 2. Inscripcion pagada ===\n');

  const antesA = await saldoDe(A);
  const regA = await tournamentManager.registrar(A, 'daily-micro', 'Ana');
  const despuesA = await saldoDe(A);
  const campo = await Field.findOne({ fieldId: regA.fieldId });

  comprobar('la inscripcion devuelve un campo', !!campo);
  comprobar(
    'se cobra el buy-in una vez',
    antesA - despuesA === micro.buyInUnits,
    `${antesA} -> ${despuesA}`,
  );
  comprobar(
    'el campo es de tipo torneo',
    campo.kind === 'tournament',
    `kind=${campo.kind}`,
  );
  comprobar(
    'el bote de entradas es el buy-in cobrado',
    campo.buyInsCollected === micro.buyInUnits,
    `bote=${campo.buyInsCollected}`,
  );
  comprobar(
    'el premio garantizado se guarda en el campo',
    campo.prizePoolUnits === micro.guaranteedPrizeUnits,
    `garantia=${campo.prizePoolUnits}`,
  );
  comprobar(
    'el reparto se guarda con el campo',
    JSON.stringify(campo.payoutTable) === JSON.stringify([...micro.payout]),
    JSON.stringify(campo.payoutTable),
  );

  const mesasA = await mesasDe(regA.fieldId);
  const primeraMesa = mesasA[0];
  const conteoA = primeraMesa ? humanosYBot(primeraMesa) : null;
  comprobar('se creo una mesa de torneo', mesasA.length === 1, `${mesasA.length}`);
  comprobar(
    'la mesa es de puntos y tiene el stack del torneo',
    primeraMesa?.kind === 'tournament' &&
      primeraMesa?.startChips === micro.startingChips &&
      primeraMesa?.seats[0]?.chips === micro.startingChips,
    JSON.stringify({
      kind: primeraMesa?.kind,
      startChips: primeraMesa?.startChips,
      chips: primeraMesa?.seats[0]?.chips,
    }),
  );
  comprobar(
    'el primer inscrito esta solo y sin bots',
    conteoA?.humanos === 1 && conteoA?.bots === 0,
    JSON.stringify(conteoA),
  );

  let duplicado = false;
  try {
    await tournamentManager.registrar(A, 'daily-micro', 'Ana');
  } catch (error) {
    duplicado = true;
  }
  comprobar('no se puede pagar dos veces el mismo torneo', duplicado);
  comprobar(
    'el segundo intento no cobra',
    (await saldoDe(A)) === antesA - micro.buyInUnits,
  );

  // ==================================================================
  console.log('\n=== 3. Arranque a su hora con dos humanos ===\n');

  const regB = await tournamentManager.registrar(B, 'daily-micro', 'Beto');
  comprobar('el segundo humano entra en el mismo campo', regB.fieldId === regA.fieldId);
  const campo2 = await Field.findOne({ fieldId: regA.fieldId });
  await cerrarCampo(campo2, 10);

  const vuelta1 = await tournamentManager.procesar();
  const campo3 = await Field.findOne({ fieldId: regA.fieldId });
  comprobar(
    'el torneo arranca solo a su hora',
    campo3.status === 'running',
    `estado=${campo3.status}`,
  );
  comprobar(
    'arranca con dos humanos y cero bots',
    campo3.seated === 2 && campo3.playersRemaining === 2,
    `seated=${campo3.seated}, restantes=${campo3.playersRemaining}`,
  );
  comprobar(
    'la vuelta reporta un torneo arrancado',
    vuelta1.arrancados >= 1,
    JSON.stringify(vuelta1),
  );

  const mesas3 = await mesasDe(regA.fieldId);
  const conteo3 = mesas3[0] ? humanosYBot(mesas3[0]) : null;
  comprobar(
    'la mesa tiene 2 humanos y 0 bots',
    conteo3?.humanos === 2 && conteo3?.bots === 0,
    JSON.stringify(conteo3),
  );

  // ==================================================================
  console.log('\n=== 4. Registro tardio con stack completo ===\n');

  const regC = await tournamentManager.registrar(C, 'daily-micro', 'Carla');
  comprobar('el registro tardio entra en el campo en marcha', regC.fieldId === regA.fieldId);
  comprobar('se marca como tardio', regC.late === true, JSON.stringify(regC));

  const campo4 = await Field.findOne({ fieldId: regA.fieldId });
  const mesa4 = (await mesasDe(regA.fieldId))[0];
  const asientoC = mesa4.seats.find((s) => s.playerId === String(C));
  comprobar(
    'el tardio recibe el stack inicial completo',
    asientoC?.chips === micro.startingChips,
    `chips=${asientoC?.chips}`,
  );
  comprobar(
    'el campo anota las tres entradas',
    campo4.buyInsCollected === micro.buyInUnits * 3,
    `bote=${campo4.buyInsCollected}`,
  );

  // ==================================================================
  console.log('\n=== 5. Sin dos humanos se cancela y se devuelve ===\n');

  const antesD = await saldoDe(D);
  const regD = await tournamentManager.registrar(D, 'daily-main', 'Dani');
  const campoD = await Field.findOne({ fieldId: regD.fieldId });
  await cerrarCampo(campoD, -1);
  const vuelta2 = await tournamentManager.procesar();
  const cancelado = await Field.findOne({ fieldId: regD.fieldId });

  comprobar(
    'el torneo sin dos humanos se cancela',
    cancelado.status === 'cancelled',
    `estado=${cancelado.status}`,
  );
  comprobar(
    'se devuelve el buy-in completo',
    (await saldoDe(D)) === antesD,
    `${antesD} -> ${await saldoDe(D)}`,
  );
  comprobar(
    'la vuelta reporta la cancelacion',
    vuelta2.cancelados >= 1,
    JSON.stringify(vuelta2),
  );

  // ==================================================================
  console.log('\n=== 6. Spin & Go: arranca al llenarse ===\n');

  const antesSpinE = await saldoDe(E);
  const rE = await tournamentManager.registrar(E, 'spingo-1', 'Eva');
  const rF = await tournamentManager.registrar(F, 'spingo-1', 'Fabi');
  comprobar('los dos primeros comparten el mismo Spin', rE.fieldId === rF.fieldId);
  comprobar(
    'el Spin espera al tercero',
    (await Field.findOne({ fieldId: rE.fieldId })).status === 'filling',
  );

  const rG = await tournamentManager.registrar(G, 'spingo-1', 'Gabi');
  const spin = await Field.findOne({ fieldId: rE.fieldId });
  const mesaSpin = (await mesasDe(rE.fieldId))[0];
  const conteoSpin = mesaSpin ? humanosYBot(mesaSpin) : null;

  comprobar('el tercero dispara el arranque', spin.status === 'running');
  comprobar(
    'el Spin es 3-max y sin bots',
    conteoSpin?.humanos === 3 && conteoSpin?.bots === 0,
    JSON.stringify(conteoSpin),
  );
  comprobar(
    'el Spin cobra tres buy-ins',
    spin.buyInsCollected === spingo.buyInUnits * 3,
    `bote=${spin.buyInsCollected}`,
  );
  comprobar(
    'el Spin paga al ganador [100]',
    JSON.stringify(spin.payoutTable) === '[100]',
    JSON.stringify(spin.payoutTable),
  );
  comprobar(
    'el premio del Spin es 2,85 USDT',
    spin.prizePoolUnits === spingo.guaranteedPrizeUnits,
    `premio=${spin.prizePoolUnits}`,
  );
  comprobar(
    'a Eva se le cobro una vez',
    (await saldoDe(E)) === antesSpinE - spingo.buyInUnits,
    `${antesSpinE} -> ${await saldoDe(E)}`,
  );

  // ==================================================================
  console.log('\n=== 7. Liquidacion con garantia y overlay ===\n');

  const FIELD_ID = 'tournament-settle-test';
  const BUY_IN = micro.buyInUnits;
  const GARANTIA = micro.guaranteedPrizeUnits;

  await User.updateOne({ telegramId: H }, { $set: { 'balance.real': 0 } });
  await User.updateOne({ telegramId: I }, { $set: { 'balance.real': 0 } });

  const campoLiq = await Field.create({
    fieldId: FIELD_ID,
    kind: 'tournament',
    eventId: 'daily-micro',
    format: 'standard',
    tierId: FIELD_ID,
    status: 'running',
    buyInUnits: BUY_IN,
    buyInsCollected: BUY_IN * 2,
    prizePoolUnits: GARANTIA,
    payoutTable: [...micro.payout],
    targetField: micro.maxPlayers,
    waiting: 0,
    seated: 2,
    eliminated: 1,
    playersRemaining: 1,
    paidPositionsLeft: micro.payout.length,
    rakeCollected: 0,
    deadChips: 0,
    tables: [],
    plannedTables: 1,
    startedAt: new Date(),
    registrations: [
      {
        telegramId: H,
        buyIn: BUY_IN,
        status: 'seated',
        at: new Date(),
      },
      {
        telegramId: I,
        buyIn: BUY_IN,
        status: 'seated',
        at: new Date(),
      },
    ],
    results: [
      {
        position: 2,
        telegramId: I,
        username: 'Iris',
        amount: 0,
        tableId: `${FIELD_ID}-t1`,
        isBot: false,
      },
    ],
  });

  const mesaLiq = await Table.create({
    tableId: `${FIELD_ID}-t1`,
    kind: 'tournament',
    tierId: FIELD_ID,
    status: 'running',
    smallBlind: 25,
    bigBlind: 50,
    buyInUnits: BUY_IN,
    startChips: micro.startingChips,
    maxSeats: 7,
    field: {
      fieldId: FIELD_ID,
      tableNumber: 1,
      targetField: micro.maxPlayers,
      seated: 2,
      paidPositions: 0,
      fieldStatus: 'running',
    },
    hand: {
      handNumber: 3,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      actingSeat: -1,
      dealerSeat: 0,
      startedAt: new Date(),
    },
    stats: { handsPlayed: 3, rakeCollected: 0, prizePaid: 0 },
    seats: [
      {
        index: 0,
        kind: 'human',
        playerId: String(H),
        displayName: 'Hugo',
        chips: BUY_IN * 2,
        bet: 0,
        totalBet: BUY_IN,
        status: 'active',
        isDealer: true,
        joinedAt: new Date(),
      },
      {
        index: 1,
        kind: 'human',
        playerId: String(I),
        displayName: 'Iris',
        chips: 0,
        bet: 0,
        totalBet: BUY_IN,
        status: 'out',
        joinedAt: new Date(),
      },
    ],
  });

  const resultado = await fieldManager.settleField(
    campoLiq,
    mesaLiq.seats.find((s) => s.playerId === String(H)),
  );
  const cerrado = await Field.findOne({ fieldId: FIELD_ID });
  const saldoH = await saldoDe(H);
  const saldoI = await saldoDe(I);

  comprobar(
    'el campo queda terminado',
    cerrado.status === 'finished',
    `estado=${cerrado.status}`,
  );
  comprobar(
    'la garantia se paga aunque las entradas no la cubran',
    saldoH + saldoI === GARANTIA,
    `Hugo=${formatUnits(saldoH)}, Iris=${formatUnits(saldoI)}`,
  );
  comprobar(
    'el ganador recibe su tramo y el resto sin adjudicar',
    saldoH === Math.floor((GARANTIA * 75) / 100),
    `Hugo=${saldoH}`,
  );
  comprobar(
    'el segundo cobra su 25 %',
    saldoI === Math.floor((GARANTIA * 25) / 100),
    `Iris=${saldoI}`,
  );
  comprobar(
    'el overlay queda anotado',
    cerrado.overlayUnits === GARANTIA - BUY_IN * 2,
    `overlay=${cerrado.overlayUnits}`,
  );
  comprobar(
    'no se inventa rake cuando hay overlay',
    cerrado.rakeCollected === 0,
    `rake=${cerrado.rakeCollected}`,
  );
  comprobar(
    'la mesa se vacia y se cierra',
    (await Table.findOne({ tableId: mesaLiq.tableId })).status === 'finished',
  );
  comprobar(
    'el resultado no paga dos veces',
    resultado.paid.length === 2,
    JSON.stringify(resultado.paid),
  );

  // ==================================================================
  console.log('\n=== 8. QVA Premium: descuento y reembolso exacto ===\n');

  const precioPremium = Math.floor((premiumEvent.buyInUnits * 95) / 100);
  await VIP.create({
    telegramId: D,
    level: 'premium',
    startDate: new Date(Date.now() - 60_000),
    endDate: new Date(Date.now() + 30 * 86_400_000),
    rakebackPercent: 10,
    tournamentDiscount: 5,
    powerUpsPerMonth: 18,
  });

  const antesPremium = await saldoDe(D);
  const regPremium = await tournamentManager.registrar(D, premiumEvent.id, 'Dani');
  const campoPremium = await Field.findOne({ fieldId: regPremium.fieldId });
  const registroPremium = campoPremium.registrations.find(
    (r) => r.telegramId === D,
  );
  const lobbyPremium = await tournamentManager.estado(D);
  const entradaPremium = [...lobbyPremium.torneos, ...lobbyPremium.spin].find(
    (t) => t.fieldId === regPremium.fieldId,
  );

  comprobar(
    'QVA Premium paga un 5 % menos de buy-in',
    antesPremium - (await saldoDe(D)) === precioPremium,
    `cobrado=${antesPremium - (await saldoDe(D))}, esperado=${precioPremium}`,
  );
  comprobar(
    'el cobro con descuento queda anotado en la inscripcion',
    registroPremium?.buyIn === precioPremium,
    `registro=${registroPremium?.buyIn}`,
  );
  comprobar(
    'el bote del campo usa el importe realmente cobrado',
    campoPremium.buyInsCollected === precioPremium,
    `bote=${campoPremium.buyInsCollected}`,
  );
  comprobar(
    'el lobby no infla el bote con el buy-in nominal',
    entradaPremium?.boteEntradasUsdt ===
      Math.floor(precioPremium * 0.95) / 1000,
    JSON.stringify(entradaPremium),
  );

  const antesSalidaPremium = await saldoDe(D);
  const salidaPremium = await tournamentManager.salir(D, regPremium.fieldId);
  const campoSalida = await Field.findOne({ fieldId: regPremium.fieldId });
  const registroSalida = campoSalida.registrations.find(
    (r) => r.telegramId === D,
  );
  comprobar(
    'la salida devuelve exactamente lo cobrado',
    salidaPremium.salio === true && (await saldoDe(D)) - antesSalidaPremium === precioPremium,
    `devuelto=${(await saldoDe(D)) - antesSalidaPremium}, esperado=${precioPremium}`,
  );
  comprobar(
    'la salida marca la inscripcion como reembolsada',
    registroSalida?.status === 'refunded',
    `estado=${registroSalida?.status}`,
  );
  comprobar(
    'el bote del campo queda en cero tras la salida',
    campoSalida.buyInsCollected === 0,
    `bote=${campoSalida.buyInsCollected}`,
  );

  // ==================================================================
  console.log('\n=== 9. Spin & Go: relleno a los 6 minutos y reembolso a los 9 ===\n');

  const J = ids[9];
  const K = ids[10];

  comprobar(
    'las ventanas son 6 y 9 minutos',
    SPIN_COMPLETAR_MS === 6 * 60_000 && SPIN_REEMBOLSO_MS === 9 * 60_000,
    `${SPIN_COMPLETAR_MS}/${SPIN_REEMBOLSO_MS}`,
  );

  // La decision de completar es estable por fieldId, no aleatoria en cada
  // vuelta. Sobre 1.000 identificadores debe rondar el 55 %.
  const completados = Array.from({ length: 1_000 }, (_, i) =>
    spinSeCompleta(`spingo-estable-${i}`),
  ).filter(Boolean).length;
  comprobar(
    'el relleno es determinista y parcial (45-65 %)',
    completados >= 450 && completados <= 650,
    `${completados}/1000`,
  );
  comprobar(
    'el mismo campo siempre decide lo mismo',
    spinSeCompleta('spingo-estable-7') === spinSeCompleta('spingo-estable-7'),
  );

  // --- Reembolso automatico al cumplir 9 minutos ---
  const antesRefund = await saldoDe(J);
  const regRefund = await tournamentManager.registrar(J, 'spingo-1', 'Jota');
  const campoRefund = await Field.findOne({ fieldId: regRefund.fieldId });
  comprobar(
    'el Spin de reembolso queda en inscripcion',
    campoRefund?.status === 'filling',
    `estado=${campoRefund?.status}`,
  );

  const viejo = new Date(Date.now() - SPIN_REEMBOLSO_MS - 60_000);
  await Field.collection.updateOne(
    { fieldId: regRefund.fieldId },
    { $set: { createdAt: viejo } },
  );
  await tournamentManager.procesar();
  const campoReembolsado = await Field.findOne({ fieldId: regRefund.fieldId });
  const registroReembolsado = campoReembolsado.registrations.find(
    (r) => r.telegramId === J,
  );
  comprobar(
    'a los 9 minutos sin llenarse, el Spin se cancela',
    campoReembolsado.status === 'cancelled',
    `estado=${campoReembolsado.status}`,
  );
  comprobar(
    'el jugador recupera exactamente su buy-in',
    (await saldoDe(J)) === antesRefund,
    `${antesRefund} -> ${await saldoDe(J)}`,
  );
  comprobar(
    'la inscripcion queda reembolsada',
    registroReembolsado?.status === 'refunded',
    `estado=${registroReembolsado?.status}`,
  );

  // --- Relleno automatico a los 6 minutos ---
  // Se usa un campo con un identificador que el hash decide completar. Asi la
  // prueba no depende de la hora ni del azar entre ejecuciones.
  const autoId = Array.from({ length: 500 }, (_, i) => `spingo-auto-${i}`).find(
    spinSeCompleta,
  );
  if (!autoId) throw new Error('No se encontro un fieldId completable');

  const campoAuto = await Field.create({
    fieldId: autoId,
    kind: 'tournament',
    eventId: 'spingo-25',
    format: 'spingo',
    tierId: autoId,
    status: 'filling',
    buyInUnits: getTournamentEvent('spingo-25').buyInUnits,
    buyInsCollected: getTournamentEvent('spingo-25').buyInUnits,
    prizePoolUnits: getTournamentEvent('spingo-25').guaranteedPrizeUnits,
    payoutTable: [100],
    targetField: 3,
    waiting: 0,
    seated: 1,
    eliminated: 0,
    playersRemaining: 1,
    paidPositionsLeft: 1,
    rakeCollected: 0,
    deadChips: 0,
    tables: [],
    plannedTables: 1,
    registrations: [
      {
        telegramId: K,
        buyIn: getTournamentEvent('spingo-25').buyInUnits,
        status: 'seated',
        at: new Date(),
      },
    ],
  });

  const mesaAuto = await Table.create({
    tableId: `${autoId}-t1`,
    kind: 'tournament',
    tierId: autoId,
    status: 'waiting',
    smallBlind: 25,
    bigBlind: 50,
    buyInUnits: getTournamentEvent('spingo-25').buyInUnits,
    startChips: getTournamentEvent('spingo-25').startingChips,
    maxSeats: 7,
    field: {
      fieldId: autoId,
      tableNumber: 1,
      targetField: 3,
      seated: 1,
      paidPositions: 0,
      fieldStatus: 'filling',
    },
    hand: {
      handNumber: 0,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      actingSeat: -1,
      dealerSeat: 0,
    },
    stats: { handsPlayed: 0, rakeCollected: 0, prizePaid: 0 },
    seats: [
      {
        index: 0,
        kind: 'human',
        playerId: String(K),
        displayName: 'Ka',
        chips: getTournamentEvent('spingo-25').startingChips,
        bet: 0,
        totalBet: 0,
        status: 'active',
        isDealer: true,
        joinedAt: new Date(),
      },
    ],
  });

  const arrancadoAuto = await tournamentManager.completarSpin(campoAuto);
  const campoAutoFinal = await Field.findOne({ fieldId: autoId });
  const mesaAutoFinal = await Table.findOne({ tableId: mesaAuto.tableId });
  const asientosAuto = mesaAutoFinal.seats;
  comprobar(
    'a los 6 minutos, un Spin elegible se completa y arranca',
    arrancadoAuto === true && campoAutoFinal.status === 'running',
    `arrancado=${arrancadoAuto}, estado=${campoAutoFinal?.status}`,
  );
  comprobar(
    'el campo completa la mesa hasta tres asientos',
    asientosAuto.filter((s) => s.status === 'active').length === 3,
    `activos=${asientosAuto.filter((s) => s.status === 'active').length}`,
  );
  comprobar(
    'el humano conserva su asiento y se añaden dos rivales',
    asientosAuto.filter((s) => s.kind === 'human').length === 1 &&
      asientosAuto.filter((s) => s.kind === 'bot').length === 2,
  );
  comprobar(
    'el ultimo asiento de la mesa sigue libre',
    asientosAuto.length < mesaAutoFinal.maxSeats,
    `${asientosAuto.length}/${mesaAutoFinal.maxSeats}`,
  );

  console.log(`\n${ok} correctas, ${mal} fallidas`);
  await mongoose.disconnect();
  process.exit(mal === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error('\nEl test se detuvo:', error);
  try {
    await mongoose.disconnect();
  } catch {
    // nada
  }
  process.exit(1);
});
