/**
 * PRUEBAS DEL CORAZÓN DEL MOTOR
 * =============================
 *
 * Estas pruebas no pasan por Mongo, ni por HTTP, ni por la UI. Prueban las tres
 * piezas que deciden si el dinero de una mano está bien o mal:
 *
 *   1. El evaluador: quién gana, con qué kicker y con qué carta.
 *   2. El runout de all-ins: que se repartan las cinco comunitarias y que los
 *      botes laterales no se los lleve el short stack.
 *   3. El rake: que se cobre sobre el bote igualado, no sobre lo que nadie
 *      igualó, y que el dinero cuadre (bote = premios + rake).
 *
 * Si esta suite falla, no importa que la mesa se vea bonita: hay que parar.
 */

const { PokerGame } = require('../dist/game/game.state');
const { evaluateHand } = require('../dist/game/hand.evaluator');
const { createDeck, shuffleDeck } = require('../dist/game/card.utils');

let pass = 0;
let fail = 0;

const ok = (mensaje) => {
  console.log(`  \x1b[32m✓\x1b[0m ${mensaje}`);
  pass++;
};

const bad = (mensaje, detalle) => {
  console.log(`  \x1b[31m✗\x1b[0m ${mensaje}`);
  if (detalle) console.log(`      ${detalle}`);
  fail++;
};

const check = (condicion, mensaje, detalle) => {
  if (condicion) ok(mensaje);
  else bad(mensaje, detalle);
};

const section = (titulo) => console.log(`\n\x1b[1m${titulo}\x1b[0m`);

// ---------------------------------------------------------------------------
// Utilidades de cartas
// ---------------------------------------------------------------------------

const VALOR = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, J: 11, Q: 12, K: 13, A: 14, T: 10,
};

const carta = (rank, suit) => ({
  rank: String(rank),
  suit,
  value: VALOR[String(rank)] ?? 0,
});

const mano = (texto) => {
  // "As picas, rey corazones..." en notación corta: "As Kd Qh Jc Ts"
  // Se aceptan rangos 2-9, T/10, J, Q, K, A y palos h/d/c/s.
  const palos = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
  return texto.trim().split(/\s+/).map((token) => {
    const rank = token.slice(0, -1);
    const suit = palos[token.slice(-1)];
    if (!suit) throw new Error(`Palo inválido en ${token}`);
    return carta(rank === 'T' ? '10' : rank, suit);
  });
};

/**
 * Baraja preparada para una mano concreta.
 *
 * `startGame` saca cartas con `pop()`, así que la primera carta que debe salir
 * va al final del array. El orden de reparto es: una carta a cada jugador,
 * vuelta, segunda carta a cada jugador, y después el board.
 */
const barajaPreparada = (secuencia) => {
  const usadas = new Set(secuencia.map((c) => `${c.rank}|${c.suit}`));
  const resto = createDeck().filter((c) => !usadas.has(`${c.rank}|${c.suit}`));
  return [...resto, ...[...secuencia].reverse()];
};

const nuevaMesa = (stacks, ciegas = { sb: 5, bb: 10 }, rake) => {
  const juego = new PokerGame(
    'test-core',
    ciegas.sb,
    ciegas.bb,
    stacks.length,
    rake,
  );
  stacks.forEach((stack, i) => juego.addPlayer(String(i), `Jugador ${i}`, stack));
  return juego;
};

console.log('\n\x1b[1mCubaPoker · Núcleo del motor\x1b[0m');

// ===========================================================================
section('1. Evaluador: rank, kickers, rueda y desempates');

