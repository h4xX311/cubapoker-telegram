/**
 * Rangos preflop y push/fold de los bots.
 *
 * Estas pruebas no miden si el bot gana: comprueban que la decisión cambia con
 * la posición, el stack y la subida previa, y que ninguna subida propuesta es
 * ilegal para el motor.
 */

const { decideAction } = require('../dist/game/bot.engine');
const { expandRange, handClass, preflopPosition } = require('../dist/game/bot.ranges');

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

const VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, 'T': 10, '10': 10, J: 11, Q: 12, K: 13, A: 14,
};
const SUITS = {
  s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs',
};
const card = (rank, suit = 's') => ({
  rank: rank === 'T' ? '10' : rank,
  suit: SUITS[suit],
  value: VALUES[rank],
});

const profile = (style = 'calling', aggression = 0.3) => ({
  id: 'bot-test',
  name: 'Bot Test',
  style,
  winRate: 0.45,
  raiseFreq: style === 'aggressive' ? 0.45 : 0.2,
  foldFreq: style === 'tight' ? 0.42 : 0.3,
  aggression,
});

/**
 * Contexto de una mesa 7-max. `dealer` y `current` son índices reales de
 * asiento, no posiciones dentro de la lista de jugadores.
 */
function baseParams(overrides = {}) {
  return {
    hand: [card('A'), card('K', 'h')],
    community: [],
    potSize: 15,
    toCall: 10,
    chips: 1000,
    profile: profile(),
    position: 3,
    playersLeft: 7,
    currentBet: 10,
    minRaise: 10,
    bigBlind: 10,
    dealerIndex: 0,
    currentPlayerIndex: 3,
    tablePlayers: 7,
    isSmallBlind: false,
    isBigBlind: false,
    preflopRaises: 0,
    rng: () => 0.5,
    ...overrides,
  };
}

const decision = (overrides = {}) => decideAction(baseParams(overrides));

console.log('\n\x1b[1mCubaPoker — Rangos preflop y push/fold\x1b[0m');

// =========================================================================
section('1. Notación de rangos');
{
  const a9 = expandRange('A9s+');
  const okA9 = ['A9s', 'ATs', 'AJs', 'AQs', 'AKs'].every(h => a9.has(h));
  const noA8 = !a9.has('A8s') && !a9.has('AKo');
  if (okA9 && noA8) ok('A9s+ expande A9s, ATs, AJs, AQs y AKs, sin A8s ni offsuit');
  else bad('A9s+ no expande como se esperaba', JSON.stringify([...a9]));

  const pares = expandRange('22+');
  const okPares = ['22', '55', 'TT', 'QQ', 'AA'].every(h => pares.has(h));
  if (okPares && !pares.has('AK')) ok('22+ expande todas las parejas y no mezcla AK');
  else bad('22+ no expande como se esperaba');

  const h1 = handClass([card('A', 's'), card('K', 's')]);
  const h2 = handClass([card('A', 's'), card('K', 'h')]);
  if (h1 === 'AKs' && h2 === 'AKo') ok('handClass distingue AKs de AKo');
  else bad('handClass devolvió ' + h1 + ' / ' + h2);
}

// =========================================================================
section('2. Posición real alrededor del botón');
{
  const early = preflopPosition(baseParams({ currentPlayerIndex: 3, dealerIndex: 0 }));
  const middle = preflopPosition(baseParams({ currentPlayerIndex: 4, dealerIndex: 0 }));
  const late = preflopPosition(baseParams({ currentPlayerIndex: 5, dealerIndex: 0 }));
  const button = preflopPosition(baseParams({ currentPlayerIndex: 0, dealerIndex: 0 }));

  if (early === 'early' && middle === 'middle' && late === 'late' && button === 'button') {
    ok('la misma mesa clasifica primera, media, corte y botón');
  } else {
    bad('posición inesperada: ' + [early, middle, late, button].join(', '));
  }
}

// =========================================================================
section('3. Apertura: la posición cambia la mano con la que se entra');
{
  const aa = decision({
    hand: [card('A'), card('A', 'h')],
    currentPlayerIndex: 3,
  });
  if (aa.action === 'raise' && aa.amount >= 30) ok('AA en primera posición abre con subida');
  else bad('AA en primera no abrió', JSON.stringify(aa));

  const basura = decision({
    hand: [card('7'), card('2', 'h')],
    currentPlayerIndex: 3,
  });
  if (basura.action === 'fold') ok('72o en primera posición se retira');
  else bad('72o en primera no se retiró', JSON.stringify(basura));

  const akBtn = decision({
    hand: [card('A'), card('K', 'h')],
    currentPlayerIndex: 0,
  });
  if (akBtn.action === 'raise') ok('AKo en el botón abre');
  else bad('AKo en el botón no abrió', JSON.stringify(akBtn));

  const bbCheck = decision({
    hand: [card('7'), card('2', 'h')],
    currentPlayerIndex: 2,
    toCall: 0,
    isBigBlind: true,
  });
  if (bbCheck.action === 'check') ok('la ciega grande ve el flop gratis con 72o');
  else bad('la ciega grande no vio gratis', JSON.stringify(bbCheck));
}

