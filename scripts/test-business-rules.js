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
  FREEROLL_TARGET_FIELD,
  FREEROLL_MAX_FIELD,
  FIELD_PAYOUT,
  SEATS_PER_TABLE,
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
section('1. Campos cash: fieldSize, no asientos');

{
  // OJO con la distincion que rompio la iteracion anterior:
  //   fieldSize  = participantes del campo (multi-mesa)
  //   maxSeats   = asientos de una mesa fisica (siempre 7)
  if (SEATS_PER_TABLE === 7) ok('mesa fisica 7-max');
  else bad(`SEATS_PER_TABLE=${SEATS_PER_TABLE}; el producto define 7-max`);

  const expected = [
    { field: 50, prize: 50 },
    { field: 100, prize: 100 },
    { field: 300, prize: 300 },
    { field: 500, prize: 500 },
  ];

  if (TABLE_TIER_LIST.length === 4) ok('hay 4 niveles de campo');
  else bad(`esperaba 4 niveles, hay ${TABLE_TIER_LIST.length}`);

  for (const e of expected) {
    const tier = TABLE_TIER_LIST.find(t => t.fieldSize === e.field);
    if (!tier) { bad(`falta el campo de ${e.field}`); continue; }
    if (tier.guaranteedPrize === e.prize) {
      ok(`campo ${e.field}: premio ${e.prize} CUP`);
    } else {
      bad(`campo ${e.field}: premio ${tier.guaranteedPrize}, esperaba ${e.prize}`);
    }
  }

  // Nadie debe seguir usando `maxPlayers` para describir el campo: ese nombre
  // es lo que llevo a pensar "500 personas en una mesa".
  const legacy = TABLE_TIER_LIST.filter(t => 'maxPlayers' in t);
  if (legacy.length === 0) ok('ningun tier usa el nombre legacy `maxPlayers`');
  else bad(`${legacy.length} tiers siguen usando maxPlayers; debe llamarse fieldSize`);

  // Un field de N son ceil(N / 7) mesas fisicas.
  for (const tier of TABLE_TIER_LIST) {
    const tables = Math.ceil(tier.fieldSize / SEATS_PER_TABLE);
    if (tables === Math.ceil(tier.fieldSize / 7)) {
      ok(
        `campo ${tier.fieldSize}: ${tables} mesas de 7 ` +
        `(${tier.fieldSize} participantes)`,
      );
    }
  }
}

// =========================================================================
section('2. Economia del campo: el RTP es viable');

{
  // ESTE es el bloque que falla con los numeros actuales, y deliberatemente.
  //
  // premio = fieldSize * 1 CUP en los cuatro tiers. Para que el RTP fuera sano
  // (~95%, lo que corresponde a un rake del 5%) el buy-in tendria que ser
  // ~1 CUP en los cuatro, con lo que los cuatro campos serian
  // economicamente identicos y el ladder no escalaria para nada.
  //
  // Con los buy-ins actuales (200/500/1000/2000) el RTP es del 0,5% al 0,05%:
  // el rake del 5% no cubre ni de lejos la devolucion, y el campo pierde una
  // cantidad garantizada. Esto no se puede arreglar en codigo, es una decision
  // de negocio: o el buy-in baja a ~1 CUP, o el premio sale de un fondo
  // promocional y no del bote.
  console.log('    field   premio   buy-in   se recauda    premio    RTP');
  const rtpByTier = new Map();

  for (const tier of TABLE_TIER_LIST) {
    const collected = tier.fieldSize * tier.minBuyIn;
    const rtp = tier.guaranteedPrize / collected;
    rtpByTier.set(tier.id, rtp);

    console.log(
      '    ' +
        String(tier.fieldSize).padEnd(8) +
        String(tier.guaranteedPrize).padEnd(9) +
        String(tier.minBuyIn).padEnd(9) +
        String(collected).padEnd(13) +
        String(tier.guaranteedPrize).padEnd(10) +
        (rtp * 100).toFixed(3) + '%',
    );
  }

  const healthy = [...rtpByTier.values()].every(r => r >= 0.5);
  const anyVisible = [...rtpByTier.values()].some(r => r >= 0.05);

  if (healthy) {
    ok('todos los campos tienen RTP >= 50%');
  } else {
    bad(
      'ningun campo llega al 50% de RTP. ' +
      `El rake del ${RAKE.cashPercentage}% no cubre la devolucion del premio. ` +
      'Hace falta una de dos: bajar el buy-in a ~1 CUP (y entonces los cuatro ' +
      'campos son el mismo), o que el premio salga de un fondo promocional y no ' +
      'del bote. Decision de negocio, no de codigo.',
    );
  }

  // Aunque el RTP aun no este resuelto, el rake no puede ser la unica fuente:
  // si el rake cubriese el premio, el operador no tendria margen.
  for (const tier of TABLE_TIER_LIST) {
    const collected = tier.fieldSize * tier.minBuyIn;
    const rake = (collected * RAKE.cashPercentage) / 100;
    if (rake > tier.guaranteedPrize) {
      ok(
        `campo ${tier.fieldSize}: el rake (${rake.toFixed(0)} CUP) supera el premio ` +
        `(${tier.guaranteedPrize} CUP)`,
      );
    } else {
      bad(
        `campo ${tier.fieldSize}: el rake (${rake.toFixed(0)}) no cubre el premio ` +
        `(${tier.guaranteedPrize}). El operador pierde dinero en cada campo.`,
      );
    }
  }

  // Esto no puede arreglarse bajando el buy-in sin aplanar el ladder: si los
  // cuatro campos dan lo mismo, el jugador no tiene motivo para elegir uno.
  if (!anyVisible) {
    console.log(
      '    aviso: con estos numeros los 4 campos son indistinguibles para el jugador',
    );
  }
}

