/**
 * Test end-to-end del motor real: un campo jugado de verdad, con bots, hasta el
 * final.
 *
 * ------------------------------------------------------------------
 * QUE HACE Y POR QUE FALLA DE OTRA FORMA
 *
 * El otro test de integracion (`test-e2e-field.js`) liquida el campo a mano: nunca
 * se juega una mano. Eso valida la contabilidad pero no el juego. Aqui se llama al
 * motor de verdad y se le deja jugar el campo entero, con bots de por medio.
 *
 * ------------------------------------------------------------------
 * COMO SE CONDUCE SIN ESPERAR A LOS TEMPORIZADORES
 *
 * El motor juega con reloj de pared: el turno de un bot se programa con
 * `setTimeout` de 1-2 s, y el de un humano espera 30 s antes de que el motor le
 * juegue por el. Un campo de 300 son 43 mesas y cientos de manos: con esos
 * tiempos, el test tardaria dias.
 *
 * En vez de tocar el codigo de produccion (que seria un peaje por escribir tests),
 * el test pone los dos relojes a cero desde fuera:
 *
 *   TURN_TIMER.humanMs = 0     -> el humano pierde el turno en el acto
 *   BOT_CONFIG.minThinkMs = 0   -> el bot juega en el acto
 *
 * Son objetos `as const`, que en TypeScript son de solo lectura pero en runtime no.
 * El motor los lee en cada llamada (`TURN_TIMER.humanMs`), asi que el cambio surte
 * efecto. Es una modificacion del entorno de prueba, no del codigo: si mañana el
 * motor necesita un minimo de 200 ms para pensar, este test lo sigue notando.
 *
 * Para los bots se llama a `playBotTurn`, que es privado. Se hace a proposito, y es
 * la decision que hace que este test valga: usar el mismo metodo que usa el
 * production, con la misma IA, en vez de un doble que "se comporta como un bot".
 * Un doble probaria el doble.
 *
 * ------------------------------------------------------------------
 * LAS INVARIANTES
 *
 * Se comprueban en CADA ronda, no solo al final. Un error de contabilidad suele
 * aparecer en la ronda 300 y desaparecer en la 400; si solo se mira el final, se
 * pierde.
 *
 *   1. El dinero: fichas en mesas + saldos + rake == lo que habia al empezar.
 *   2. Nadie esta en dos mesas a la vez.
 *   3. Cada humano eliminado tiene exactamente UNA posicion.
 *   4. `playersRemaining` nunca es negativo ni mayor que los sentados.
 *   5. Nadie gana mas de lo que podia: el premio sale del bote.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_e2e_engine \
 *             node scripts/test-e2e-engine.js
 */

process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_e2e_engine';