{
  // Rueda A-2-3-4-5. El as vale 1 y la escalera es de cinco alta.
  const rueda = evaluateHand(mano('As 2h 3d 4c 5s 9h Kd'));
  check(
    rueda.rank === 'straight' && rueda.value === evaluateHand(mano('5h 4s 3c 2d As')).value,
    'detecta la rueda A-2-3-4-5 como escalera de cinco alta',
    `rank=${rueda.rank}, value=${rueda.value}`,
  );
  check(
    rueda.bestCards.some((c) => c.rank === 'A') &&
      rueda.bestCards.some((c) => c.rank === '5'),
    'la rueda usa el as como carta baja, no como carta alta',
  );

  // Dos parejas de ases y reyes: el kicker decide.
  const dosParejasDama = evaluateHand(mano('As Ah Kd Kc Qs 3h 2d'));
  const dosParejasDiez = evaluateHand(mano('Ad Ac Kh Ks Ts 3d 2c'));
  check(
    dosParejasDama.rank === 'two_pair' &&
      dosParejasDama.value > dosParejasDiez.value,
    'dos parejas iguales se desempatan por el kicker',
    `${dosParejasDama.value} vs ${dosParejasDiez.value}`,
  );

  // Pareja de ases con K-Q-J contra K-Q-T.
  const parejaJ = evaluateHand(mano('As Ah Kd Qc Js 3h 2d'));
  const parejaT = evaluateHand(mano('Ad Ac Kh Qs Ts 3d 2c'));
  check(
    parejaJ.rank === 'pair' && parejaJ.value > parejaT.value,
    'una pareja se desempata por los tres kickers',
  );

  // Color: la quinta carta decide.
  const colorNueve = evaluateHand(mano('Ah Kh Qh Jh 9h 2c 3d'));
  const colorOcho = evaluateHand(mano('As Ks Qs Js 8s 2d 3c'));
  check(
    colorNueve.rank === 'flush' && colorNueve.value > colorOcho.value,
    'un color se desempata por la quinta carta',
  );

  // Full house: el trío manda antes que la pareja.
  const fullAsRey = evaluateHand(mano('As Ah Ad Ks Kh Qc Jd'));
  const fullAsDama = evaluateHand(mano('Ac Ad Ah Qs Qh Jc Td'));
  check(
    fullAsRey.rank === 'full_house' && fullAsRey.value > fullAsDama.value,
    'full house con trío de ases supera al de ases con pareja de damas',
  );

  // Póker: el kicker decide.
  const pokerK = evaluateHand(mano('9s 9h 9d 9c Ks 2h 3d'));
  const pokerQ = evaluateHand(mano('9s 9h 9d 9c Qs 2h 3d'));
  check(
    pokerK.rank === 'four_of_a_kind' && pokerK.value > pokerQ.value,
    'el kicker decide entre dos pókers del mismo rango',
  );

  // Escalera de color al cinco y escalera real.
  const escaleraColor = evaluateHand(mano('As 2s 3s 4s 5s Kd Qh'));
  check(
    escaleraColor.rank === 'straight_flush' && escaleraColor.value === evaluateHand(mano('5h 4h 3h 2h Ah')).value,
    'detecta escalera de color con rueda',
  );

  const real = evaluateHand(mano('As Ks Qs Js Ts 2h 3d'));
  check(real.rank === 'royal_flush', 'detecta escalera real entre siete cartas');

  // La mejor combinación de siete, no la primera que aparezca.
  const siete = evaluateHand(mano('As Ah Ad Ks Kh Kd 2c'));
  check(
    siete.rank === 'full_house' &&
      siete.bestCards.filter((c) => c.rank === 'A').length === 3 &&
      siete.bestCards.filter((c) => c.rank === 'K').length === 2,
    'con dos tríos elige el full house correcto',
    `${siete.rank}: ${siete.bestCards.map((c) => c.rank).join('')}`,
  );

  // Empate exacto: mismos rangos, distintos palos.
  const empateA = evaluateHand(mano('As Kh Qd Jc Ts 2h 3d'));
  const empateB = evaluateHand(mano('Ad Ks Qh Jd Tc 2s 3h'));
  check(empateA.value === empateB.value, 'dos manos idénticas en rango empatan');

  // No confundir A-K-Q-J-9 con una escalera.
  const casi = evaluateHand(mano('As Kh Qd Jc 9s 2h 3d'));
  check(casi.rank === 'high_card', 'A-K-Q-J-9 no es escalera');

  // Carta alta: se comparan las cinco.
  const altaA = evaluateHand(mano('As Kh Qd Jc 9s 2h 3d'));
  const altaK = evaluateHand(mano('Ks Qh Jd 9c 8s 2h 3d'));
  check(altaA.value > altaK.value, 'carta alta se desempata por las cinco cartas');
}

// ===========================================================================
section('2. Barajado: baraja completa y sin cartas repetidas');

{
  const original = createDeck();
  const barajada = shuffleDeck(original);
  const claves = new Set(barajada.map((c) => `${c.rank}|${c.suit}`));
  check(barajada.length === 52 && claves.size === 52, 'la baraja conserva 52 cartas únicas');

  const distinta = shuffleDeck(original);
  check(
    distinta.some((c, i) => c.rank !== original[i].rank || c.suit !== original[i].suit),
    'el barajado cambia el orden',
  );
}

// ===========================================================================
section('3. Heads-up: ciegas y orden de acción correctos');