// =========================================================================
section('4. Push/fold con stack corto');
{
  const push = decision({
    hand: [card('A'), card('7', 'h')],
    chips: 100,
    currentPlayerIndex: 3,
  });
  if (push.action === 'all_in') ok('A7s con 10 BB en primera posición empuja todo');
  else bad('A7s corto no empujó', JSON.stringify(push));

  const fold = decision({
    hand: [card('7'), card('2', 'h')],
    chips: 100,
    currentPlayerIndex: 3,
  });
  if (fold.action === 'fold') ok('72o con 10 BB se retira: no es un push cualquiera');
  else bad('72o corto no se retiró', JSON.stringify(fold));

  const latePush = decision({
    hand: [card('Q'), card('9', 'h')],
    chips: 100,
    currentPlayerIndex: 6,
  });
  if (latePush.action === 'all_in') ok('Q9o con 10 BB en corte empuja: el rango se abre');
  else bad('Q9o corto en corte no empujó', JSON.stringify(latePush));
}

// =========================================================================
section('5. Contra una subida: 3-bet, igualar o retirarse');
{
  const qq = decision({
    hand: [card('Q'), card('Q', 'h')],
    currentBet: 30,
    toCall: 30,
    minRaise: 20,
    preflopRaises: 1,
    currentPlayerIndex: 0,
  });
  if (qq.action === 'raise' || qq.action === 'all_in') ok('QQ contra subida hace 3-bet');
  else bad('QQ no hizo 3-bet', JSON.stringify(qq));

  const basura = decision({
    hand: [card('7'), card('2', 'h')],
    currentBet: 30,
    toCall: 30,
    minRaise: 20,
    preflopRaises: 1,
    currentPlayerIndex: 0,
  });
  if (basura.action === 'fold') ok('72o contra subida se retira');
  else bad('72o contra subida no se retiró', JSON.stringify(basura));

  const defiende = decision({
    hand: [card('A'), card('J', 'h')],
    currentBet: 30,
    toCall: 30,
    minRaise: 20,
    preflopRaises: 1,
    currentPlayerIndex: 0,
  });
  if (defiende.action === 'call' || defiende.action === 'raise') {
    ok('AJo en el botón defiende una subida');
  } else {
    bad('AJo no defendió', JSON.stringify(defiende));
  }
}

// =========================================================================
section('6. Las subidas propuestas son legales');
{
  let revisadas = 0;
  let ilegales = 0;
  const manos = [
    [card('A'), card('A', 'h')],
    [card('A'), card('K', 'h')],
    [card('K'), card('Q', 'h')],
    [card('Q'), card('J', 'h')],
    [card('T'), card('9', 'h')],
    [card('5'), card('5', 'h')],
    [card('A'), card('7', 'h')],
  ];

  for (const mano of manos) {
    for (const current of [0, 3, 5, 6]) {
      for (const estilo of ['tight', 'aggressive', 'calling', 'loose', 'rock']) {
        const p = baseParams({
          hand: mano,
          profile: profile(estilo, estilo === 'aggressive' ? 0.65 : 0.3),
          currentPlayerIndex: current,
          position: current,
        });
        const d = decideAction(p);
        if (d.action === 'raise') {
          revisadas++;
          const playerBet = Math.max(0, p.currentBet - p.toCall);
          const maxTarget = playerBet + p.chips;
          const minTarget = p.currentBet + p.minRaise;
          if (!(d.amount > p.currentBet && d.amount >= minTarget && d.amount <= maxTarget)) {
            ilegales++;
            bad(`subida ilegal: ${JSON.stringify(d)}`, JSON.stringify(p));
          }
        }
      }
    }
  }

  if (ilegales === 0) ok(`${revisadas} subidas preflop respetan total, mínimo y stack`);
}

// =========================================================================
console.log(
  `\n${'='.repeat(60)}\n` +
  `Resultado: ${pass} correctos, ${fail} fallidos\n` +
  `${'='.repeat(60)}\n`,
);
note('El rango no promete ganar: promete no jugar igual desde todas las sillas.');
process.exit(fail > 0 ? 1 : 0);
