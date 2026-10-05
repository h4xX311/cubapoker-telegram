/**
 * Pruebas del reparto del bote, el rake y el RTP.
 *
 * TODAS LAS CIFRAS SON UNIDADES INTERNAS (1/1000 de USDT), no USDT.
 * Ver `config/units.ts`: el motor trabaja con enteros, y con el campo micro de
 * 1 USDT la ciega grande son 10 unidades. Un test escrito en USDTaria estar
 * probando magnitudes mil veces mas grandes que las reales.
 *
 * No requieren base de datos.
 *
 * Ejecutar: node scripts/test-payout.js
 */

const {
  splitPrize,
  rakeOf,
  rakeOfField,
  fieldPayout,
  tierRtp,
  allTiersRtp,
  prizeDisclosure,
} = require('../dist/services/payout.service');
const {
  FIELD_PAYOUT,
  RAKE,
  TABLE_TIER_LIST,
  ECONOMY,
  SEATS_PER_TABLE,
} = require('../dist/config/product');
const {
  usdtToUnits,
  unitsToUsdt,
  formatUnits,
  blindsFor,
  UNITS_PER_USDT,
} = require('../dist/config/units');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Reparto, rake y RTP\x1b[0m');

// =========================================================================
section('0. Unidades: por que el micro es representable');

{
  if (UNITS_PER_USDT === 1000) ok('1000 unidades internas por USDT');
  else bad(`UNITS_PER_USDT=${UNITS_PER_USDT}; con 1 USDT de buy-in hace falta >= 1000`);

  // El caso que motiva todo: buy-in de 1 USDT con ciega grande de 0,02.
  const micro = TABLE_TIER_LIST.find(t => t.id === 't1');
  if (micro) {
    ok(`campo micro: buy-in ${micro.buyInUsdt} USDT = ${micro.buyInUnits} unidades`);

    if (micro.blinds.big > 0) {
      ok(
        `ciegas ${micro.blinds.small}/${micro.blinds.big} unidades ` +
        `(${unitsToUsdt(micro.blinds.small)}/${unitsToUsdt(micro.blinds.big)} USDT)`,
      );
    } else {
      bad('la ciega grande del micro es 0: nadie podria apostar');
    }

    // Stack en BB tiene que ser un stack de poker real, no 2 BB.
    if (micro.stackInBigBlinds >= 20 && micro.stackInBigBlinds <= 200) {
      ok(`stack del micro: ${micro.stackInBigBlinds} BB (rango de poker real)`);
    } else {
      bad(
        `stack del micro: ${micro.stackInBigBlinds} BB. Fuera de 20-200: ` +
        `o es shallow (no se puede jugar) o deep (no es un micro).`,
      );
    }

    // La ciega grande tiene que ser la mitad exacta del stack en BB.
    const bbInStack = micro.buyInUnits / micro.blinds.big;
    if (Number.isInteger(bbInStack)) {
      ok(`el stack son ${bbInStack} ciegas grandes exactas`);
    } else {
      // Aceptable si es casi entero: el redondeo de la division es inevitable.
      if (Math.abs(bbInStack - Math.round(bbInStack)) < 0.01) {
        ok(`el stack son ~${Math.round(bbInStack)} ciegas grandes`);
      } else {
        bad(`stack ${micro.buyInUnits} / ciega ${micro.blinds.big} = ${bbInStack}, no es un numero de BB`);
      }
    }
  } else {
    bad('no existe el tier t1 (micro)');
  }

  // Conversion en ambos sentidos.
  if (usdtToUnits(1) === 1000 && unitsToUsdt(1000) === 1) {
    ok('1 USDT <-> 1000 unidades, ida y vuelta exacta');
  } else {
    bad(`conversion rota: usdtToUnits(1)=${usdtToUnits(1)}, unitsToUsdt(1000)=${unitsToUsdt(1000)}`);
  }

  // Redondeo hacia ABAJO al entrar: el operador nunca regala fracciones.
  if (usdtToUnits(1.0009) === 1000) {
    ok('al entrar se redondea ABAJO (1,0009 USDT -> 1000 unidades)');
  } else {
    bad(`usdtToUnits(1.0009)=${usdtToUnits(1.0009)}; deberia truncar a 1000`);
  }

  // blindsFor: la grande es SIEMPRE el doble de la pequena.
  let doublesOk = true;
  for (const stack of [1, 5, 25, 100, 250, 1000]) {
    const b = blindsFor(stack);
    if (b.big !== b.small * 2) doublesOk = false;
    if (b.small < 1) doublesOk = false;
  }
  if (doublesOk) ok('la ciega grande es siempre el doble de la pequena, en todos los stacks');
  else bad('hay stacks donde la ciega grande no es el doble de la pequena');

  // Formato para la UI: sin decimales cuando es entero, sin ceros de mas.
  const fmtCases = [
    [0, '0'],
    [1000, '1'],
    [1500, '1,5'],
    [10, '0,01'],
    [5, '0,005'],
  ];
  let fmtOk = true;
  for (const [units, expected] of fmtCases) {
    if (formatUnits(units) !== expected) fmtOk = false;
  }
  if (fmtOk) ok('formatUnits muestra bien enteros, decimales y ceros');
  else {
    bad(
      'formatUnits no coincide: ' +
      fmtCases.map(([u, e]) => `${u}->${formatUnits(u)} (esperaba ${e})`).join(', '),
    );
  }
}

// =========================================================================
section('1. splitPrize: cuadra siempre, nunca inventa dinero');

{
  // El reparto ingenuo, para demostrar que el bug existia.
  const naive = (total, pcts) => {
    const base = Math.floor(total / pcts.length);
    const remainder = total - base * pcts.length;
    return pcts.map((p, i) => Math.floor((total * p) / 100) + (i < remainder ? 1 : 0));
  };

  let unders = 0;
  let overs = 0;
  let examples = [];
  for (let total = 1; total <= 2000; total++) {
    const sum = naive(total, FIELD_PAYOUT).reduce((a, b) => a + b, 0);
    if (sum < total) unders++;
    if (sum > total) {
      overs++;
      if (examples.length < 3) examples.push(`${total} -> ${naive(total, FIELD_PAYOUT).join('+')}`);
    }
  }

  if (unders + overs > 500) {
    ok(`el reparto ingenuo descuadra en ${unders + overs} de 2000 botes (${unders} cortos, ${overs} de mas)`);
  } else {
    bad(`el reparto ingenuo solo descuadra ${unders + overs} veces; el test no prueba lo que dice`);
  }

  if (overs > 0) {
    ok(`repartir DE MAS es lo grave: ${overs} botes darian dinero que no existe (${examples.join(', ')})`);
  }

  // El bueno: cuadra en todos.
  let failures = 0;
  let bad3 = [];
  for (let total = 1; total <= 5000; total++) {
    const parts = splitPrize(total, FIELD_PAYOUT);
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum !== total) {
      failures++;
      if (bad3.length < 3) bad3.push(`${total} -> ${parts.join('+')} = ${sum}`);
    }
  }

  if (failures === 0) ok('splitPrize cuadra en los 5000 botes de 1 a 5000 unidades');
  else bad(`splitPrize descuadra en ${failures} de 5000 botes. ${bad3.join(' | ')}`);

  // Casos reales de produccion, en unidades.
  const cases = [
    { label: 'freeroll de 1 USDT', total: usdtToUnits(1) },
    { label: 'freeroll de 50 USDT', total: usdtToUnits(50) },
    { label: 'freeroll de 200 USDT', total: usdtToUnits(200) },
    { label: 'campo micro completo', total: usdtToUnits(300) },
    { label: 'campo alto completo', total: usdtToUnits(30000) },
  ];

  for (const c of cases) {
    const parts = splitPrize(c.total, FIELD_PAYOUT);
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum === c.total) {
      ok(`${c.label}: ${parts.join(' + ')} = ${c.total}`);
    } else {
      bad(`${c.label}: ${parts.join('+')} = ${sum}, esperaba ${c.total}`);
    }
  }

  let negatives = 0;
  let oversized = 0;
  for (let total = 1; total <= 5000; total++) {
    for (const p of splitPrize(total, FIELD_PAYOUT)) {
      if (p < 0) negatives++;
      if (p > total) oversized++;
    }
  }
  if (negatives === 0) ok('ninguna posicion recibe un importe negativo');
  else bad(`${negatives} importes negativos`);
  if (oversized === 0) ok('ninguna posicion recibe mas que el bote');
  else bad(`${oversized} importes mayores que el bote`);

  // Estrictamente decreciente en botes de tamaño util.
  let violations = 0;
  for (let total = 100; total <= 5000; total++) {
    const p = splitPrize(total, FIELD_PAYOUT);
    for (let i = 1; i < p.length; i++) {
      if (p[i] >= p[i - 1]) violations++;
    }
  }
  if (violations === 0) ok('con botes de 100+ unidades el reparto es estrictamente decreciente');
  else bad(`${violations} casos >= 100 donde el reparto no decrece`);

  // Casos degenerados.
  if (splitPrize(0, FIELD_PAYOUT).length === 0) ok('splitPrize(0) devuelve lista vacia');
  else bad('splitPrize(0) devuelve elementos');

  if (splitPrize(500, []).length === 0) ok('splitPrize con lista vacia no explota');
  else bad('splitPrize(500, []) devuelve elementos');

  const single = splitPrize(777, [100]);
  if (single.length === 1 && single[0] === 777) ok('un solo tramo recibe el bote entero');
  else bad(`un solo tramo recibio ${single.join('+')}, esperaba 777`);
}