{
  const juego = nuevaMesa([1000, 1000], { sb: 5, bb: 10 });
  juego.startGame(0, barajaPreparada(mano('As Ah Ks Kh Qs Qh Js Jh Ts 9s 2d')));

  let estado = juego.getState();
  check(
    estado.smallBlindIndex === 0 && estado.bigBlindIndex === 1,
    'en heads-up el botón pone la ciega pequeña',
    `sb=${estado.smallBlindIndex}, bb=${estado.bigBlindIndex}`,
  );
  check(
    estado.currentPlayerIndex === 0,
    'en heads-up el botón actúa primero preflop',
    `current=${estado.currentPlayerIndex}`,
  );

  juego.performAction('0', 'call');
  juego.performAction('1', 'check');
  estado = juego.getState();
  check(
    estado.communityCards.length === 3 && estado.currentPlayerIndex === 1,
    'en heads-up la ciega grande actúa primero postflop',
    `board=${estado.communityCards.length}, current=${estado.currentPlayerIndex}`,
  );
}

// ===========================================================================
section('4. Subidas: amount es el total, no el incremento');

{
  const juego = nuevaMesa([1000, 1000, 1000], { sb: 5, bb: 10 });
  juego.startGame(0, barajaPreparada(mano('As Ah Ks Kh Qs Qh Js Jh Ts 9s 2d 3c 4d')));

  // UTG (asiento 0) sube a 50. El motor NO debe sumarle otros 50.
  const subida = juego.performAction('0', 'raise', 50);
  let estado = juego.getState();
  check(subida, 'acepta una subida a 50 con ciegas 5/10');
  check(
    estado.players[0].bet === 50 && estado.currentBet === 50,
    'la subida deja la apuesta en 50, no en 100',
    `bet=${estado.players[0].bet}, currentBet=${estado.currentBet}`,
  );

  // La subida de 10 a 50 fue de 40; la siguiente subida mínima es a 90.
  const corta = juego.performAction('1', 'raise', 80);
  check(!corta, 'rechaza una subida por debajo del mínimo');
  const legal = juego.performAction('1', 'raise', 90);
  check(legal, 'acepta la subida mínima a 90');
}

// ===========================================================================
section('5. All-in: se corre el board y el short stack no roba el lateral');

{
  // Tres jugadores. El asiento 0 (UTG) tiene 100 y la mejor mano; los otros
  // dos tienen 1000. Debe ganar el bote principal de 300 y nada más.
  const secuencia = mano(
    'As Ah ' +   // P0: ases
    'Kd Kc ' +   // P1: reyes
    'Qd Qc ' +   // P2: damas
    '2s 3s 4s 5s 9d', // board: color de picas para P0
  );
  const juego = nuevaMesa([100, 1000, 1000], { sb: 5, bb: 10 });
  juego.startGame(0, barajaPreparada(secuencia));

  check(juego.getState().currentPlayerIndex === 0, 'preflop empieza UTG');

  juego.performAction('0', 'all_in');
  juego.performAction('1', 'call');
  juego.performAction('2', 'call');

  let estado = juego.getState();
  check(
    estado.phase === 'flop' && estado.communityCards.length === 3,
    'tras igualar el all-in se reparte el flop',
    `phase=${estado.phase}, board=${estado.communityCards.length}`,
  );

  // Los dos stacks grandes se meten all-in en el flop. El motor debe correr
  // turn y river y llegar al showdown, sin terminar la mano antes.
  juego.performAction('1', 'all_in');
  juego.performAction('2', 'call');

  estado = juego.getState();
  check(
    estado.phase === 'finished' && estado.communityCards.length === 5,
    'el all-in completo corre las cinco comunitarias',
    `phase=${estado.phase}, board=${estado.communityCards.length}`,
  );
  check(estado.showdown && estado.showdown.length === 3, 'el showdown muestra a los tres');

  const pagos = Object.fromEntries((estado.payouts || []).map((p) => [p.playerId, p.amount]));
  check(pagos['0'] === 300, 'el short stack solo cobra el bote principal de 300', JSON.stringify(pagos));
  check(pagos['1'] === 1800, 'el segundo mejor cobra el bote lateral de 1800', JSON.stringify(pagos));
  check((pagos['2'] || 0) === 0, 'el peor de los stacks grandes no cobra nada', JSON.stringify(pagos));

  const totalPagado = (estado.payouts || []).reduce((s, p) => s + p.amount, 0);
  check(totalPagado === 2100, 'los pagos suman el bote completo', `total=${totalPagado}`);
  check(estado.potGross === 2100, 'el bote bruto queda registrado para la UI', `potGross=${estado.potGross}`);
}

