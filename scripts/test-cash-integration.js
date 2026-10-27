/**
 * PRUEBA DE INTEGRACION DEL CICLO CASH COMPLETO.
 *
 * ------------------------------------------------------------------
 * QUE SE COMPRUEBA
 *
 *  - Al sentarse se descuenta EXACTAMENTE el buy-in del monedero y el
 *    stack entra en la mesa. Ni un centimo mas, ni uno menos.
 *  - Se juegan varias manos consecutivas con el mismo stack. El monedero
 *    NO cambia entre manos: el dinero esta en la mesa, no en el bolsillo.
 *  - En cada mano se conserva el total: fichas de los asientos + rake
 *    nuevo = fichas que habia antes de repartir. No se crea ni se pierde
 *    dinero por el camino.
 *  - Si el humano se queda sin fichas, sale de la mesa solo, se limpia
 *    `activeTableId` y NO se le abona nada al monedero (ya lo perdio).
 *  - Si se levanta con fichas, se le devuelve exactamente su stack y el
 *    monedero queda cuadrado: inicial - buy-in + devuelto.
 *
 * ------------------------------------------------------------------
 * COMO SE EJECUTA
 *
 *   node scripts/test-cash-integration.js
 *
 * Sin `MONGODB_URI`, arranca un MongoDB efimero con `mongodb-memory-server`
 * (la primera vez descarga el binario). Si en el equipo ya hay un Mongo,
 * se puede apuntar a el:
 *
 *   MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_cash_test \
 *     node scripts/test-cash-integration.js
 *
 * No usa el `tick` ni los temporizadores de los bots: conduce las manos paso
 * a paso. Asi el resultado no depende de la velocidad del equipo ni de la IA
 * aleatoria, y un fallo dice exactamente en que mano y en que asiento paso.
 */

require('dotenv').config();

process.env.DEV_AUTH_BYPASS = 'false';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const mongoose = require('mongoose');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d !== undefined) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const note = (m) => console.log(`      \x1b[2m${m}\x1b[0m`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod = null;

const conectar = async () => {
  let uri = process.env.MONGODB_URI;

  if (!uri) {
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = require('mongodb-memory-server'));
    } catch (e) {
      console.error(
        '\nNo esta instalado mongodb-memory-server y no hay MONGODB_URI.\n' +
        'Instala las dependencias o define MONGODB_URI apuntando a un Mongo.\n',
      );
      process.exit(2);
    }

    try {
      mongod = await MongoMemoryServer.create({
        binary: {
          // La version por defecto del paquete puede no existir para Windows.
          // 7.0.14 esta publicada para Linux, macOS y Windows x86_64.
          version: process.env.MONGOMS_VERSION || '7.0.14',
        },
      });
      uri = mongod.getUri('cubapoker_cash_test');
      note(`MongoDB efimero: ${uri}`);
    } catch (e) {
      console.error('\nNo se pudo arrancar MongoDB efimero:');
      console.error(e.message);
      console.error(
        '\nDefine MONGODB_URI con un Mongo accesible, por ejemplo:\n' +
        '  MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_cash_test\n',
      );
      process.exit(2);
    }
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
};

const desconectar = async () => {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  } catch { /* nada que hacer al salir */ }

  if (mongod) {
    try { await mongod.stop(); } catch { /* nada */ }
  }
};

const finish = async () => {
  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  await desconectar();
  process.exit(fail > 0 ? 1 : 0);
};

main().catch(async (e) => {
  console.error('\n\x1b[31mEl test reviento antes de terminar:\x1b[0m');
  console.error(e);
  fail++;
  await finish();
});

let contadorMesa = 0;
const idMesa = () => `cash-test-${Date.now().toString(36)}-${++contadorMesa}`;

const sumarFichas = (table) =>
  (table.seats ?? []).reduce(
    (total, s) => total + Math.max(0, s.chips) + Math.max(0, s.bet),
    0,
  );