// =========================================================================
section('2. rakeOf (por mano) y rakeOfField (por campo)');

{
  // OJO: `RAKE.cashMax` esta en UNIDADES internas (0,1 USDT), no en USDT. Un
  // bote de 20 USDT = 20 000 unidades ya supera el tope, asi que rakea 100.
  // Eso es correcto: el tope por mano existe para que un bote enorme no se
  // lleve el 5% entero.
  if (rakeOf(2000) === 100) ok('rake del 5% sobre 2 000 unidades = 100 (justo en el tope)');
  else bad(`rake de 2 000 = ${rakeOf(2000)}, esperaba 100`);

  if (rakeOf(20000) === RAKE.cashMax) {
    ok(`bote de 20 USDT (20 000 unidades): rake topado en ${RAKE.cashMax} unidades (0,1 USDT)`);
  } else {
    bad(`bote de 20 000 unidades rakea ${rakeOf(20000)}, deberia toparse en ${RAKE.cashMax}`);
  }

  // Un bote del que el 5% supera el tope tiene que quedar en el tope.
  const overCap = Math.ceil(RAKE.cashMax * 100 / RAKE.cashPercentage) + 1;
  if (rakeOf(overCap) === RAKE.cashMax) {
    ok(`el rake por mano se topa en ${RAKE.cashMax} unidades (bote de ${overCap})`);
  } else {
    bad(`rake de ${overCap} unidades = ${rakeOf(overCap)}, deberia toparse en ${RAKE.cashMax}`);
  }

  if (rakeOf(RAKE.minPot - 1) === 0) ok(`sin rake por debajo de ${RAKE.minPot} unidades de bote`);
  else bad('hay rake en botes por debajo del minimo');

  // LA DISTINCION IMPORTANTE: el tope es POR MANO, no por campo.
  const bigField = usdtToUnits(1) * 300; // campo micro completo
  const fieldRake = rakeOfField(bigField);
  const handRake = rakeOf(bigField);

  if (fieldRake > handRake) {
    ok(
      `el tope por mano NO aplica al campo: ` +
      `campo de ${bigField} unidades rakea ${fieldRake}, no ${handRake}`,
    );
  } else {
    bad(
      `rakeOfField y rakeOf dan lo mismo (${fieldRake}). Si un campo usara el ` +
      'tope por mano, un campo de 300 USDT rakearia 100 unidades en vez de 15.',
    );
  }

  // Y el tope tiene que notarse en un bote enorme.
  const huge = 10_000_000;
  if (rakeOf(huge) === RAKE.cashMax && rakeOfField(huge) > RAKE.cashMax) {
    ok(
      `bote de ${huge}: por mano se topa en ${RAKE.cashMax}, por campo son ` +
      `${rakeOfField(huge)}`,
    );
  } else {
    bad(`tope mal aplicado: mano=${rakeOf(huge)}, campo=${rakeOfField(huge)}`);
  }

  // Un campo micro de 300 USDT tiene que rakear mas que una mano de 20 USDT.
  if (fieldRake > rakeOf(usdtToUnits(20))) {
    ok('el rake del campo completo supera al de una mano grande (obvio, pero se comprueba)');
  }
}