// ===========================================================================
section('6. Rake: solo sobre el bote igualado');

{
  const rake = { percentage: 5, cap: 100, minPot: 10, requireFlopOr3Bet: true };

  // Mano con flop: SB iguala, BB pasa, SB apuesta 100 y BB se retira.
  const juego = nuevaMesa([1000, 1000], { sb: 5, bb: 10 }, rake);
  juego.startGame(0, barajaPreparada(mano('As Ah Ks Kh Qs Qh Js Jh Ts 9s')));

  juego.performAction('0', 'call');   // SB completa a 10
  juego.performAction('1', 'check');  // BB pasa
  juego.performAction('1', 'check');  // BB pasa en el flop
  juego.performAction('0', 'raise', 100); // SB apuesta 100
  juego.performAction('1', 'fold');   // BB se retira

  const estado = juego.getState();
  const pagos = Object.fromEntries((estado.payouts || []).map((p) => [p.playerId, p.amount]));

  check(estado.rake === 1, 'cobra 5 % sobre 20 igualados, no sobre los 120 del bote', `rake=${estado.rake}`);
  check(pagos['0'] === 119, 'el ganador recibe 119: 20 igualados - 1 de rake + 100 no igualados', JSON.stringify(pagos));
  check(estado.potGross === 120, 'el bote bruto es 120');
  check(
    (estado.payouts || []).reduce((s, p) => s + p.amount, 0) + estado.rake === estado.potGross,
    'bote bruto = pagos + rake',
  );

  // Sin flop ni 3-bet: no se cobra rake.
  const preflop = nuevaMesa([1000, 1000], { sb: 5, bb: 10 }, rake);
  preflop.startGame(0, barajaPreparada(mano('As Ah Ks Kh Qs Qh Js Jh Ts 9s')));
  preflop.performAction('0', 'raise', 30);
  preflop.performAction('1', 'fold');
  const sinFlop = preflop.getState();
  check(sinFlop.rake === 0, 'una mano resuelta preflop sin 3-bet no paga rake', `rake=${sinFlop.rake}`);
  check(
    (sinFlop.payouts || []).reduce((s, p) => s + p.amount, 0) === 40,
    'el ganador recupera sus 40 sin descuento',
  );

  // 3-bet preflop: sí se cobra, porque la regla lo permite.
  const tresBet = nuevaMesa([1000, 1000], { sb: 5, bb: 10 }, rake);
  tresBet.startGame(0, barajaPreparada(mano('As Ah Ks Kh Qs Qh Js Jh Ts 9s')));
  tresBet.performAction('0', 'raise', 30);
  tresBet.performAction('1', 'raise', 90);
  tresBet.performAction('0', 'fold');
  const conTresBet = tresBet.getState();
  check(conTresBet.rake === 3, 'una 3-bet preflop paga 5 % del bote igualado (60 -> 3)', `rake=${conTresBet.rake}`);
  check(
    (conTresBet.payouts || []).reduce((s, p) => s + p.amount, 0) + conTresBet.rake === conTresBet.potGross,
    'la 3-bet también conserva bote = pagos + rake',
  );
}

// ===========================================================================
section('7. Todo retirado menos uno: no se revelan cartas ni se cobra de más');

{
  const juego = nuevaMesa([1000, 1000, 1000], { sb: 5, bb: 10 });
  juego.startGame(0, barajaPreparada(mano('As Ah Ks Kh Qs Qh Js Jh Ts 9s 2d 3c 4d')));
  juego.performAction('0', 'fold');
  juego.performAction('1', 'fold');

  const estado = juego.getState();
  check(estado.phase === 'finished', 'la mano termina cuando solo queda uno');
  check(estado.communityCards.length === 0, 'no se reparte board si todos se retiran');
  check((estado.showdown || []).length === 0, 'no hay showdown ni cartas reveladas');
  check(estado.rake === 0, 'sin flop no hay rake');
  check(
    (estado.winners || []).reduce((s, w) => s + w.amount, 0) === 15,
    'el único que queda cobra las ciegas (15)',
    JSON.stringify(estado.winners),
  );
}

// ===========================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} pruebas OK, ${fail} fallos`);
console.log(`${'='.repeat(60)}\n`);

process.exit(fail > 0 ? 1 : 0);