const usuario = async (telegramId, saldo) => {
  const { User } = require('../dist/models/User');
  return User.create({
    telegramId,
    username: `prueba${telegramId}`,
    firstName: `Prueba ${telegramId}`,
    balance: { real: saldo, play: 0, realFromPrizes: 0 },
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
};

const crearMesa = async ({ buyIn, smallBlind, bigBlind, maxSeats = 7 }) => {
  const { Table } = require('../dist/models/Table');
  return Table.create({
    tableId: idMesa(),
    kind: 'cash',
    tierId: 't1',
    status: 'waiting',
    buyInUnits: buyIn,
    smallBlind,
    bigBlind,
    maxSeats,
    seats: [],
    hand: {
      handNumber: 0,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      actingSeat: -1,
      dealerSeat: 0,
    },
  });
};

/** Espera a que `finishHand` termine de guardar la mesa en reposo. */
const esperarEnReposo = async (tableId) => {
  const { Table } = require('../dist/models/Table');
  const { tableManager } = require('../dist/game/table.manager');

  // 10 s, no 2 s: con Mongo compartido por varias suites el guardado puede
  // tardar mas y la prueba fallaba por contencion, no por un bug de dinero.
  for (let i = 0; i < 1000; i++) {
    const t = await Table.findOne({ tableId });
    if (!t) throw new Error(`La mesa ${tableId} desaparecio`);

    const fase = t.hand.phase;
    const motor = tableManager.engines.get(tableId);

    if (!motor && (fase === 'idle' || fase === 'idle-awaiting')) return t;
    if (!motor && fase === 'finished') {
      // `finishHand` ya quito el motor pero aun no ha guardado el reposo.
    }
    await dormir(10);
  }

  throw new Error(`La mesa ${tableId} no volvio a reposo`);
};

/**
 * Juega UNA mano hasta que se cierra.
 *
 * `estrategia` decide la accion del humano. Los bots se resuelven llamando
 * directamente a su turno, sin esperar timers. Cuando el motor termina, la
 * liquidacion la hace el mismo camino de produccion (`finishHand`).
 */
const jugarMano = async (tableId, telegramId, estrategia) => {
  const { Table } = require('../dist/models/Table');
  const { tableManager } = require('../dist/game/table.manager');
  const { seatingService } = require('../dist/game/seating.service');

  const antes = await Table.findOne({ tableId });
  if (!antes) throw new Error('Mesa inexistente');

  const fichasAntes = sumarFichas(antes);
  const rakeAntes = antes.stats.rakeCollected ?? 0;
  const numeroAntes = antes.hand.handNumber ?? 0;

  await tableManager.startHand(antes);

  if (!tableManager.engines.has(tableId)) {
    throw new Error(`La mano ${numeroAntes + 1} no arranco: el motor no se creo`);
  }

  let acciones = 0;

  while (acciones < 500) {
    const t = await Table.findOne({ tableId });
    if (!t) throw new Error('Mesa inexistente durante la mano');

    // La mano ha terminado y `finishHand` ya limpio el motor.
    if (!tableManager.engines.has(tableId)) {
      const enReposo = await esperarEnReposo(tableId);
      return { mesa: enReposo, fichasAntes, rakeAntes, numeroAntes };
    }

    if (t.hand.phase === 'idle' || t.hand.phase === 'idle-awaiting') {
      return { mesa: t, fichasAntes, rakeAntes, numeroAntes };
    }

    const asiento = (t.seats ?? []).find((s) => s.index === t.hand.actingSeat);
    if (!asiento) {
      throw new Error(
        `Turno apuntando al asiento ${t.hand.actingSeat}, que no existe. ` +
        `Asientos: ${(t.seats ?? []).map((s) => s.index).join(',') || 'ninguno'}. ` +
        `Fase ${t.hand.phase}`,
      );
    }

    if (asiento.kind === 'bot') {
      await tableManager.playBotTurn(t);
      acciones++;

      // Si el bot cerro la mano, `scheduleTurn` dispara `finishHand` sin
      // esperarlo. Aqui se espera a que el documento quede en reposo.
      const despues = await Table.findOne({ tableId });
      const entry = tableManager.engines.get(tableId);
      const faseMotor = entry?.engine?.getState?.().phase;
      if (!entry || faseMotor === 'finished' || faseMotor === 'showdown') {
        await esperarEnReposo(tableId);
      }
      continue;
    }

    if (asiento.kind !== 'human') {
      throw new Error(`Asiento ${asiento.index} con tipo desconocido: ${asiento.kind}`);
    }

    if (Number(asiento.playerId) !== telegramId) {
      throw new Error(
        `El turno es del humano ${asiento.playerId}, no de ${telegramId}`,
      );
    }

    const accion = estrategia(t, asiento);
    const aplicada = await seatingService.act(telegramId, tableId, accion);
    if (!aplicada?.ok) {
      throw new Error(`La accion ${accion} no se aplico en la mano ${t.hand.handNumber}`);
    }
    acciones++;

    // `act` espera a `finishHand` si la mano termino. Si no, el bucle sigue
    // con el siguiente asiento.
    const trasAccion = await Table.findOne({ tableId });
    if (!tableManager.engines.has(tableId)) {
      await esperarEnReposo(tableId);
    } else if (
      trasAccion.hand.phase === 'idle' ||
      trasAccion.hand.phase === 'idle-awaiting'
    ) {
      return { mesa: trasAccion, fichasAntes, rakeAntes, numeroAntes };
    }
  }

  throw new Error('La mano no termino en 500 acciones');
};

/** Estrategia que no se juega el stack: check si es gratis, call si es barato. */
const pasivo = (table, seat) => {
  const porIgualar = Math.max(0, table.hand.currentBet - (seat.bet ?? 0));
  if (porIgualar === 0) return 'check';
  if (porIgualar > Math.max(1, seat.chips) * 0.35) return 'fold';
  return 'call';
};

/** Estrategia para bustear rapido: se retira en cuanto le toca. */
const retirarseSiempre = () => 'fold';

async function main() {
  console.log('\n\x1b[1mCubaPoker · Ciclo cash completo\x1b[0m');

  section('0. Conexion y limpieza');
  await conectar();
  await mongoose.connection.dropDatabase();
  ok('base de datos lista');

  const { Table } = require('../dist/models/Table');
  const { User } = require('../dist/models/User');
  const { seatingService } = require('../dist/game/seating.service');
  const { tableManager } = require('../dist/game/table.manager');
  const { BOT_CONFIG } = require('../dist/config/product');

  // Los timers de los bots no deben dispararse: las manos se conducen a mano.
  // Se deja un margen enorme y se limpian al final con `stop()`.
  const thinkMinOriginal = BOT_CONFIG.minThinkMs;
  const thinkMaxOriginal = BOT_CONFIG.maxThinkMs;
  BOT_CONFIG.minThinkMs = 3_600_000;
  BOT_CONFIG.maxThinkMs = 3_600_000;

  try {
    // ==================================================================
    section('1. Sentarse: el monedero baja exactamente el buy-in');
    // ==================================================================

    const TID = 700_000_101;
    const SALDO = 1_000_000; // 1 000 USDT en unidades internas
    const BUY_IN = 2_000;    // 2 USDT
    const SB = 5;
    const BB = 10;

    await usuario(TID, SALDO);
    const mesa = await crearMesa({ buyIn: BUY_IN, smallBlind: SB, bigBlind: BB });

    const sentado = await seatingService.sitDown({
      telegramId: TID,
      tableId: mesa.tableId,
    });

    let u = await User.findOne({ telegramId: TID });
    let t = await Table.findOne({ tableId: mesa.tableId });
    let asientoHumano = t.seats.find((s) => s.kind === 'human');

    if (u.balance.real === SALDO - BUY_IN) {
      ok(`monedero: ${SALDO} - ${BUY_IN} = ${u.balance.real}`);
    } else {
      bad(
        `el monedero no baja el buy-in exacto: esperado ${SALDO - BUY_IN}, ` +
        `quedo ${u.balance.real}`,
      );
    }

    if (sentado.chips === BUY_IN && asientoHumano?.chips === BUY_IN) {
      ok(`stack en la mesa: ${BUY_IN} unidades`);
    } else {
      bad(
        `el stack del asiento no es el buy-in: sentado=${sentado.chips}, ` +
        `asiento=${asientoHumano?.chips}`,
      );
    }

    if (u.activeTableId === mesa.tableId) {
      ok('activeTableId apunta a la mesa');
    } else {
      bad(`activeTableId incorrecto: ${u.activeTableId}`);
    }

    const botsAnadidos = await tableManager.asegurarMinimoAsientos(mesa.tableId, 3);
    note(`bots anadidos para jugar: ${botsAnadidos}`);
    t = await Table.findOne({ tableId: mesa.tableId });
    if (t.seats.filter((s) => s.status === 'active' && s.chips > 0).length >= 2) {
      ok('hay al menos dos jugadores para repartir');
    } else {
      bad('no hay jugadores suficientes en la mesa');
    }

    // ==================================================================
    section('2. Varias manos: el stack vive en la mesa, no en el monedero');
    // ==================================================================

    const MANOS_PASIVAS = 3;
    let ultimoHumano = null;

    for (let mano = 1; mano <= MANOS_PASIVAS; mano++) {
      const r = await jugarMano(mesa.tableId, TID, pasivo);
      const asignado = r.mesa.seats.find(
        (s) => s.kind === 'human' && Number(s.playerId) === TID,
      );

      const numero = r.mesa.hand.handNumber;
      const fichasDespues = sumarFichas(r.mesa);
      const rakeNuevo = (r.mesa.stats.rakeCollected ?? 0) - r.rakeAntes;

      if (numero === r.numeroAntes + 1) {
        ok(`mano ${numero} cerrada (antes ${r.numeroAntes})`);
      } else {
        bad(`el contador de manos no avanzo: ${r.numeroAntes} -> ${numero}`);
      }

      if (fichasDespues + rakeNuevo === r.fichasAntes) {
        ok(
          `mano ${numero}: conservacion exacta ` +
          `(${r.fichasAntes} = ${fichasDespues} fichas + ${rakeNuevo} rake)`,
        );
      } else {
        bad(
          `mano ${numero}: se perdieron o crearon fichas. ` +
          `antes=${r.fichasAntes}, despues=${fichasDespues}, rake=${rakeNuevo}`,
        );
      }

      u = await User.findOne({ telegramId: TID });
      if (u.balance.real === SALDO - BUY_IN) {
        ok(`mano ${numero}: el monedero sigue en ${u.balance.real} (no se abona por mano)`);
      } else {
        bad(
          `mano ${numero}: el monedero cambio durante la mano: ` +
          `${u.balance.real}, esperado ${SALDO - BUY_IN}`,
        );
      }

      if (asignado) {
        ultimoHumano = asignado.chips;
        note(`stack del humano tras la mano ${numero}: ${asignado.chips}`);
        if (u.activeTableId === mesa.tableId) {
          // Sigue sentado, con o sin fichas.
        } else {
          bad(`activeTableId se limpio con el jugador aun sentado`);
        }
      } else {
        bad(`el humano desaparecio de la mesa en la mano ${numero}`);
      }
    }

    // ==================================================================
    section('3. Levantarse: se devuelve el stack exacto');
    // ==================================================================

    tableManager.stop();

    t = await Table.findOne({ tableId: mesa.tableId });
    asientoHumano = t.seats.find(
      (s) => s.kind === 'human' && Number(s.playerId) === TID,
    );

    if (!asientoHumano) {
      bad('no hay asiento humano para levantar');
    } else {
      if (t.hand.phase !== 'idle') {
        bad(`la mesa no esta en reposo antes de levantar: ${t.hand.phase}`);
      }

      const stackAntesDeSalir = asientoHumano.chips + (asientoHumano.bet ?? 0);
      const salida = await seatingService.standUp(TID, mesa.tableId);

      u = await User.findOne({ telegramId: TID });
      t = await Table.findOne({ tableId: mesa.tableId });

      if (salida.returned === stackAntesDeSalir) {
        ok(`devuelto exacto: ${salida.returned} unidades (stack ${stackAntesDeSalir})`);
      } else {
        bad(
          `devuelto ${salida.returned}, esperado ${stackAntesDeSalir} ` +
          `(stack ${asientoHumano.chips} + apuesta ${asientoHumano.bet})`,
        );
      }

      const esperado = SALDO - BUY_IN + salida.returned;
      if (u.balance.real === esperado) {
        ok(`monedero conciliado: ${SALDO} - ${BUY_IN} + ${salida.returned} = ${u.balance.real}`);
      } else {
        bad(`monedero descuadrado: esperado ${esperado}, quedo ${u.balance.real}`);
      }

      if (!u.activeTableId) {
        ok('activeTableId limpio al salir');
      } else {
        bad(`activeTableId sigue en ${u.activeTableId} tras salir`);
      }

      if (!t.seats.some((s) => s.kind === 'human' && Number(s.playerId) === TID)) {
        ok('el asiento humano se libero');
      } else {
        bad('el asiento humano sigue ocupado tras salir');
      }
    }

    // ==================================================================
    section('3b. No se puede levantar a mitad de mano');
    // ==================================================================
    //
    // Quitar un asiento a mitad de mano y reindexar la mesa deja al motor en
    // memoria apuntando a indices viejos. La API debe rechazarlo incluso si la
    // apuesta viva es cero (las apuestas ya estan en el bote al cerrar calle).

    const TID_MID = 700_000_104;
    const SALDO_MID = 1_000_000;
    await usuario(TID_MID, SALDO_MID);
    const mesaMid = await crearMesa({ buyIn: 2_000, smallBlind: 5, bigBlind: 10 });
    await seatingService.sitDown({ telegramId: TID_MID, tableId: mesaMid.tableId });
    await tableManager.asegurarMinimoAsientos(mesaMid.tableId, 3);

    const antesMid = await Table.findOne({ tableId: mesaMid.tableId });
    await tableManager.startHand(antesMid);
    const enManoMid = await Table.findOne({ tableId: mesaMid.tableId });

    if (enManoMid.hand.phase === 'idle') {
      bad('la mano no arranco: no se puede probar el bloqueo');
    } else {
      try {
        await seatingService.standUp(TID_MID, mesaMid.tableId);
        bad('dejo levantar a mitad de mano: el motor quedaria desindexado');
      } catch (e) {
        if (e.status === 409 || /mano en curso/i.test(e.message)) {
          ok('rechaza levantar a mitad de mano (409)');
        } else {
          bad(`el rechazo de mitad de mano devolvio otro error: ${e.message}`);
        }
      }

      const trasIntento = await Table.findOne({ tableId: mesaMid.tableId });
      const sigueSentado = trasIntento.seats.some(
        (s) => s.kind === 'human' && Number(s.playerId) === TID_MID,
      );
      const uMid = await User.findOne({ telegramId: TID_MID });

      if (sigueSentado && uMid.activeTableId === mesaMid.tableId) {
        ok('la mesa y el asiento quedan intactos tras el rechazo');
      } else {
        bad('el asiento o activeTableId cambiaron pese al rechazo');
      }
    }

    // Limpieza del caso aislado: no forma parte del ciclo principal.
    tableManager.engines.delete(mesaMid.tableId);
    await Table.deleteOne({ tableId: mesaMid.tableId });
    await User.deleteOne({ telegramId: TID_MID });

    // ==================================================================
    section('4. Bust: el jugador sale solo y el monedero no recibe nada');
    // ==================================================================

    const TID_BUST = 700_000_102;
    const SALDO_BUST = 1_000_000;
    const BUY_IN_BUST = 100; // 0,1 USDT
    const SB_BUST = 40;
    const BB_BUST = 80;

    await usuario(TID_BUST, SALDO_BUST);
    const mesaBust = await crearMesa({
      buyIn: BUY_IN_BUST,
      smallBlind: SB_BUST,
      bigBlind: BB_BUST,
    });

    await seatingService.sitDown({ telegramId: TID_BUST, tableId: mesaBust.tableId });
    await tableManager.asegurarMinimoAsientos(mesaBust.tableId, 3);

    u = await User.findOne({ telegramId: TID_BUST });
    if (u.balance.real === SALDO_BUST - BUY_IN_BUST) {
      ok(`monedero tras sentarse: ${u.balance.real}`);
    } else {
      bad(`monedero tras sentarse: ${u.balance.real}, esperado ${SALDO_BUST - BUY_IN_BUST}`);
    }

    let seFue = false;
    let manosJugadas = 0;

    for (let intento = 1; intento <= 20 && !seFue; intento++) {
      // Si los dos bots se eliminan y el humano sigue, la mesa no puede
      // repartir. Se repone ambiente, como haria el gestor.
      const activos = (await Table.findOne({ tableId: mesaBust.tableId })).seats.filter(
        (s) => s.status === 'active' && s.chips > 0,
      ).length;
      if (activos < 2) {
        await tableManager.asegurarMinimoAsientos(mesaBust.tableId, 2);
      }

      const r = await jugarMano(mesaBust.tableId, TID_BUST, retirarseSiempre);
      manosJugadas++;

      const sigue = r.mesa.seats.find(
        (s) => s.kind === 'human' && Number(s.playerId) === TID_BUST,
      );

      u = await User.findOne({ telegramId: TID_BUST });

      if (!sigue || u.activeTableId === null || u.activeTableId === undefined) {
        seFue = true;

        if (!sigue) {
          ok(`bust en la mano ${manosJugadas}: el asiento se libero`);
        } else {
          bad(`activeTableId limpio pero el asiento sigue ocupado`);
        }

        if (u.balance.real === SALDO_BUST - BUY_IN_BUST) {
          ok(
            `monedero intacto tras el bust: ${u.balance.real} ` +
            `(solo se desconto el buy-in, no se abono nada)`,
          );
        } else {
          bad(
            `monedero tras el bust: ${u.balance.real}, esperado ` +
            `${SALDO_BUST - BUY_IN_BUST}. Hubo un abono o un cargo de mas.`,
          );
        }
      }
    }

    if (!seFue) {
      bad(`el humano no llego a bustear en ${manosJugadas} manos`);
      note('Se retiraba en todos sus turnos, asi que deberia perder las ciegas y caer.');
    }

    // ==================================================================
    section('5. Rakeback: Arena y cash no se pagan dos veces');
    // ==================================================================
    //
    // La regla de producto: el 10% del 3-Bet Club solo cuenta mesas cash
    // normales; el 15% de Arena solo cuenta eventos de Arena. Antes el 3-Bet
    // sumaba tambien Arena y un miembro cobraba el 25% del mismo rake.
    //
    // Se insertan eventos del libro directamente (con fecha de la semana
    // cerrada) para no depender de repartir manos. El calculo y los pagos son
    // los mismos que usa produccion.

    const { RakeEvent } = require('../dist/models/Rakeback');
    const { VIP } = require('../dist/models/VIP');
    const { rakebackService } = require('../dist/services/rakeback.service');

    const TID_VIP = 700_000_103;
    const SALDO_VIP = 1_000_000;
    await usuario(TID_VIP, SALDO_VIP);

    const ahora = new Date();
    const lunesEstaSemana = new Date(ahora);
    lunesEstaSemana.setUTCHours(0, 0, 0, 0);
    lunesEstaSemana.setUTCDate(
      lunesEstaSemana.getUTCDate() - ((lunesEstaSemana.getUTCDay() + 6) % 7),
    );
    const lunesSemanaPasada = new Date(lunesEstaSemana.getTime() - 7 * 86_400_000);

    await VIP.create({
      telegramId: TID_VIP,
      level: 'basic',
      startDate: new Date(lunesSemanaPasada.getTime() - 10 * 86_400_000),
      endDate: new Date(ahora.getTime() + 30 * 86_400_000),
      rakebackPercent: 10,
    });

    const evento = (tableId, amount, arena, at) => ({
      telegramId: TID_VIP,
      tableId,
      handNumber: 1,
      amount,
      arena,
      at,
    });

    const mitadSemanaPasada = new Date(lunesSemanaPasada.getTime() + 3 * 86_400_000);
    // La semana en curso no llega hasta el domingo: un evento del jueves puede
    // estar en el futuro si la prueba corre el lunes o el martes. `getStatus`
    // solo cuenta hasta `now`, asi que se elige un instante ya transcurrido
    // dentro de esta semana.
    const mitadEstaSemana = new Date(
      lunesEstaSemana.getTime() +
        Math.max(
          1,
          Math.min(
            3 * 86_400_000,
            ahora.getTime() - lunesEstaSemana.getTime() - 1_000,
          ),
        ),
    );

    await RakeEvent.create([
      // Semana cerrada: 1.000 de cash normal y 1.000 de Arena.
      evento('rake-cash-pasada', 1_000, false, mitadSemanaPasada),
      evento('rake-arena-pasada', 1_000, true, mitadSemanaPasada),
      // Semana en curso: 500 de cash normal y 700 de Arena.
      evento('rake-cash-actual', 500, false, mitadEstaSemana),
      evento('rake-arena-actual', 700, true, mitadEstaSemana),
    ]);

    const estadoVip = await rakebackService.getStatus(TID_VIP, ahora);
    const estadoArena = await rakebackService.getArenaStatus(TID_VIP, ahora);

    if (estadoVip.rakeUnits === 1_000 && estadoVip.estimatedUnits === 100) {
      ok('3-Bet Club: 10% solo del cash normal (1.000 -> 100)');
    } else {
      bad(
        `3-Bet Club contó mal: rake=${estadoVip.rakeUnits}, ` +
        `estimado=${estadoVip.estimatedUnits} (esperado 1.000 -> 100)`,
      );
    }

    if (estadoArena.rakeUnits === 1_000 && estadoArena.estimatedUnits === 150) {
      ok('VIP Arena: 15% solo del rake de Arena (1.000 -> 150)');
    } else {
      bad(
        `VIP Arena contó mal: rake=${estadoArena.rakeUnits}, ` +
        `estimado=${estadoArena.estimatedUnits} (esperado 1.000 -> 150)`,
      );
    }

    if (estadoVip.currentWeekRakeUnits === 500) {
      ok('la semana en curso del 3-Bet tambien excluye Arena (solo 500)');
    } else {
      bad(
        `la semana en curso del 3-Bet incluye Arena: ` +
        `${estadoVip.currentWeekRakeUnits}, esperado 500`,
      );
    }

    const pagoVip = await rakebackService.payWeeklyRakeback(TID_VIP, ahora);
    const pagoArena = await rakebackService.payArenaWeekly(TID_VIP, ahora);
    u = await User.findOne({ telegramId: TID_VIP });

    if (pagoVip.paid === 100 && pagoArena.paid === 150) {
      ok('pagos separados: 100 de 3-Bet + 150 de Arena');
    } else {
      bad(
        `pagos incorrectos: 3-Bet=${pagoVip.paid} (esperado 100), ` +
        `Arena=${pagoArena.paid} (esperado 150)`,
      );
    }

    if (u.balance.real === SALDO_VIP + 250) {
      ok(`monedero tras ambos pagos: ${SALDO_VIP} + 250 = ${u.balance.real}`);
    } else {
      bad(
        `monedero tras los pagos: ${u.balance.real}, esperado ${SALDO_VIP + 250}`,
      );
    }

    // Repetir los dos cobros no debe mover un centimo.
    const repetidoVip = await rakebackService.payWeeklyRakeback(TID_VIP, ahora);
    const repetidoArena = await rakebackService.payArenaWeekly(TID_VIP, ahora);
    u = await User.findOne({ telegramId: TID_VIP });

    if (
      repetidoVip.paid === 0 &&
      repetidoArena.paid === 0 &&
      u.balance.real === SALDO_VIP + 250
    ) {
      ok('los dos pagos son idempotentes: repetir no acredita de nuevo');
    } else {
      bad(
        `reintento pago de mas: 3-Bet=${repetidoVip.paid}, ` +
        `Arena=${repetidoArena.paid}, saldo=${u.balance.real}`,
      );
    }
  } finally {
    BOT_CONFIG.minThinkMs = thinkMinOriginal;
    BOT_CONFIG.maxThinkMs = thinkMaxOriginal;
    tableManager.stop();
  }

  await finish();
}