// =========================================================================
section('3. fieldPayout: el reparto del campo');

{
  const micro = TABLE_TIER_LIST.find(t => t.id === 't1');
  const p = fieldPayout(micro.buyInUnits, micro.fieldSize);

  const expectedGross = micro.buyInUnits * 300;
  if (p.grossPot === expectedGross) {
    ok(`campo micro completo: bote bruto ${formatUnits(p.grossPot)} USDT (${p.grossPot} unidades)`);
  } else {
    bad(`bote bruto ${p.grossPot}, esperaba ${expectedGross}`);
  }

  if (p.rake === Math.floor(expectedGross * 0.05)) {
    ok(`rake: ${formatUnits(p.rake)} USDT (5%)`);
  } else {
    bad(`rake ${p.rake}, esperaba ${Math.floor(expectedGross * 0.05)}`);
  }

  if (p.totalPaid === p.netPot) {
    ok(`el reparto entrega los ${formatUnits(p.netPot)} USDT del bote neto, exactos`);
  } else {
    bad(
      `el reparto entrega ${p.totalPaid} y el bote neto es ${p.netPot}: ` +
      `faltan ${p.netPot - p.totalPaid} unidades`,
    );
  }

  const winner = p.entries.find(e => e.position === 1);
  if (winner && winner.percentage === 45) {
    ok(`el 1o lugar se lleva el 45%: ${formatUnits(winner.amount)} USDT`);
  } else {
    bad(`el 1o lugar no cobra el 45%: ${JSON.stringify(winner)}`);
  }

  if (p.entries.length === FIELD_PAYOUT.length) {
    ok(`cobran ${p.entries.length} de ${micro.fieldSize} posiciones`);
  } else {
    bad(`cobran ${p.entries.length} posiciones, esperaba ${FIELD_PAYOUT.length}`);
  }

  console.log('    campo micro completo (bote neto ' + formatUnits(p.netPot) + ' USDT):');
  for (const e of p.entries) {
    console.log(
      `      ${e.position}o  ${String(e.percentage).padStart(2)}%  ` +
      `${formatUnits(e.amount).padStart(12)} USDT`,
    );
  }
  console.log('');

  // Media ocupacion: el bote baja proporcionalmente.
  const half = fieldPayout(micro.buyInUnits, 150);
  if (half.netPot === Math.floor(expectedGross / 2 * 0.95)) {
    ok(`al 50%: bote neto ${formatUnits(half.netPot)} USDT (la mitad)`);
  } else {
    bad(`al 50%: bote neto ${half.netPot}, esperaba ${Math.floor(expectedGross / 2 * 0.95)}`);
  }

  if (half.totalPaid === half.netPot) ok('el campo al 50% tambien cuadra');
  else bad(`el campo al 50% descuadra: ${half.totalPaid} vs ${half.netPot}`);

  // Vacio y negativo.
  if (fieldPayout(micro.buyInUnits, 0).totalPaid === 0) ok('campo vacio: no reparte nada');
  else bad('campo vacio repartio algo');

  if (fieldPayout(micro.buyInUnits, -10).totalPaid === 0) ok('jugadores negativos: no reparte nada');
  else bad('jugadores negativos repartieron');
}

