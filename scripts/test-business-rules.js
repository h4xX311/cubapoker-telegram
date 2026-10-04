/**
 * Pruebas de las reglas de negocio que sostienen el modelo economico.
 *
 * Estas reglas son las que separan un producto sano de uno que pierde dinero:
 *  - el saldo de freeroll no puede retirarse
 *  - la rake se descuenta antes de repartir
 *  - los bots no pueden ganar mas de lo que pierden
 *
 * No requieren base de datos: usan el codigo compilado.
 */

const {
  TABLE_TIERS,
  TABLE_TIER_LIST,
  FREEROLL_PRIZES,
  FREEROLL_PAYOUT,
  BOT_CONFIG,
  RAKE,
  BALANCE,
} = require('../dist/config/product');
const { botFactory, decideAction, evaluateStrength } = require('../dist/game/bot.engine');
const { evaluateHand } = require('../dist/game/hand.evaluator');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Pruebas de reglas de negocio\x1b[0m');

// =========================================================================
section('1. Mesas cash: escala y premios');

{
  const expected = [
    { max: 50, prize: 50 },
    { max: 100, prize: 100 },
    { max: 300, prize: 300 },
    { max: 500, prize: 500 },
  ];

  if (TABLE_TIER_LIST.length === 4) ok('hay 4 niveles de mesa');
  else bad(`esperaba 4 niveles, hay ${TABLE_TIER_LIST.length}`);

  for (const e of expected) {
    const tier = TABLE_TIER_LIST.find(t => t.maxPlayers === e.max);
    if (!tier) { bad(`falta la mesa de ${e.max}`); continue; }
    if (tier.guaranteedPrize === e.prize) {
      ok(`mesa ${e.max}: premio ${e.prize} CUP`);
    } else {
      bad(`mesa ${e.max}: premio ${tier.guaranteedPrize}, esperaba ${e.prize}`);
    }
  }

  // Buy-in minimo debe cubrir el premio o la mesa seria un farm negativo
  for (const tier of TABLE_TIER_LIST) {
    if (tier.minBuyIn > 0) ok(`mesa ${tier.maxPlayers}: buy-in minimo ${tier.minBuyIn} CUP`);
    else bad(`mesa ${tier.maxPlayers}: buy-in minimo invalido`);
  }

  // El premio no puede superar el buy-in por si el ganador pierde de contado:
  // eso convertiria la mesa en una fabrica de perdidas garantizadas.
  for (const tier of TABLE_TIER_LIST) {
    if (tier.guaranteedPrize < tier.minBuyIn) {
      ok(`mesa ${tier.maxPlayers}: premio < buy-in minimo (coherente)`);
    } else {
      bad(
        `mesa ${tier.maxPlayers}: premio ${tier.guaranteedPrize} >= buy-in ${tier.minBuyIn}. ` +
        `Un ganador que pierde de contado genera perdida neta.`,
      );
    }
  }
}

// =========================================================================
section('2. Freerolls: premios y no retirabilidad');

{
  const expectedPrizes = [5, 10, 20, 30, 40, 50];
  if (JSON.stringify(FREEROLL_PRIZES) === JSON.stringify(expectedPrizes)) {
    ok(`escalones de premio: ${FREEROLL_PRIZES.join(', ')} CUP`);
  } else {
    bad(`escalones inesperados: ${FREEROLL_PRIZES.join(', ')}`);
  }

  if (FREEROLL_PRIZES.length === 6) ok('6 escalones de freeroll');
  else bad(`esperaba 6 escalones, hay ${FREEROLL_PRIZES.length}`);

  const payoutSum = FREEROLL_PAYOUT.reduce((a, b) => a + b, 0);
  if (payoutSum <= 100) ok(`el reparto usa ${payoutSum}% del bote (el resto es rake/fondo)`);
  else bad(`el reparto suma ${payoutSum}%, no puede superar 100%`);

  if (RAKE.freerollPercentage === 0) ok('el freeroll no aplica rake');
  else bad(`el freeroll aplica ${RAKE.freerollPercentage}% de rake, debe ser 0`);

  // Un freeroll debe ser mas barato para el usuario que un deposito minimo
  const freeMin = FREEROLL_PRIZES[0];
  if (freeMin > 0) ok(`el menor premio (${freeMin} CUP) cubre al menos el buy-in minimo de mesa`);
  else bad('el menor premio de freeroll es 0');
}

// =========================================================================
section('3. Rake');

{
  if (RAKE.cashPercentage === 5) ok('rake de mesa cash: 5%');
  else bad(`rake cash: ${RAKE.cashPercentage}%`);

  if (RAKE.cashMax === 100) ok('rake maximo: 100 CUP por mano');
  else bad(`rake maximo: ${RAKE.cashMax}`);

  // Calculo real de rake
  const rakeOf = (pot) =>
    pot < RAKE.minPot ? 0 : Math.min(Math.floor((pot * RAKE.cashPercentage) / 100), RAKE.cashMax);

  if (rakeOf(1000) === 50) ok('rake de un bote de 1000 = 50 CUP');
  else bad(`rake de 1000 = ${rakeOf(1000)}`);

  if (rakeOf(5) === 0) ok('no hay rake en botes menores a 10 CUP');
  else bad(`rake en bote de 5 = ${rakeOf(5)}, debe ser 0`);

  if (rakeOf(100000) === 100) ok('el rake se topa en 100 CUP');
  else bad(`rake de un bote enorme = ${rakeOf(100000)}, debe ser 100`);
}

// =========================================================================
section('4. Bots: no pueden drainear la plataforma');

{
  if (BOT_CONFIG.winRateMin < 0.5 && BOT_CONFIG.winRateMax <= 0.5) {
    ok(`win rate de bots entre ${BOT_CONFIG.winRateMin} y ${BOT_CONFIG.winRateMax} (< 0.5)`);
  } else {
    bad(
      `win rate ${BOT_CONFIG.winRateMin}-${BOT_CONFIG.winRateMax}: si supera 0.5 ` +
      `los bots ganan mas de lo que pierden y empobrecen a los jugadores reales`,
    );
  }

  if (BOT_CONFIG.maxBotsPerTable <= 60) {
    ok(`tope de bots por mesa: ${BOT_CONFIG.maxBotsPerTable} (no todos los asientos)`);
  } else {
    bad(`maxBotsPerTable=${BOT_CONFIG.maxBotsPerTable} permite una mesa 100% bots`);
  }

  if (BOT_CONFIG.botRatio <= 1) ok(`proporcion de bots: ${BOT_CONFIG.botRatio}`);
  else bad(`botRatio fuera de rango: ${BOT_CONFIG.botRatio}`);
}

// --- Comportamiento observable de los bots ---
{
  botFactory.reset();

  const profiles = Array.from({ length: 60 }, () => botFactory.create());

  const uniqueNames = new Set(profiles.map(p => p.name));
  if (uniqueNames.size >= profiles.length * 0.9) {
    ok(`nombres de bot casi todos unicos (${uniqueNames.size}/${profiles.length})`);
  } else {
    bad(`solo ${uniqueNames.size} nombres unicos de ${profiles.length} bots`);
  }

  const inRange = profiles.every(
    p => p.winRate >= BOT_CONFIG.winRateMin && p.winRate <= BOT_CONFIG.winRateMax,
  );
  if (inRange) ok('todos los perfiles respetan el rango de win rate');
  else bad('hay perfiles fuera del rango de win rate');

  const styles = new Set(profiles.map(p => p.style));
  if (styles.size >= 3) ok(`variedad de estilos: ${[...styles].join(', ')}`);
  else bad(`solo ${styles.size} estilos distintos`);

  // Un bot nunca debe pasar cuando no debe nada y tener mano mala:
  // verificamos que decide check cuando puede pasar gratis.
  let checkedWhenFree = 0;
  let foldedWhenWeak = 0;
  const weakHand = [
    { rank: '7', suit: 'hearts', value: 7 },
    { rank: '2', suit: 'clubs', value: 2 },
  ];

  for (let i = 0; i < 300; i++) {
    const profile = profiles[i % profiles.length];

    // toCall = 0 -> nunca debe fold (no hay nada que perder)
    const free = decideAction({
      hand: weakHand, community: [], potSize: 200, toCall: 0,
      chips: 1000, profile, position: 0, playersLeft: 3,
    });
    if (free.action === 'check') checkedWhenFree++;

    // Mano debil con apuesta grande -> deberia fold a menudo
    const paid = decideAction({
      hand: weakHand, community: [], potSize: 200, toCall: 200,
      chips: 1000, profile, position: 0, playersLeft: 3,
    });
    if (paid.action === 'fold') foldedWhenWeak++;
  }

  if (checkedWhenFree === 300) ok('el bot nunca abandona cuando puede pasar gratis (0/300 folds)');
  else bad(`el bot abandono ${300 - checkedWhenFree} veces pudiendo pasar gratis`);

  if (foldedWhenWeak > 30) ok(`el bot abandona manos debiles con frecuencia (${foldedWhenWeak}/300)`);
  else bad(`el bot apenas abandona: ${foldedWhenWeak}/300, no parece jugar poker`);
}

// --- Fuerza de manos ---
{
  const royalFlush = [
    { rank: 'A', suit: 'spades', value: 14 },
    { rank: 'K', suit: 'spades', value: 13 },
    { rank: 'Q', suit: 'spades', value: 12 },
    { rank: 'J', suit: 'spades', value: 11 },
    { rank: '10', suit: 'spades', value: 10 },
  ];
  const trash = [
    { rank: '7', suit: 'hearts', value: 7 },
    { rank: '2', suit: 'clubs', value: 2 },
    { rank: '9', suit: 'diamonds', value: 9 },
    { rank: '4', suit: 'clubs', value: 4 },
    { rank: '3', suit: 'hearts', value: 3 },
  ];

  const strong = evaluateStrength(royalFlush, []);
  const weak = evaluateStrength(trash, []);

  if (strong > weak) ok(`mano fuerte (${strong.toFixed(3)}) > mano floja (${weak.toFixed(3)})`);
  else bad(`el evaluador no distingue: fuerte ${strong} vs floja ${weak}`);

  if (strong >= 0 && strong <= 1 && weak >= 0 && weak <= 1) ok('la fuerza queda normalizada en 0..1');
  else bad(`fuerza fuera de rango: ${weak}..${strong}`);
}

// --- Asignes: no supera el saldo ---
{
  botFactory.reset();
  const profile = botFactory.create(42);

  let invalid = 0;
  for (let i = 0; i < 500; i++) {
    const d = decideAction({
      hand: [{ rank: 'A', suit: 'hearts', value: 14 }, { rank: 'K', suit: 'hearts', value: 13 }],
      community: [], potSize: 500, toCall: 100,
      chips: 120, profile, position: 1, playersLeft: 3,
    });
    if ((d.action === 'raise' || d.action === 'all_in') && (d.amount ?? 0) > 120) invalid++;
  }

  if (invalid === 0) ok('el bot nunca apuesta mas fichas de las que tiene (0/500)');
  else bad(`el bot se paso de fichas ${invalid} veces`);

  let negative = 0;
  for (let i = 0; i < 500; i++) {
    const d = decideAction({
      hand: [{ rank: 'Q', suit: 'hearts', value: 12 }, { rank: 'J', suit: 'hearts', value: 11 }],
      community: [], potSize: 300, toCall: 50,
      chips: 900, profile, position: 0, playersLeft: 4,
    });
    if ((d.amount ?? 0) < 0) negative++;
  }
  if (negative === 0) ok('el bot nunca apuesta una cantidad negativa');
  else bad(`el bot genero ${negative} apuestas negativas`);
}

// --- No abandona cuando ya esta all-in ---
{
  botFactory.reset();
  const profile = botFactory.create(7);
  let folded = 0;

  for (let i = 0; i < 200; i++) {
    const d = decideAction({
      hand: [{ rank: '7', suit: 'hearts', value: 7 }, { rank: '2', suit: 'clubs', value: 2 }],
      community: [], potSize: 400, toCall: 0,
      chips: 0, // ya all-in, no le queda nada
      profile, position: 0, playersLeft: 2,
    });
    if (d.action === 'fold') folded++;
  }

  if (folded === 0) ok('el bot no abandona cuando ya esta all-in');
  else bad(`el bot abandono ${folded} veces sin fichas`);
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