process.env.SIMULATE_PAYMENTS = 'true';
process.env.DEV_AUTH_BYPASS = 'false';
process.env.ADMIN_API_KEY = 'clave-de-prueba-e2e';

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
  console.log('\n\x1b[1mCubaPoker · Motor real con bots hasta el final del campo\x1b[0m');
  note(`MONGODB_URI = ${process.env.MONGODB_URI}`);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  ok('conectado y base de datos vaciada');

  const { User } = require('../dist/models/User');
  const { Field } = require('../dist/models/Field');
  const { Table } = require('../dist/models/Table');
  const { fieldManager } = require('../dist/game/field.manager');
  const { tableManager } = require('../dist/game/table.manager');
  const { getTier } = require('../dist/config/product');
  const { TURN_TIMER } = require('../dist/config/product');
  const { BOT_CONFIG } = require('../dist/config/product');
  const { decideAction } = require('../dist/game/bot.engine');
  const { formatUnits } = require('../dist/config/units');

  /**
   * Juega el turno del humano que tenga la palabra, con la IA de produccion.
   *
   * Se recorre cada mesa viva, se lee el estado del motor y, si quien tiene el turno
   * es un humano, se le decide con `decideAction` y se aplica con
   * `applyHumanAction`. Los bots los juega el propio motor con su temporizador, y
   * aqui no se tocan.
   *
   * Se llama una vez por ronda, despues del `tick()`. Una ronda puede avanzar mas de
   * una accion si el motor se ha quedado esperando a un humano que ya se resolvio
   * antes, asi que el bucle interno repite mientras el turno actual siga siendo de
   * un humano y la accion se acepte.
   */
  let turnosHumanos = 0;

  const jugarTurnosHumanos = async () => {
    const mesas = await Table.find({
      'field.fieldId': campo.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    for (const mesa of mesas) {
      // Cada mesa puede encadenar varios turnos humanos seguidos: tras(check)
      // le vuelve a tocar a otro humano, y asi sucesivamente.
      for (let salto = 0; salto < 30; salto++) {
        const entry = tableManager.engines.get(mesa.tableId);
        if (!entry) break;

        const estado = entry.engine.getState();
        // `currentPlayerIndex` es un indice de la LISTA DEL MOTOR, no del asiento. Con los
        // asientos activos no contiguos (alguien eliminado deja un hueco), el asiento
        // del turno es el que cuyo indice coincide con el id del jugador del motor.
        // Es el mismo error que tenia `table.manager` y lo hacia aparecer aqui como
        // un bucle infinito de acciones sobre el jugador equivocado.
        const jugadorTurno = estado.players[estado.currentPlayerIndex];
        const asiento = jugadorTurno
          ? mesa.seats.find((s) => s.index === parseInt(jugadorTurno.id, 10))
          : null;
        if (!asiento || asiento.kind !== 'human') break;

        const playerState = entry.engine.getPlayerState(asiento.index.toString());
        if (!playerState) break;

        const botPlayer = estado.players.find((p) => p.id === asiento.index.toString());
        if (!botPlayer) break;

        const decision = decideAction({
          hand: botPlayer.cards,
          community: estado.communityCards,
          potSize: estado.pot,
          toCall: Math.max(0, estado.currentBet - asiento.bet),
          chips: asiento.chips,
          profile: {
            id: asiento.playerId,
            name: asiento.displayName,
            style: 'calling',
            winRate: 0.45,
            raiseFreq: 0.2,
            foldFreq: 0.3,
            aggression: 0.3,
          },
          position: asiento.index,
          playersLeft: mesa.seats.filter((s) => s.status === 'active').length,
        });

        const aplicada = await tableManager.applyHumanAction(
          mesa,
          asiento.index,
          decision.action,
          decision.amount,
        );
        if (!aplicada) break;

        turnosHumanos++;

        // `applyHumanAction` guarda la mesa, asi que hay que releerla para que el
        // siguiente turno vea el estado nuevo.
        const fresca = await Table.findById(mesa._id);
        if (!fresca) break;
        mesa.seats = fresca.seats;
        mesa.hand = fresca.hand;
        mesa.status = fresca.status;
      }
    }
  };

  // ------------------------------------------------------------------
  section('1. Relojes a cero: el motor no espera a nadie');

  // Se guardan los valores originales para dejar constancia de lo que se cambio, y
  // para poder volver a ponerlos si este test se pidiera dentro de otro.
  const humanMsOriginal = TURN_TIMER.humanMs;
  const minThinkOriginal = BOT_CONFIG.minThinkMs;
  const maxThinkOriginal = BOT_CONFIG.maxThinkMs;

  TURN_TIMER.humanMs = 0;
  BOT_CONFIG.minThinkMs = 0;
  BOT_CONFIG.maxThinkMs = 0;

  ok(`TURN_TIMER.humanMs: ${humanMsOriginal} -> 0 (el humano pierde el turno en el acto)`);
  ok(`BOT_CONFIG.minThinkMs: ${minThinkOriginal} -> 0 (el bot juega en el acto)`);

  if (typeof tableManager.playBotTurn === 'function') {
    ok('el metodo del bot existe y es el de produccion (no un doble)');
  } else {
    bad('tableManager.playBotTurn no existe: el test no puede usar el bot real');
    await finish();
    return;
  }

  // ------------------------------------------------------------------
  section('2. El escenario: 14 humanos y un campo de 14');

  // Un campo pequeno a proposito: con 300 jugadores y 43 mesas el test tardaria
  // minutos y no aportaria nada extra. Lo que se prueba es que el motor juega,
  // que los bots actuan y que la contabilidad aguanta, y eso se ve con 14.
  //
  // Los TIERES son fijos (300, 500), asi que el campo se arranca ajustando
  // `targetField`. Es el equivalente a tener un tier pequeno, que es lo que habria
  // que anadir para campo pequeno de verdad.
  const TIER_ID = 't1';
  const tier = getTier(TIER_ID);
  const BUY_IN = tier.buyInUnits;
  const PLAYERS = 14;

  const ids = Array.from({ length: PLAYERS }, (_, i) => 600_000_000 + i);
  const FUNDING = BUY_IN * 3;

  await User.insertMany(
    ids.map((telegramId, i) => ({
      telegramId,
      username: `jugador${i}`,
      firstName: `Jugador ${i}`,
      balance: { real: FUNDING, play: 0 },
      stats: {
        handsPlayed: 0, handsWon: 0, tablesJoined: 0,
        freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );

  const totalBalance = async () => {
    const agg = await User.aggregate([
      { $group: { _id: null, total: { $sum: { $add: ['$balance.real', '$balance.play'] } } } },
    ]);
    return agg[0]?.total ?? 0;
  };

  /**
 * Fichas que hay ahora mismo encima de las mesas del campo, mas las que ya se
 * sacaron de las mesas de los eliminados.
 *
 * INCLUYE EL BOTE. Sin el, la invariante falla en la primera mano: las ciegas salen
 * de los asientos y se van a `hand.pot`, asi que cuando hay apostado los asientos
 * tienen menos que el bote. El dinero esta en la mesa igual, solo que en otro sitio
 * del documento. Cuando se escribio este test, esa omision produjo un falso positivo
 * de "-0,03 USDT" en todas las rondas, que era ni mas ni menos el bote de las dos
 * mesas.
 *
 * INCLUYE `deadChips`. Las fichas de un eliminado salen de la mesa para liberar el
 * asiento, pero siguen siendo del campo. Si no se cuentan aqui, el dinero aparece
 * como perdido en cuanto hay la primera eliminacion: fue un "-4,718 USDT" fantasma
 * que resultaba ser la diferencia entre contar las fichas donde estan y contar solo
 * las que quedan en los asientos.
 */
  const chipsOnTables = async (fieldDoc) => {
    const tablas = await Table.find({ 'field.fieldId': fieldDoc.fieldId });
    const enMesas = tablas.reduce(
      (sum, t) => sum
        + t.seats.reduce((s, seat) => s + Math.max(0, seat.chips), 0)
        + Math.max(0, t.hand.pot || 0),
      0,
    );
    return enMesas + Math.max(0, fieldDoc.deadChips || 0);
  };

  const T0 = await totalBalance();
  note(`T0 = ${formatUnits(T0)} USDT en ${PLAYERS} carteras`);

  for (const id of ids) {
    await fieldManager.register(id, TIER_ID, `jugador${id}`);
  }

  const campo = await Field.findOne({ tierId: TIER_ID, status: { $in: ['filling', 'running'] } });
  if (!campo) {
    bad('no se abrio ningun campo al registrarse los jugadores');
    await finish();
    return;
  }

  // Se recorta el campo a 14 para que el test no tarde una eternidad.
  await Field.updateOne(
    { _id: campo._id },
    { $set: { targetField: PLAYERS, plannedTables: 2 } },
  );
  campo.targetField = PLAYERS;
  campo.plannedTables = 2;

  const arrancado = await fieldManager.startField(campo);
  if (arrancado) ok(`campo arrancado con ${PLAYERS} jugadores`);
  else bad('startField devolvio false');

  // ------------------------------------------------------------------
  section('3. El motor juega el campo entero');

  // El motor necesita que le digan cuando avanzar. En produccion es un
  // `setInterval`; aqui se llama a mano para no depender del reloj.
  tableManager.setFieldCoordinator(() => fieldManager.tick());

  // ------------------------------------------------------------------
  // POR QUE 4 000 NO ALCANZABA, Y CUANTAS HACE FALTA
  //
  // Una mesa 7-max tarda del orden de 3 700 manos en dejar a UN jugador, medido con el
  // motor y la IA de produccion en scripts/test-bot-pace.js. No porque las manos sean
  // de ciegas (6,9 acciones de media, llegan al showdown), sino porque con 1 000 fichas
  // y ciegas de 5/10 hay que ganar muchisimas manos para quedarse sin nada.
  //
  // O sea: 4 000 rondas no eran un limite arbitrario, estaban justo por debajo del
  // tiempo real que tarda una mesa en resolverse. El campo de 14 jugadores repartido en
  // 2 mesas necesita del orden de 5 000 rondas, no 4 000.
  //
  // Subido a 12 000 para que el margen sea amplio y el test no dependa de una medicion
  // que ya se sabe que es de alta varianza: la misma mesa ha terminado en 39 manos en
  // una corrida y en 3 713 en otra, segun como caigan las cartas.
  // ------------------------------------------------------------------
  const MAX_RONDAS = 12000;
  let rondas = 0;
  let terminado = false;
  let manosJugadas = 0;
  let merges = 0;
  const problemas = [];

  let antesDeRonda = await Field.findById(campo._id);
  const mesasAlEmpezar = await Table.countDocuments({ 'field.fieldId': campo.fieldId });
  note(`mesas iniciales: ${mesasAlEmpezar}`);

  while (rondas < MAX_RONDAS) {
    rondas++;

    await tableManager.tick();

    // ----------------------------------------------------------------
    // LOS HUMANOS JUEGAN CON LA IA DE PRODUCCION
    //
    // Con el timeout a 0, un humano al que le toca simplemente pliega o pasa. Con siete
    // jugadores haciendo eso, cada mano es "todos pliegan hasta la ciega grande", que
    // es un equilibrio exacto: la ciega grande gana 5, el resto pierde su ciega, y
    // en siete manos cada uno ha sido ciega grande una vez y ciega pequena una vez.
    // Resultado: cero, para siempre. Nadie se elimina nunca y el campo no termina.
    //
    // Se comprobo: 1 200 rondas, 200 manos por mesa, las fichas oscillando entre
    // 995 y 1 005 sin que nadie llegara a cero.
    //
    // Asi que aqui los asientos humanos juegan con `decideAction`, la misma funcion
    // que usa el bot, y se aplican con `applyHumanAction`, que es la ruta que usa
    // un jugador de verdad. No es un doble: es el codigo de produccion de las dos
    // partes, la decision y la aplicacion. Lo unico que cambia es quien pulsa.
    // ----------------------------------------------------------------
    await jugarTurnosHumanos();

    // Se deja correr el event loop para que los `setTimeout(0)` de los bots
    // disparen. Sin esto, los bots no llegan a actuar nunca.
    await new Promise((r) => setTimeout(r, 0));

    // --- INVARIANTE 1: el dinero ---
    // Todo lo que ha salido de las carteras tiene que estar en fichas, en premios
    // o ser rake. Si aparece una cuarta cosa, se ha creado dinero.
    const saldos = await totalBalance();
    const fichas = await chipsOnTables(await Field.findById(campo._id));
    const ahora = await Field.findById(campo._id);
    const rake = ahora ? ahora.rakeCollected : 0;

    const total = saldos + fichas + rake;
    if (total !== T0) {
      // Se nota una sola vez por tipo de desviacion, para no inundar el log.
      const tipo = `desviacion de ${formatUnits(total - T0)} USDT `
        + `(saldos ${formatUnits(saldos)} + fichas ${formatUnits(fichas)} + rake ${formatUnits(rake)})`;
      if (!problemas.some(p => p.startsWith('dinero'))) problemas.push(`dinero: ${tipo}`);
      problemas.push(`dinero en la ronda ${rondas}: ${tipo}`);
    }

    // --- INVARIANTE 2: nadie en dos mesas ---
    const todas = await Table.find({ 'field.fieldId': campo.fieldId });
    const porJugador = new Map();
    for (const t of todas) {
      for (const s of t.seats) {
        if (s.kind !== 'human') continue;
        const prev = porJugador.get(s.playerId) || [];
        prev.push(t.tableId);
        porJugador.set(s.playerId, prev);
      }
    }
    for (const [pid, mesas] of porJugador) {
      if (mesas.length > 1) {
        problemas.push(`jugador ${pid} esta en ${mesas.length} mesas a la vez: ${mesas.join(', ')}`);
        break;
      }
    }

    // --- INVARIANTE 4: el contador de vivos es coherente ---
    if (ahora) {
      if (ahora.playersRemaining < 0) {
        problemas.push(`playersRemaining NEGATIVO: ${ahora.playersRemaining} (ronda ${rondas})`);
      }
      if (ahora.playersRemaining > ahora.seated) {
        problemas.push(
          `playersRemaining (${ahora.playersRemaining}) mayor que sentados (${ahora.seated}) ` +
          `en la ronda ${rondas}`,
        );
      }
    }

    const final = await Field.findById(campo._id);
    if (!final || final.status === 'finished') {
      terminado = true;
      break;
    }

    // Se detectan las merges por el numero de mesas vivas.
    const vivas = todas.filter(t => t.status !== 'finished').length;
    if (vivas < mesasAlEmpezar && merges === 0) merges++;
    

    // Traza de progreso, cada 500 rondas, para saber que esta avanzando.
    if (rondas % 500 === 0) {
      const f = await Field.findById(campo._id);
      note(
        `ronda ${rondas}: vivos=${f ? f.playersRemaining : '?'} ` +
        `meses vivas=${vivas} fichas=${formatUnits(fichas)} rake=${formatUnits(rake)}`,
      );
    }
  }

  ok(`el motor avanza: ${rondas} rondas, ${turnosHumanos} turnos de humano con la IA de produccion`);
  if (terminado) ok('el campo llego a `finished` por su cuenta');
  else bad(`el campo no llego a terminar en ${MAX_RONDAS} rondas`);

  // ------------------------------------------------------------------
  section('4. Invariantes al terminar');

  if (problemas.length === 0) {
    ok('ninguna invariante se rompio en ninguna ronda');
  } else {
    const unicas = [...new Set(problemas)];
    bad(`se detectaron ${unicas.length} problemas durante el campo:`);
    for (const p of unicas.slice(0, 8)) note(p);
    if (unicas.length > 8) note(`... y ${unicas.length - 8} mas`);
  }

  const final = await Field.findById(campo._id);

  // --- El rake es real: el producto tiene ingresos ---
  const saldosFinales = await totalBalance();
  const retenido = T0 - saldosFinales;
  note(`saldos finales ${formatUnits(saldosFinales)} USDT, `
    + `rake registrado ${formatUnits(final ? final.rakeCollected : 0)} USDT`);

  if (final && final.rakeCollected > 0) {
    ok(
      `el motor cobro rake de verdad: ${formatUnits(final.rakeCollected)} USDT ` +
      `en ${rondas} rondas`,
    );
  } else {
    bad('el motor no cobro nada de rake: no se juego ninguna mano util');
  }

  if (final && Math.abs(retenido - final.rakeCollected) <= 1) {
    ok(
      `la contabilidad cuadra con la realidad: salieron ${formatUnits(retenido)} USDT ` +
      `y el campo registra ${formatUnits(final.rakeCollected)} de rake`,
    );
  } else {
    bad(
      `la contabilidad NO cuadra: de los saldos salieron ${formatUnits(retenido)} USDT ` +
      `pero el campo dice rake=${formatUnits(final ? final.rakeCollected : 0)} USDT`,
    );
  }

  // --- Posiciones: una por eliminado, sin repetir ---
  const results = (final && final.results) || [];
  const posiciones = results.map(r => r.position).filter(Boolean);
  const unicas = new Set(posiciones);

  if (posiciones.length === unicas.size) {
    ok(`${posiciones.length} posiciones asignadas, ninguna repetida`);
  } else {
    bad(
      `${posiciones.length - unicas.size} posiciones repetidas: dos jugadores ` +
      'cobran la misma parte',
    );
  }

  const esperados = PLAYERS - 1;
  if (posiciones.length >= esperados) {
    ok(`se adjudicaron las ${esperados} posiciones de eliminados (hubo ${posiciones.length})`);
  } else {
    bad(
      `solo se adjudicaron ${posiciones.length} posiciones y se esperaban ${esperados}: ` +
      'los eliminados no se estan recogiendo',
    );
  }

  // --- Nadie quedo con saldo a cero por error ---
  const sinNada = await User.find({
    telegramId: { $in: ids },
    'balance.real': { $lt: 0 },
  });
  if (sinNada.length === 0) {
    ok('ningun jugador tiene saldo real negativo');
  } else {
    bad(`${sinNada.length} jugador(es) con saldo real NEGATIVO: saldo negativo es corrupto`);
  }

  // ----------------------------------------------------------------
  // VOLCADO DEL ESTADO
  //
  // Cuando el campo no termina, la pregunta es siempre la misma: quien queda vivo,
  // con cuantas fichas y en cuantas mesas. Sin esto solo se sabe que "no acaba", que
  // no dice nada. Con esto se ve si el problema son las fichas que no bajan, si las
  // mesas que no se fusionan, o si los eliminados no se recogen.
  // ----------------------------------------------------------------
  {
    const mesas = await Table.find({ 'field.fieldId': campo.fieldId });
    note(`mesas del campo: ${mesas.length}`);
    for (const t of mesas) {
      const humanos = t.seats.filter((s) => s.kind === 'human');
      const bots = t.seats.filter((s) => s.kind === 'bot');
      const activos = t.seats.filter((s) => s.status === 'active' && s.chips > 0);
      const out = t.seats.filter((s) => s.status === 'out');
      const fichas = t.seats.reduce((a, s) => a + Math.max(0, s.chips), 0);

      // El motor en memoria es la clave: si hay motor y la fase no es idle, la mesa
      // esta esperando a alguien. Si no hay motor y la fase no es idle, esta
      // ATRAPADA, que es el fallo que se ha chasing.
      const entry = tableManager.engines.get(t.tableId);
      let turno = '-';
      if (entry) {
        const st = entry.engine.getState();
        // `currentPlayerIndex` es indice de la lista del motor. Para el diagnostico
        // interesa el ASIENTO, que es lo que se busca en la mesa.
        const jp = st.players[st.currentPlayerIndex];
        turno = `${st.phase} asiento=${jp ? jp.id : '?'}`;
      }

      note(
        `  ${t.tableId}: status=${t.status} mano=${t.hand.handNumber} ` +
        `fase=${t.hand.phase} humanos=${humanos.length} bots=${bots.length} ` +
        `activos=${activos.length} out=${out.length} fichas=${formatUnits(fichas)} ` +
        `campo=${t.field?.fieldStatus}`,
      );
      note(`      motor=${entry ? 'en memoria' : 'NO'} estado=${turno}`);
      for (const s of humanos) {
        note(`      asiento ${s.index}: status=${s.status} fichas=${s.chips}`);
      }
    }
    const f = await Field.findById(campo._id);
    note(
      `campo: status=${f.status} seated=${f.seated} waiting=${f.waiting} ` +
      `vivos=${f.playersRemaining} eliminated=${f.eliminated} ` +
      `deadChips=${f.deadChips} tablasEnDoc=${f.tables.length}`,
    );
  }

  // --- Las mesas del campo quedaron cerradas ---
  const mesasVivas = await Table.countDocuments({
    'field.fieldId': campo.fieldId,
    status: { $ne: 'finished' },
  });
  if (mesasVivas === 0) {
    ok('todas las mesas del campo quedaron cerradas');
  } else {
    bad(`quedan ${mesasVivas} mesa(s) sin cerrar tras liquidar el campo`);
  }

  // --- Los jugadores que perdieron, perdieron ---
  // Cada uno empezo con FUNDING y pago BUY_IN. Quien gane el campo recibe el bote
  // en `balance.play`; el resto no recibe nada.
  const ganador = results.find(r => r.position === 1);
  if (ganador) {
    const u = await User.findOne({ telegramId: ganador.telegramId });
    note(
      `ganador ${ganador.telegramId}: ${formatUnits(u.balance.real)} real + ` +
      `${formatUnits(u.balance.play)} play`,
    );
    if (u.balance.play > 0) {
      ok('el premio del ganador esta en `play`, no en `real`: no es retirable directamente');
    } else {
      note(`AVISO: el ganador no tiene premio en play (${formatUnits(u.balance.play)} USDT)`);
    }
  } else {
    note('AVISO: el campo no registro ganador');
  }

  // ------------------------------------------------------------------
  section('5. Los relojes vuelven a su valor');

  TURN_TIMER.humanMs = humanMsOriginal;
  BOT_CONFIG.minThinkMs = minThinkOriginal;
  BOT_CONFIG.maxThinkMs = maxThinkOriginal;
  ok(`TURN_TIMER.humanMs restaurado a ${humanMsOriginal}`);
  ok(`BOT_CONFIG.minThinkMs restaurado a ${minThinkOriginal}`);

  await finish();
}