// =========================================================================
section('4. RTP: 95% en los cuatro niveles');

{
  console.log('    nivel   buy-in        CIP      Bote bruto      Rake      Bote neto      1o');
  const rtps = [];
  for (const tier of TABLE_TIER_LIST) {
    const p = fieldPayout(tier.buyInUnits, tier.fieldSize);
    const rtp = tierRtp(tier.buyInUnits, tier.fieldSize);
    rtps.push(rtp);
    const w = p.entries.find(e => e.position === 1);

    console.log(
      '    ' + tier.label.padEnd(8) +
      (formatUnits(tier.buyInUnits) + ' USDT').padEnd(14) +
      String(tier.stackInBigBlinds).padStart(5) +
      formatUnits(p.grossPot).padStart(14) + ' USDT' +
      formatUnits(p.rake).padStart(11) + ' USDT' +
      formatUnits(p.netPot).padStart(14) + ' USDT' +
      formatUnits(w ? w.amount : 0).padStart(11) + ' USDT',
    );
  }
  console.log('');

  for (let i = 0; i < TABLE_TIER_LIST.length; i++) {
    const tier = TABLE_TIER_LIST[i];
    const rtp = rtps[i];
    if (rtp >= 0.9 && rtp <= 0.99) {
      ok(`${tier.label} (${tier.buyInUsdt} USDT): RTP ${(rtp * 100).toFixed(2)}%`);
    } else {
      bad(`${tier.label}: RTP ${(rtp * 100).toFixed(2)}%, fuera del rango sano (90-99%)`);
    }
  }

  // El RTP NO debe depender del nivel.
  const spread = Math.max(...rtps) - Math.min(...rtps);
  if (spread < 0.005) {
    ok(
      `el RTP es identico en los 4 niveles (dif ${(spread * 100).toFixed(3)} pp): ` +
      'el rake no cambia con el stake',
    );
  } else {
    bad(`el RTP varia ${(spread * 100).toFixed(3)} pp entre niveles`);
  }

  // Y no puede superar el 95%.
  for (let i = 0; i < TABLE_TIER_LIST.length; i++) {
    if (rtps[i] <= 0.95 + 0.001) {
      ok(`${TABLE_TIER_LIST[i].label}: nunca supera el 95% (el jugador no gana a largo plazo)`);
    } else {
      bad(`${TABLE_TIER_LIST[i].label}: RTP ${(rtps[i] * 100).toFixed(2)}% > 95%`);
    }
  }

  // El ladder tiene que escalar: campo mas caro = premio mayor.
  const prizes = TABLE_TIER_LIST.map(t => {
    const p = fieldPayout(t.buyInUnits, t.fieldSize);
    return p.entries.find(e => e.position === 1)?.amount ?? 0;
  });
  let ascending = true;
  for (let i = 1; i < prizes.length; i++) {
    if (prizes[i] <= prizes[i - 1]) ascending = false;
  }
  if (ascending) {
    ok(
      'el ladder escala: ' +
      prizes.map((v, i) => `${TABLE_TIER_LIST[i].label} ${formatUnits(v)}`).join(' < '),
    );
  } else {
    bad(
      'el ladder NO escala: ' +
      prizes.map((v, i) => `${TABLE_TIER_LIST[i].label} ${formatUnits(v)}`).join(', '),
    );
  }
}