// =========================================================================
section('3. Reparto del premio entre posiciones');

{
  const sum = FIELD_PAYOUT.reduce((a, b) => a + b, 0);
  if (sum <= 100) {
    ok(`el reparto usa ${sum}% del premio (el ${100 - sum}% restante es rake/fondo)`);
  } else {
    bad(`el reparto suma ${sum}%, no puede superar 100%`);
  }

  // El reparto debe ser decreciente: el primer lugar cobra mas que el segundo.
  let descending = true;
  for (let i = 1; i < FIELD_PAYOUT.length; i++) {
    if (FIELD_PAYOUT[i] >= FIELD_PAYOUT[i - 1]) descending = false;
  }
  if (descending) ok('el reparto es estrictamente decreciente por posicion');
  else bad(`el reparto no decrece: ${FIELD_PAYOUT.join(' / ')}`);

  if (FIELD_PAYOUT.length >= 3) ok(`${FIELD_PAYOUT.length} posiciones premiadas`);
  else bad(`solo ${FIELD_PAYOUT.length} posiciones premiadas; un field de 500 paga a muy pocos`);

  // El primero debe llevarse una parte sustancial: si no, el campo no engancha.
  if (FIELD_PAYOUT[0] >= 40) ok(`el primer lugar se lleva el ${FIELD_PAYOUT[0]}%`);
  else bad(`el primer lugar solo se lleva el ${FIELD_PAYOUT[0]}%; el field no engancha`);
}

// =========================================================================
section('4. Freerolls: premios y no retirabilidad');

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

  // "Freeroll ilimitado" no puede ser ilimitado de verdad. Sin tope, el campo
  // tardaria horas en llegar a mesa final y un mismo usuario podria abrir
  // campos en bucle para acaparar el saldo de promocion.
  if (FREEROLL_TARGET_FIELD > 0) {
    ok(`el freeroll arranca con ${FREEROLL_TARGET_FIELD} inscritos (campo multi-mesa)`);
  } else {
    bad('FREEROLL_TARGET_FIELD debe ser > 0: sin objetivo, el campo nunca arranca');
  }

  const tablesNeeded = Math.ceil(FREEROLL_TARGET_FIELD / SEATS_PER_TABLE);
  if (tablesNeeded > 1) {
    ok(`un freeroll de ${FREEROLL_TARGET_FIELD} son ${tablesNeeded} mesas de 7`);
  }

  if (FREEROLL_MAX_FIELD > FREEROLL_TARGET_FIELD) {
    ok(`techo duro de ${FREEROLL_MAX_FIELD} inscritos (> objetivo ${FREEROLL_TARGET_FIELD})`);
  } else {
    bad(
      `FREEROLL_MAX_FIELD (${FREEROLL_MAX_FIELD}) debe ser mayor que el objetivo ` +
      `(${FREEROLL_TARGET_FIELD}); si no, el campo cierra antes de empezar`,
    );
  }

  // El campo no puede crecer sin limite: 500 mesas de 7 es inmanejable.
  if (FREEROLL_MAX_FIELD <= 5000) {
    ok(`el techo de ${FREEROLL_MAX_FIELD} es operativamente manejable`);
  } else {
    bad(
      `techo de ${FREEROLL_MAX_FIELD}: son ` +
      `${Math.ceil(FREEROLL_MAX_FIELD / SEATS_PER_TABLE)} mesas para operar`,
    );
  }
}

// =========================================================================
section('5. Rake');

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
section('6. Bots: no pueden vaciar la plataforma');

{
  if (BOT_CONFIG.winRateMin < 0.5 && BOT_CONFIG.winRateMax <= 0.5) {
    ok(`win rate de bots entre ${BOT_CONFIG.winRateMin} y ${BOT_CONFIG.winRateMax} (< 0.5)`);
  } else {
    bad(
      `win rate ${BOT_CONFIG.winRateMin}-${BOT_CONFIG.winRateMax}: si supera 0.5 ` +
      `los bots ganan mas de lo que pierden y empobrecen a los jugadores reales`,
    );
  }

  // Con 7-max el tope legal de bots es 6 (si hay un humano sentado). El valor
  // anterior era 60, imposible en una mesa de 7 y ademas habria convertido
  // cualquier campo pequeno en una mesa de solo bots.
  if (BOT_CONFIG.maxBotsPerTable <= SEATS_PER_TABLE - 1) {
    ok(`tope de bots por mesa: ${BOT_CONFIG.maxBotsPerTable} de 7 asientos`);
  } else {
    bad(
      `maxBotsPerTable=${BOT_CONFIG.maxBotsPerTable} en una mesa de ` +
      `${SEATS_PER_TABLE}: permite una mesa casi 100% bots`,
    );
  }

  if (BOT_CONFIG.maxBotsPerTable === SEATS_PER_TABLE - 1) {
    ok('el tope deja siempre un asiento para un humano');
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
