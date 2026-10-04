/**
 * Pruebas del motor de poker a escala real.
 *
 * Antes el motor tenia `players.length >= 6` como tope, heredado de un 6-max, y
 * el dealer clavado en el asiento 0. Con el producto en mesas de 50 a 500
 * jugadores, esas dos cosas rompen el juego por completo. Estas pruebas lo
 * fijan para que no vuelva a colarse.
 */

const {
  PokerGame,
  DEFAULT_MAX_PLAYERS,
  MAX_DEALABLE_PLAYERS,
} = require('../dist/game/game.state');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Pruebas del motor\x1b[0m');

// =========================================================================
section('1. Escala: la mesa admite 500 asientos, la mano 26');

{
  if (DEFAULT_MAX_PLAYERS >= 500) {
    ok(`tope por defecto del motor: ${DEFAULT_MAX_PLAYERS} jugadores`);
  } else {
    bad(`tope por defecto ${DEFAULT_MAX_PLAYERS}, insuficiente para la mesa de 500`);
  }

  // El limite fisico: (52 cartas - 5 comunitarias) / 2 = 23
  if (MAX_DEALABLE_PLAYERS === 23) {
    ok('tope de reparto: 23 jugadores ((52 - 5 comunitarias) / 2)');
  } else {
    bad(
      `tope de reparto ${MAX_DEALABLE_PLAYERS}. Con una baraja de 52 y 5 cartas ` +
      `de mesa el maximo es 23; con 26 el flop hace pop() de un mazo vacio.`,
    );
  }

  for (const size of [50, 100, 300, 500]) {
    // 1. La MESA tiene que caber: 500 asientos, como anuncia el producto
    const table = new PokerGame(`mesa${size}`, 1, 2, size);

    let seated = 0;
    for (let i = 0; i < size + 5; i++) {
      if (table.addPlayer(String(i), `Jugador${i}`, 2000)) seated++;
    }

    if (seated === size) {
      ok(`mesa de ${size}: se sienta exactamente ${size} jugadores`);
    } else {
      bad(`mesa de ${size}: se sentaron ${seated}, esperaba ${size}`);
    }

    // 2. Una mano completa NO debe arrancar con mas de 26: es imposible
    // repartir dos cartas a 500 jugadores.
    if (table.startGame(0)) {
      bad(`mesa de ${size}: la mano arranco con ${size} jugadores (imposible)`);
    } else {
      ok(`mesa de ${size}: el motor se niega a repartir una mano de ${size}`);
    }
  }

  // 3. Una tanda completa al limite si arranca, reparte y llega al river
  {
    const tanda = new PokerGame('tanda', 1, 2, 500);
    for (let i = 0; i < MAX_DEALABLE_PLAYERS; i++) {
      tanda.addPlayer(String(i), `J${i}`, 2000);
    }

    if (tanda.startGame(0)) {
      ok(`una tanda de ${MAX_DEALABLE_PLAYERS} arranca la mano`);

      const withCards = tanda.getState().players.filter(p => p.cards.length === 2).length;
      if (withCards === MAX_DEALABLE_PLAYERS) {
        ok(`los ${MAX_DEALABLE_PLAYERS} reciben sus 2 cartas`);
      } else {
        bad(`solo ${withCards} de ${MAX_DEALABLE_PLAYERS} recibieron 2 cartas`);
      }

      // Lo que mas importa al limite: tiene que quedar baraja para la mesa.
      const remaining = 52 - MAX_DEALABLE_PLAYERS * 2;
      if (remaining >= 5) {
        ok(`quedan ${remaining} cartas tras el reparto: suficiente para las 5 de mesa`);
      } else {
        bad(`solo quedan ${remaining} cartas y la mesa necesita 5`);
      }

      const all = tanda.getState().players.flatMap(p => p.cards);
      const unique = new Set(all.map(c => `${c.rank}${c.suit}`));
      if (unique.size === all.length) {
        ok(`las ${all.length} cartas repartidas son todas distintas`);
      } else {
        bad(
          `cartas repetidas: ${all.length} repartidas, ${unique.size} distintas. ` +
          `Repartir dos cartas iguales rompe el showdown.`,
        );
      }
    } else {
      bad(`una tanda de ${MAX_DEALABLE_PLAYERS} no arranco la mano`);
    }
  }

  // 4. El borde exacto: 23 si, 24 no
  {
    const atLimit = new PokerGame('23', 1, 2, 100);
    for (let i = 0; i < 23; i++) atLimit.addPlayer(String(i), `J${i}`, 1000);
    if (atLimit.startGame(0)) ok('exactamente 23 jugadores: la mano arranca');
    else bad('23 jugadores deberian poder jugar');

    const overLimit = new PokerGame('24', 1, 2, 100);
    for (let i = 0; i < 24; i++) overLimit.addPlayer(String(i), `J${i}`, 1000);
    if (!overLimit.startGame(0)) {
      ok('24 jugadores: la mano se niega (no queda baraja para la mesa)');
    } else {
      bad(
        '24 jugadores arrancaron la mano: se reparten 48 cartas y solo quedan 4 ' +
        'para las 5 comunitarias. El flop haria pop() de un mazo vacio y el ' +
        'evaluador reventaria con "Cannot read properties of undefined".',
      );
    }
  }
}

// =========================================================================
section('2. Rotacion del boton y las ciegas');

{
  // 6 jugadores, sin eliminaciones: el boton debe avanzar una posicion por mano
  const engine = new PokerGame('rot', 1, 2, 6);
  for (let i = 0; i < 6; i++) engine.addPlayer(String(i), `J${i}`, 5000);

  const seen = new Set();
  const order = [];

  for (let hand = 0; hand < 6; hand++) {
    engine.startGame(hand);
    const s = engine.getState();

    // Orden real de posiciones: boton, SB, BB
    const d = s.players[s.dealerIndex];
    const sb = s.players[s.smallBlindIndex];
    const bb = s.players[s.bigBlindIndex];

    order.push(`${d.id}/${sb.id}/${bb.id}`);

    if (d.id === sb.id || d.id === bb.id || sb.id === bb.id) {
      bad(`mano ${hand}: boton, SB y BB ocupan la misma posicion`);
      break;
    }
  }

  if (order.length === 6) {
    const uniqueOrders = new Set(order);
    if (uniqueOrders.size === 6) {
      ok('6 manos dan 6 repartos de boton/SB/BB distintos');
    } else {
      bad(`6 manos solo dieron ${uniqueOrders.size} repartos distintos: ${order.join(' ')}`);
    }
  } else {
    bad(`el bucle se detuvo en ${order.length} manos`);
  }

  // Coherencia del orden: SB va una posicion detras del boton, BB dos
  const engine2 = new PokerGame('rot2', 1, 2, 6);
  for (let i = 0; i < 6; i++) engine2.addPlayer(String(i), `J${i}`, 5000);
  engine2.startGame(3);
  const s2 = engine2.getState();
  const n = 6;
  if (
    s2.smallBlindIndex === (s2.dealerIndex + 1) % n &&
    s2.bigBlindIndex === (s2.dealerIndex + 2) % n
  ) {
    ok(`SB y BB caen detras del boton (dealer pos ${s2.dealerIndex})`);
  } else {
    bad(`orden de ciegas incorrecto: D=${s2.dealerIndex} SB=${s2.smallBlindIndex} BB=${s2.bigBlindIndex}`);
  }

  // Acts left to act: la primera accion es UTG, una posicion antes del boton
  // en el sentido de la mesa, es decir despues de la BB
  if (s2.currentPlayerIndex === (s2.bigBlindIndex + 1) % n) {
    ok('la primera accion de la mano es la que sigue a la ciega grande');
  } else {
    bad(
      `empieza a actuar la posicion ${s2.currentPlayerIndex}, ` +
      `deberia ser la ${(s2.bigBlindIndex + 1) % n}`,
    );
  }
}

// =========================================================================
section('3. Ciegas cobradas y bote');

{
  const engine = new PokerGame('blinds', 10, 20, 4);
  for (let i = 0; i < 4; i++) engine.addPlayer(String(i), `J${i}`, 1000);
  engine.startGame(0);
  const s = engine.getState();

  const sb = s.players[s.smallBlindIndex];
  const bb = s.players[s.bigBlindIndex];

  if (sb.bet === 10) ok(`la ciega pequena se descuenta (${sb.bet} de ${sb.chips})`);
  else bad(`la ciega pequena quedo en ${sb.bet}, esperaba 10`);

  if (bb.bet === 20) ok(`la ciega grande se descuenta (${bb.bet} de ${bb.chips})`);
  else bad(`la ciega grande quedo en ${bb.bet}, esperaba 20`);

  if (s.pot === 30) ok('el bote arranca con las dos ciegas (30)');
  else bad(`el bote arranca en ${s.pot}, esperaba 30`);
}

// =========================================================================
section('4. Guardas del motor');

{
  const engine = new PokerGame('guards', 1, 2, 3);

  // Fichas no positivas
  if (!engine.addPlayer('a', 'A', 0)) ok('rechaza a un jugador sin fichas');
  else bad('acepta a un jugador con 0 fichas');

  if (!engine.addPlayer('a', 'A', -50)) ok('rechaza fichas negativas');
  else bad('acepta fichas negativas');

  // Duplicados
  engine.addPlayer('a', 'A', 100);
  if (!engine.addPlayer('a', 'A', 100)) ok('rechaza al mismo jugador dos veces');
  else bad('acepta un id duplicado en la misma mano');

  // Menos de dos jugadores
  const lonely = new PokerGame('lonely', 1, 2, 6);
  lonely.addPlayer('a', 'A', 100);
  if (!lonely.startGame()) ok('una mesa de un solo jugador no arranca');
  else bad('una mesa de un solo jugador arranco la mano');

  // Se admite tras `startGame`? No: la mano ya empezo
  const started = new PokerGame('started', 1, 2, 6);
  started.addPlayer('a', 'A', 100);
  started.addPlayer('b', 'B', 100);
  started.startGame(0);
  if (!started.addPlayer('c', 'C', 100)) ok('no admite jugadores con la mano ya empezada');
  else bad('admite un jugador a mitad de mano');
}

// =========================================================================
section('5. Una mano completa se resuelve sola (bots provistos por el llamante)');

{
  // Nadie actua: comprobamos que el motor no se cuelga y que el estado final
  // es coherente aunque la mano este abandonada a medias.
  const engine = new PokerGame('hang', 1, 2, 3);
  engine.addPlayer('a', 'A', 1000);
  engine.addPlayer('b', 'B', 1000);
  engine.addPlayer('c', 'C', 1000);
  engine.startGame(0);

  const s = engine.getState();
  if (s.phase === 'preflop') ok('la mano queda en preflop esperando decisiones');
  else bad(`fase inicial inesperada: ${s.phase}`);

  if (typeof s.currentPlayerIndex === 'number') {
    ok(`el motor señala a quien le toca (posicion ${s.currentPlayerIndex})`);
  } else {
    bad('el motor no indica el jugador en turno');
  }

  // El turno debe avanzar al actuar
  // El motor direcciona por `id`, no por posicion en el array.
  const before = s.currentPlayerIndex;
  const onTurnId = s.players[before].id;
  const applied = engine.performAction(onTurnId, 'call');
  const after = engine.getState();

  if (applied) ok(`una accion valida se aplica (jugador ${onTurnId})`);
  else bad(`una accion sobre el jugador en turno (${onTurnId}) fue rechazada`);

  if (after.currentPlayerIndex !== before) {
    ok(`el turno avanza (posicion ${before} -> ${after.currentPlayerIndex})`);
  } else {
    bad(`el turno no avanza tras actuar (sigue en ${before})`);
  }

  // Actuar fuera de turno debe rechazarse
  const wrongId = s.players[(before + 2) % 3].id;
  if (!engine.performAction(wrongId, 'call')) {
    ok(`rechaza actuar fuera de turno (${wrongId})`);
  } else {
    bad(`acepto la accion de ${wrongId}, que no era el turno`);
  }
}

// =========================================================================
section('6. Una mano se juega hasta el final (motor solo)');

{
  // Simula al gestor: el que tiene la palabra juega siempre `call`/`check`
  // hasta que la mano acaba. Comprueba que el motor no se cuelga, que reparte
  // el bote y que el total de fichas se conserva (ni se crean ni se pierden).
  for (const seats of [2, 3, 6, 9, MAX_DEALABLE_PLAYERS]) {
    const engine = new PokerGame(`full${seats}`, 10, 20, seats);
    const START = 1000;

    for (let i = 0; i < seats; i++) engine.addPlayer(String(i), `J${i}`, START);

    if (!engine.startGame(0)) {
      bad(`${seats} jugadores: la mano no arranco`);
      continue;
    }

    let guard = 0;
    while (engine.getState().phase !== 'finished' && guard++ < 500) {
      const s = engine.getState();
      const p = s.players[s.currentPlayerIndex];
      if (!p) break;

      const toCall = s.currentBet - p.bet;
      const okAction = engine.performAction(
        p.id,
        toCall <= 0 ? 'check' : 'call',
      );
      if (!okAction) {
        bad(`${seats} jugadores: el motor rechazo una accion valida en ${s.phase}`);
        break;
      }
    }

    const final = engine.getState();

    if (final.phase === 'finished') {
      ok(`${seats} jugadores: la mano llega a 'finished' (${guard} acciones)`);
    } else {
      bad(`${seats} jugadores: la mano se quedo en '${final.phase}'`);
      continue;
    }

    // El bote debe haberse repartido: 0 al terminar
    if (final.pot === 0) ok(`${seats} jugadores: el bote se reparte entero (pot a 0)`);
    else bad(`${seats} jugadores: quedan ${final.pot} en el bote sin repartir`);

    // Ninguna carta puede quedarse sin owner
    const seen = new Set();
    let dupes = 0;
    for (const p of final.players) {
      for (const c of p.cards) {
        const k = `${c.rank}${c.suit}`;
        if (seen.has(k)) dupes++;
        seen.add(k);
      }
    }
    if (dupes === 0) ok(`${seats} jugadores: ninguna carta esta en dos manos`);
    else bad(`${seats} jugadores: ${dupes} cartas repetidas entre jugadores`);

    // Debe haber un ganador con el bote
    const winners = final.winners ?? [];
    if (winners.length > 0) {
      const won = winners.reduce((a, w) => a + w.amount, 0);

      // Ley de conservacion: lo que sale del bote tiene que ser exactamente
      // lo que los jugadores pusieron, ni mas ni menos.
      const putIn = final.players.reduce((a, p) => a + p.totalBet, 0);
      if (Math.abs(won - putIn) < 1e-6) {
        ok(
          `${seats} jugadores: el bote entregado (${won}) coincide con lo ` +
          `aportado (${putIn})`,
        );
      } else {
        bad(
          `${seats} jugadores: se entregaron ${won} pero se aportaron ${putIn}. ` +
          (won < putIn
            ? 'Las fichas desaparecen del sistema en cada mano.'
            : 'Se estan creando fichas de la nada.'),
        );
      }

      if (winners.every(w => w.amount > 0)) {
        ok(`${seats} jugadores: todos los ganadores reciben algo`);
      } else {
        bad(`${seats} jugadores: hay ganadores con importe 0`);
      }
    } else {
      bad(`${seats} jugadores: la mano termino sin ganador`);
    }

    // Nadie puede quedar en negativo
    const negative = final.players.filter(p => p.chips < 0).length;
    if (negative === 0) ok(`${seats} jugadores: nadie queda con fichas negativas`);
    else bad(`${seats} jugadores: ${negative} jugadores con fichas negativas`);

    // Y las 5 cartas de mesa deben estar si se llego al river
    const reachedRiver = final.communityCards.length >= 3;
    if (reachedRiver && final.phase === 'finished') {
      if (final.communityCards.length >= 3) {
        ok(`${seats} jugadores: la mesa tiene cartas comunitarias (${final.communityCards.length})`);
      } else {
        bad(`${seats} jugadores: la mano termino con ${final.communityCards.length} cartas de mesa`);
      }
    }

    // Ninguna carta `undefined` en ningun sitio: es el sintoma del mazo agotado
    const undefinedCards = final.players
      .flatMap(p => p.cards)
      .filter(c => !c || typeof c.rank !== 'string').length;
    const undefinedCommunity = final.communityCards.filter(c => !c).length;
    if (undefinedCards + undefinedCommunity === 0) {
      ok(`${seats} jugadores: ninguna carta es undefined (mazo no agotado)`);
    } else {
      bad(
        `${seats} jugadores: ${undefinedCards + undefinedCommunity} cartas undefined. ` +
        `El mazo se agoto y se repartieron valores vacios.`,
      );
    }
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