// =========================================================================
section('5. Coherencia entre configuracion y texto');

{
  if (Math.abs(ECONOMY.netPotShare - 0.95) < 0.001) {
    ok('netPotShare = 95%, coherente con el rake del 5%');
  } else {
    bad(`netPotShare = ${ECONOMY.netPotShare}, incoherente con rake ${RAKE.cashPercentage}%`);
  }

  // El reparto se aplica al bote NETO, no al bruto. Si se aplicara al bruto, el
  // operador se quedaria sin el rake.
  if (FIELD_PAYOUT.reduce((a, b) => a + b, 0) === 100) {
    ok('FIELD_PAYOUT suma 100: el reparto aplica al bote ya descontado');
  } else {
    bad(`FIELD_PAYOUT suma ${FIELD_PAYOUT.reduce((a, b) => a + b, 0)}%, no 100`);
  }

  if (RAKE.freerollPercentage === 0) {
    ok('el freeroll no rakea: el bote del campo es el premio entero');
  } else {
    bad(`el freeroll rakea ${RAKE.freerollPercentage}%, el premio no cuadra`);
  }

  const d = prizeDisclosure();
  if (/bote/.test(d)) ok('la transparencia dice que el premio sale del bote');
  else bad('la transparencia debe decir de donde sale el premio');

  if (SEATS_PER_TABLE === 7) {
    ok('mesa fisica 7-max: el reparto es por posicion en el campo');
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
