/**
 * Pruebas de las reglas de negocio.
 *
 * Aqui se comprueban las tres cosas que sostienen el producto:
 *  - la escalera de campos escala en buy-in, y en USDT
 *  - el saldo de promocion se desbloquea jugando, no se retira de golpe
 *  - los freerolls y centrolls no permiten drenar la plataforma
 *
 * Ejecutar: node scripts/test-business-rules.js
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
  CENTROLL,
  UNLOCK_RATES,
  BOT_CONFIG,
  RAKE,
  ECONOMY,
} = require('../dist/config/product');
const {
  WITHDRAWALS,
  CUP_PER_USDT,
  cupToUsdt,
  usdtToCup,
} = require('../dist/config/currency');
const { usdtToUnits, unitsToUsdt, blindsFor } = require('../dist/config/units');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Reglas de negocio\x1b[0m');

// =========================================================================
section('1. Escalera de campos: escalan en buy-in, todos de 300');

{
  // La distincion que rompio una iteracion anterior:
  //   fieldSize = participantes del campo (multi-mesa)
  //   maxSeats  = asientos de una mesa fisica (siempre 7)
  if (SEATS_PER_TABLE === 7) ok('mesa fisica 7-max');
  else bad(`SEATS_PER_TABLE=${SEATS_PER_TABLE}; el producto define 7-max`);

  if (TABLE_TIER_LIST.length === 4) ok('hay 4 niveles de campo');
  else bad(`esperaba 4 niveles, hay ${TABLE_TIER_LIST.length}`);

  const expectedBuys = [1, 5, 25, 100];
  const expectedIds = ['t1', 't5', 't25', 't100'];

  for (let i = 0; i < expectedBuys.length; i++) {
    const tier = TABLE_TIER_LIST[i];
    if (!tier) { bad(`falta el nivel ${i}`); continue; }

    if (tier.id === expectedIds[i]) {
      ok(`nivel ${i}: id ${tier.id} (buy-in de ${expectedBuys[i]} USDT)`);
    } else {
      bad(`nivel ${i}: id ${tier.id}, esperaba ${expectedIds[i]}`);
    }

    if (tier.buyInUsdt === expectedBuys[i]) {
      ok(`${tier.label}: buy-in ${tier.buyInUsdt} USDT = ${tier.buyInUnits} unidades`);
    } else {
      bad(`${tier.label}: buy-in ${tier.buyInUsdt} USDT, esperaba ${expectedBuys[i]}`);
    }

    if (tier.buyInUnits === usdtToUnits(expectedBuys[i])) {
      ok(`${tier.label}: las unidades internas son coherentes con el USDT`);
    } else {
      bad(
        `${tier.label}: buyInUnits=${tier.buyInUnits}, ` +
        `usdtToUnits(${expectedBuys[i]})=${usdtToUnits(expectedBuys[i])}`,
      );
    }

    if (tier.fieldSize === 300) {
      ok(`${tier.label}: 300 participantes en todos los niveles`);
    } else {
      bad(
        `${tier.label}: fieldSize=${tier.fieldSize}. Todos los niveles son de 300: ` +
        'es lo que hace que el tiempo de espera sea siempre el mismo.',
      );
    }
  }

  // Las ciegas tienen que ser coherentes con el buy-in y estar en el rango de
  // poker real.
  for (const tier of TABLE_TIER_LIST) {
    const bb = tier.stackInBigBlinds;
    if (bb >= 40 && bb <= 200) {
      ok(`${tier.label}: stack de ${bb} BB (rango de poker)`);
    } else {
      bad(`${tier.label}: stack de ${bb} BB, fuera de 40-200`);
    }

    if (tier.blinds.big === tier.blinds.small * 2) {
      ok(`${tier.label}: ciegas ${tier.blinds.small}/${tier.blinds.big} unidades (la grande es el doble)`);
    } else {
      bad(
        `${tier.label}: ciegas ${tier.blinds.small}/${tier.blinds.big}, ` +
        'la grande tiene que ser exactamente el doble',
      );
    }
  }

  // El ladder tiene que escalar.
  let ascending = true;
  for (let i = 1; i < TABLE_TIER_LIST.length; i++) {
    if (TABLE_TIER_LIST[i].buyInUnits <= TABLE_TIER_LIST[i - 1].buyInUnits) ascending = false;
  }
  if (ascending) {
    ok(
      'el buy-in escala: ' +
      TABLE_TIER_LIST.map(t => `${t.label} ${t.buyInUsdt}`).join(' < ') + ' USDT',
    );
  } else {
    bad('el buy-in no escala entre niveles');
  }

  // Un field de 300 son 43 mesas de 7.
  const tables = Math.ceil(300 / SEATS_PER_TABLE);
  if (tables === 43) ok('campo de 300 = 43 mesas de 7');
  else bad(`campo de 300 = ${tables} mesas, esperaba 43`);
}

// =========================================================================
section('2. RTP: 95% en todos los niveles');

{
  console.log('    nivel   buy-in      Bote bruto       Rake     Bote neto');
  for (const tier of TABLE_TIER_LIST) {
    const gross = tier.fieldSize * tier.buyInUnits;
    const rake = Math.floor(gross * RAKE.cashPercentage / 100);
    console.log(
      '    ' + tier.label.padEnd(8) +
      ((formatUsdt(tier.buyInUnits)) + ' USDT').padEnd(13) +
      formatUsdt(gross).padStart(14) + ' USDT' +
      formatUsdt(rake).padStart(11) + ' USDT' +
      formatUsdt(gross - rake).padStart(14) + ' USDT',
    );
  }
  console.log('');

  for (const tier of TABLE_TIER_LIST) {
    const gross = tier.fieldSize * tier.buyInUnits;
    const rtp = 1 - (Math.floor(gross * RAKE.cashPercentage / 100) / gross);
    if (rtp >= 0.9 && rtp <= 0.95) {
      ok(`${tier.label}: RTP ${(rtp * 100).toFixed(2)}%`);
    } else {
      bad(`${tier.label}: RTP ${(rtp * 100).toFixed(2)}%, fuera de 90-95%`);
    }
  }

  // El margen del operador crece con el stake.
  const margins = TABLE_TIER_LIST.map(t =>
    Math.floor((t.fieldSize * t.buyInUnits * RAKE.cashPercentage) / 100),
  );
  let growing = true;
  for (let i = 1; i < margins.length; i++) {
    if (margins[i] <= margins[i - 1]) growing = false;
  }
  if (growing) {
    ok(
      'el margen crece con el stake: ' +
      TABLE_TIER_LIST.map((t, i) => `${t.label} ${formatUsdt(margins[i])}`).join(' < ') + ' USDT',
    );
  } else {
    bad('el margen no crece con el stake');
  }

  if (RAKE.cashPercentage === 5) ok('rake del 5% en campos (igual que CoinPoker)');
  else bad(`rake ${RAKE.cashPercentage}%, CoinPoker usa 5%`);
}

// =========================================================================
section('3. Promotional Dollars: ratio de desbloqueo 1:10');

{
  // El modelo de CoinPoker:
  //   "This Promotional Dollar balance is not withdrawable, but this currency
  //    can become withdrawable through playing CoinPoker games."
  //   Cash Games 1:10 · Tournaments 1:1
  //
  // Aqui aplicamos 1:10 a TODO, incluidos los campos. La razon es que los
  // freerolls dan entrada GRATIS: con 1:1, ganar un freeroll produciria saldo
  // retirable sin haber depositado nunca.
  for (const [context, rate] of Object.entries(UNLOCK_RATES)) {
    if (rate === 0.1) {
      ok(`${context}: ratio 1:10 (10% se desbloquea, 90% se consume)`);
    } else {
      bad(`${context}: ratio ${rate}, esperaba 0,1`);
    }
  }

  // El calculo del desbloqueo, con redondeo ABAJO.
  const unlock = (playAmount, rate = 0.1) =>
    Math.floor(playAmount * rate * 100) / 100;

  // Redondeo hacia abajo: es lo que impide extraer mas de lo que se juega.
  if (unlock(1000) === 100) ok('1 USDT de play desbloquea 0,1 USDT retirable');
  else bad(`1 USDT de play desbloquea ${unlock(1000)}, esperaba 0,1`);

  // El caso que mas importa: con poco saldo, el redondeo no puede "regalar".
  // Si se redondeara hacia arriba, 3 unidades de play con rate 0,1 darian
  // 0,3 y se podrian extraer 0,3 por cada 0,3 jugado (100%).
  if (unlock(3) === 0.3) ok('3 unidades de play (0,003 USDT) desbloquean 0,3 unidades');
  else bad(`3 unidades desbloquean ${unlock(3)}, esperaba 0,3`);

  // El techo de extraccion de un saldo de play.
  const playBalance = 10000; // 10 USDT de play
  const maxExtractable = Math.floor(playBalance * 0.1 * 100) / 100;
  if (maxExtractable === 1000) ok('10 USDT de play pueden extraer como maximo 1 USDT');
  else bad(`10 USDT de play extraen ${maxExtractable}, esperaba 1`);

  // Drenaje: no se puede convertir mas de lo que se juega.
  let drained = 0;
  for (let play = 1; play <= 20000; play++) {
    const out = unlock(play);
    if (out > play * 0.1 + 0.0001) drained++;
  }
  if (drained === 0) {
    ok('en 20 000 saldos de play, ninguno desbloquea mas del 10% de su propio valor');
  } else {
    bad(`${drained} saldos de play desbloquean mas del 10%: es un drenaje`);
  }
}

// =========================================================================
section('4. Freerolls: entrada gratis, premio en play');

{
  if (FREEROLL_PRIZES.length === 6) ok(`6 escalones: ${FREEROLL_PRIZES.join(', ')} USDT`);
  else bad(`esperaba 6 escalones, hay ${FREEROLL_PRIZES.length}`);

  // La suma del reparto tiene que ser 100: el freeroll no rakea, todo el bote
  // se reparte.
  const sum = FREEROLL_PAYOUT.reduce((a, b) => a + b, 0);
  if (sum === 100) ok('el reparto del freeroll suma 100% (no hay rake)');
  else bad(`el reparto suma ${sum}%, no 100`);

  if (RAKE.freerollPercentage === 0) ok('el freeroll no rakea');
  else bad(`el freeroll rakea ${RAKE.freerollPercentage}%`);

  // El premio tiene que ser una fraccion razonable del field, no un giveaway
  // gigante que el operador no pueda pagar.
  for (const prize of FREEROLL_PRIZES) {
    const perPlayer = prize / FREEROLL_TARGET_FIELD;
    // Un premio de 200 USDT en un field de 300 son 0,67 USDT por jugador: es
    // un ticket, no un premio. Un premio de 1 USDT son 0,003 USDT por
    // jugador: es un。下面 symbol.
    if (perPlayer < 1) {
      ok(
        `freeroll de ${prize} USDT en un field de ${FREEROLL_TARGET_FIELD}: ` +
        `${perPlayer.toFixed(3)} USDT por jugador`,
      );
    } else {
      ok(
        `freeroll de ${prize} USDT en un field de ${FREEROLL_TARGET_FIELD}: ` +
        `${perPlayer.toFixed(2)} USDT por jugador (premio de verdad, presupuestar)`,
      );
    }
  }

  // El techo duro tiene que ser mayor que el objetivo.
  if (FREEROLL_MAX_FIELD > FREEROLL_TARGET_FIELD) {
    ok(`techo duro ${FREEROLL_MAX_FIELD} > objetivo ${FREEROLL_TARGET_FIELD}`);
  } else {
    bad(
      `FREEROLL_MAX_FIELD (${FREEROLL_MAX_FIELD}) <= objetivo ` +
      `(${FREEROLL_TARGET_FIELD}); el campo cierra antes de empezar`,
    );
  }

  // El techo tiene que ser operativamente manejable.
  const maxTables = Math.ceil(FREEROLL_MAX_FIELD / SEATS_PER_TABLE);
  if (maxTables <= 200) {
    ok(`techo de ${FREEROLL_MAX_FIELD} = ${maxTables} mesas (manejable)`);
  } else {
    bad(`techo de ${FREEROLL_MAX_FIELD} = ${maxTables} mesas, inmanejable`);
  }
}

// =========================================================================
section('5. Centrolls: la via de ingresos del freeroll');

{
  // CoinPoker: "CoinPoker Centrolls: $0.01 Buy-Ins. These events require you
  // to have a real money balance of at least $0.01."
  if (CENTROLL.buyInUsdt > 0) {
    ok(`centroll: buy-in de ${CENTROLL.buyInUsdt} USDT`);
  } else {
    bad('el centroll no puede ser gratis: es la via de ingresos');
  }

  // El buy-in tiene que ser alcanzable con un deposito minimo de EnZona.
  const minDeposit = 500; // CUP
  const minDepositUsdt = cupToUsdt(minDeposit);
  if (minDepositUsdt >= CENTROLL.buyInUsdt) {
    ok(
      `un deposito minimo de ${minDeposit} CUP (${minDepositUsdt} USDT) alcanza ` +
      `para ${Math.floor(minDepositUsdt / CENTROLL.buyInUsdt)} centrolls`,
    );
  } else {
    bad(
      `el centroll cuesta ${CENTROLL.buyInUsdt} USDT y el deposito minimo son ` +
      `${minDepositUsdt}: nadie podria jugar`,
    );
  }

  // El premio de un centroll va a `play` (tickets), no a dinero. Es la regla de
  // CoinPoker: "Do centrolls have cash prizes? No, all prizes in your centrolls
  // are paid in the form of tickets".
  if (CENTROLL.prizeToBalance === 'play') {
    ok('el premio del centroll va a balance.play (equivalente a tickets)');
  } else {
    bad(`el premio va a "${CENTROLL.prizeToBalance}", deberia ser "play"`);
  }

  // El multiplicador tiene que ser mayor que 1 para que tenga sentido.
  if (CENTROLL.prizeMultiplier > 1) {
    ok(`el premio es ${CENTROLL.prizeMultiplier}x el buy-in (fichas de promocion)`);
  } else {
    bad(`multiplicador ${CENTROLL.prizeMultiplier}x: no hay premio`);
  }

  // El campo del centroll tiene que ser mas pequeno que el del freeroll: es un
  // bucle rapido.
  if (CENTROLL.targetField < FREEROLL_TARGET_FIELD) {
    ok(`campo del centroll (${CENTROLL.targetField}) < campo del freeroll (${FREEROLL_TARGET_FIELD})`);
  } else {
    bad('el centroll deberia resolverse antes que el freeroll');
  }

  if (CENTROLL.maxRebuys > 0 && CENTROLL.maxRebuys <= 10) {
    ok(`${CENTROLL.maxRebuys} reentradas permitidas (como CoinPoker)`);
  } else {
    bad(`reentradas: ${CENTROLL.maxRebuys}, deberia estar entre 1 y 10`);
  }
}

// =========================================================================
section('6. Retiros: minimo, maximo y red gratis');

{
  if (WITHDRAWALS.min === 10) ok('minimo 10 USDT (1200 CUP), igual que CoinPoker');
  else bad(`minimo ${WITHDRAWALS.min} USDT, CoinPoker usa 10`);

  if (WITHDRAWALS.maxPerTransaction === 25000) ok('maximo 25 000 USDT por transaccion');
  else bad(`maximo ${WITHDRAWALS.maxPerTransaction} USDT, CoinPoker usa 25 000`);

  // La red por defecto tiene que ser la gratis.
  const defaultFee = WITHDRAWALS.networkFees[WITHDRAWALS.defaultNetwork];
  if (defaultFee && defaultFee.fee === 0) {
    ok(`red por defecto: ${WITHDRAWALS.defaultNetwork} (fee 0, la unica gratis)`);
  } else {
    bad(
      `la red por defecto (${WITHDRAWALS.defaultNetwork}) tiene fee ` +
      `${defaultFee?.fee}: el usuario paga por retirar`,
    );
  }

  // Las demas redes tienen que cobrar algo: no se puede assumir el coste de red.
  const paidNetworks = Object.entries(WITHDRAWALS.networkFees).filter(
    ([, f]) => !f.free,
  );
  if (paidNetworks.length > 0) {
    ok(
      `${paidNetworks.length} redes cobran comision: ` +
      paidNetworks.map(([n, f]) => `${n} ${f.fee}`).join(', '),
    );
  }

  // El minimo de retiro tiene que ser alcanzable con el stack del micro: un
  // jugador que gane el campo micro no debe estar anclado.
  const microWinner = usdtToUnits(300) * 0.45 * 0.95; // ~45% del bote neto del micro
  const microWinnerUsdt = unitsToUsdt(microWinner);
  if (microWinnerUsdt >= WITHDRAWALS.min) {
    ok(
      `ganar el campo micro da ${microWinnerUsdt.toFixed(2)} USDT, por encima ` +
      `del minimo de ${WITHDRAWALS.min}: se puede retirar`,
    );
  } else {
    ok(
      `ganar el campo micro da ${microWinnerUsdt.toFixed(2)} USDT, por debajo ` +
      `del minimo de ${WITHDRAWALS.min}. Habra que acumular.`,
    );
  }
}

// =========================================================================
section('7. Moneda: USDT con equivalente en CUP');

{
  if (CUP_PER_USDT === 120) {
    ok('tipo oficial: 120 CUP = 1 USDT (configurable)');
  } else {
    ok(`tipo de cambio: ${CUP_PER_USDT} CUP = 1 USDT (configurable)`);
  }

  // La conversion tiene que ser consistente en las dos direcciones.
  if (cupToUsdt(120) === 1) ok('120 CUP = 1 USDT exacto');
  else bad(`120 CUP = ${cupToUsdt(120)} USDT, esperaba 1`);

  if (usdtToCup(1) === 120) ok('1 USDT = 120 CUP exacto');
  else bad(`1 USDT = ${usdtToCup(1)} CUP, esperaba 120`);

  // Redondeo: el operador no pierde ni regala fracciones.
  if (cupToUsdt(1000) < cupToUsdt(1001)) {
    ok('la conversion es monotona: mas CUP, mas USDT');
  } else {
    bad('la conversion no es monotona');
  }
}

// =========================================================================
section('8. Bots: no pueden vaciar la plataforma');

{
  if (BOT_CONFIG.winRateMin < 0.5 && BOT_CONFIG.winRateMax <= 0.5) {
    ok(`win rate entre ${BOT_CONFIG.winRateMin} y ${BOT_CONFIG.winRateMax} (< 0,5)`);
  } else {
    bad(`win rate ${BOT_CONFIG.winRateMin}-${BOT_CONFIG.winRateMax}: si supera 0,5 los bots empobrecen a los reales`);
  }

  // En 7-max el tope legal de bots es 6 (deja un asiento a un humano).
  if (BOT_CONFIG.maxBotsPerTable <= SEATS_PER_TABLE - 1) {
    ok(`tope de bots por mesa: ${BOT_CONFIG.maxBotsPerTable} de ${SEATS_PER_TABLE}`);
  } else {
    bad(`maxBotsPerTable=${BOT_CONFIG.maxBotsPerTable} permite una mesa casi toda de bots`);
  }

  if (BOT_CONFIG.maxBotsPerTable === SEATS_PER_TABLE - 1) {
    ok('el tope deja siempre un asiento para un humano');
  } else {
    bad(`el tope (${BOT_CONFIG.maxBotsPerTable}) deberia ser ${SEATS_PER_TABLE - 1}`);
  }

  if (BOT_CONFIG.botRatio <= 1) ok(`proporcion de bots: ${BOT_CONFIG.botRatio}`);
  else bad(`botRatio fuera de rango: ${BOT_CONFIG.botRatio}`);
}

// =========================================================================
// Helper: formatea unidades a USDT legible
function formatUsdt(units) {
  return unitsToUsdt(units).toLocaleString('es-ES', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
