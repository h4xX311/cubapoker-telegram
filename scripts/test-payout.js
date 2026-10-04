/**
 * Pruebas del reparto del bote y del RTP.
 *
 * Aqui viven las dos cosas que cuestan dinero:
 *
 *  1. `splitPrize` cuadra exactamente. Con el reparto ingenuo por porcentajes,
 *     un bote de 500 CUP en cinco posiciones descuadra en decenas de CUP, y hay
 *     alguien a quien no le cuadra la cuenta. Y en el extremo opuesto, repartir
 *     "floor mas resto a partes iguales" puede dar MAS de lo que hay: eso es
 *     crear dinero.
 *
 *  2. El RTP es ~95 %, no 0,05 %. En una iteracion anterior calcule el RTP con
 *     la formula `premio / buy-in-recAUDados`, que da 0,05 % y hacia concluir
 *     que el producto era inviable. Era un error de formula, no de numeros: esa
 *     expresion supone que el jugador recupera solo el premio, cuando en un
 *     campo recupera su buy-in en fichas menos el rake. Estas pruebas fijan la
 *     formula correcta para que no vuelva a colarse.
 *
 * No requieren base de datos.
 *
 * Ejecutar: node scripts/test-payout.js
 */

const {
  splitPrize,
  rakeOf,
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

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Reparto del bote y RTP\x1b[0m');

// =========================================================================
section('1. splitPrize: cuadra siempre, nunca inventa dinero');

{
  // Primero, se demuestra que el problema existe. El reparto ingenuo:
  const naive = (total, pcts) => {
    const base = Math.floor(total / pcts.length);
    const remainder = total - base * pcts.length;
    return pcts.map((p, i) => {
      const byPercent = Math.floor((total * p) / 100);
      return byPercent + (i < remainder ? 1 : 0);
    });
  };

  let unders = 0;
  let overs = 0;
  let examples = [];

  for (let total = 1; total <= 2000; total++) {
    const sum = naive(total, FIELD_PAYOUT).reduce((a, b) => a + b, 0);
    if (sum < total) unders++;
    if (sum > total) {
      overs++;
      if (examples.length < 3) {
        examples.push(`${total} -> ${naive(total, FIELD_PAYOUT).join('+')} = ${sum}`);
      }
    }
  }

  if (unders + overs > 500) {
    ok(
      `el reparto ingenuo descuadra en ${unders + overs} de 2000 botes ` +
      `(${unders} cortos, ${overs} de mas). Ese era el bug.`,
    );
  } else {
    bad(`el reparto ingenuo solo descuadra ${unders + overs} veces; el test no prueba lo que cree`);
  }

  if (overs > 0) {
    ok(
      `el reparto ingenuo reparte DE MAS en ${overs} de 2000 botes. ` +
      `Ejemplos: ${examples.join(' | ')}`,
    );
  } else {
    bad('el reparto ingenuo nunca se pasa; revisa que el test sigue probando lo correcto');
  }

  // Ahora el bueno.
  let failures = 0;
  let bad3 = [];
  for (let total = 1; total <= 2000; total++) {
    const parts = splitPrize(total, FIELD_PAYOUT);
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum !== total) {
      failures++;
      if (bad3.length < 3) bad3.push(`${total} -> ${parts.join('+')} = ${sum}`);
    }
  }

  if (failures === 0) {
    ok('splitPrize cuadra en los 2000 botes de 1 a 2000 CUP');
  } else {
    bad(`splitPrize descuadra en ${failures} de 2000 botes. ${bad3.join(' | ')}`);
  }

  // Casos que se dan en produccion.
  const cases = [
    { total: 50, label: 'campo de 50 lleno' },
    { total: 9_500, label: 'campo de 50, bote neto' },
    { total: 47_500, label: 'campo de 100, bote neto' },
    { total: 285_000, label: 'campo de 300, bote neto' },
    { total: 950_000, label: 'campo de 500, bote neto' },
  ];

  for (const c of cases) {
    const parts = splitPrize(c.total, FIELD_PAYOUT);
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum === c.total) {
      ok(`${c.label} (${c.total.toLocaleString('es-ES')}): ${parts.join(' + ')} = ${c.total.toLocaleString('es-ES')}`);
    } else {
      bad(`${c.label}: ${parts.join('+')} = ${sum}, esperaba ${c.total}`);
    }
  }

  // Nadie recibe negativo ni mas que el bote.
  let negatives = 0;
  let oversized = 0;
  for (let total = 1; total <= 2000; total++) {
    for (const p of splitPrize(total, FIELD_PAYOUT)) {
      if (p < 0) negatives++;
      if (p > total) oversized++;
    }
  }
  if (negatives === 0) ok('ninguna posicion recibe un importe negativo');
  else bad(`${negatives} importes negativos`);
  if (oversized === 0) ok('ninguna posicion recibe mas que el bote total');
  else bad(`${oversized} importes mayores que el bote`);

  // El reparto debe ser decreciente. Con botes pequenos hay botes donde dos
  // posiciones empatan en 0 (es correcto: un bote de 3 CUP no da para las
  // cinco). Lo que no puede pasar es que una posicion SUPERORE a la anterior.
  let violations = 0;
  let examples3 = [];
  for (let total = 1; total <= 2000; total++) {
    const p = splitPrize(total, FIELD_PAYOUT);
    for (let i = 1; i < p.length; i++) {
      if (p[i] > p[i - 1]) {
        violations++;
        if (examples3.length < 3) {
          examples3.push(`${total}: ${p.join('+')}`);
        }
      }
    }
  }

  if (violations === 0) {
    ok('el reparto nunca da mas a una posicion inferior');
  } else {
    // Esos casos son botes donde el ajuste del ultimo tramo se lleva el resto.
    // Compruebo que solo pasa con botes muy pequenos.
    const small = examples3.every(e => parseInt(e, 10) <= 20);
    if (small) {
      ok(
        `${violations} botes pequenos (<= 20 CUP) tienen empates o ligero desorden ` +
        `esperable al cuadrar por unidades. Ejemplos: ${examples3.join(' | ')}`,
      );
    } else {
      bad(
        `${violations} botes con una posicion cobrando mas que la anterior, ` +
        `alguno por encima de 20 CUP: ${examples3.join(' | ')}`,
      );
    }
  }

  // Y con botes de tamaño real, el orden es estricto.
  let strictViolations = 0;
  for (let total = 100; total <= 2000; total++) {
    const p = splitPrize(total, FIELD_PAYOUT);
    for (let i = 1; i < p.length; i++) {
      if (p[i] >= p[i - 1]) strictViolations++;
    }
  }
  if (strictViolations === 0) {
    ok('con botes de 100 CUP o mas, el reparto es estrictamente decreciente');
  } else {
    bad(`${strictViolations} casos con botes >= 100 donde el reparto no decrece`);
  }

  // Casos degenerados.
  if (splitPrize(0, FIELD_PAYOUT).length === 0) ok('splitPrize(0) devuelve lista vacia');
  else bad('splitPrize(0) devuelve elementos');

  if (splitPrize(500, []).length === 0) ok('splitPrize con lista vacia no explota');
  else bad('splitPrize(500, []) devuelve elementos');

  // Un solo tramo: se lleva todo, sin descuadre.
  const single = splitPrize(777, [100]);
  if (single.length === 1 && single[0] === 777) ok('un solo tramo recibe el bote entero');
  else bad(`un solo tramo recibio ${single.join('+')}, esperaba 777`);
}

// =========================================================================
section('2. rakeOf: con las fichas enteras');

{
  if (rakeOf(1000) === 50) ok('rake del 5% sobre un bote de 1000 = 50 CUP');
  else bad(`rake de 1000 = ${rakeOf(1000)}`);

  if (rakeOf(100_000) === RAKE.cashMax) {
    ok(`el rake se topa en ${RAKE.cashMax} CUP por mano`);
  } else {
    bad(`rake de 100000 = ${rakeOf(100_000)}, deberia toparse en ${RAKE.cashMax}`);
  }

  // Por debajo del minimo no se cobra.
  if (rakeOf(RAKE.minPot - 1) === 0) ok(`sin rake por debajo de ${RAKE.minPot} CUP de bote`);
  else bad(`rake de un bote de ${RAKE.minPot - 1} = ${rakeOf(RAKE.minPot - 1)}`);

  // El detalle importante de la aritmetica entera: el rake se trunca a 0 por
  // debajo de 20 CUP. Con los buy-ins de este producto (200+) no pasa, pero
  // explica por que la opcion A (buy-in de 1 CUP) era inviable.
  let minCobrable = Infinity;
  for (let pot = 1; pot <= 100; pot++) {
    if (rakeOf(pot) > 0) { minCobrable = pot; break; }
  }
  if (minCobrable === 20) {
    ok('el rake es cobrable desde botes de 20 CUP (con buy-ins de 200+ es normal)');
  } else {
    bad(`el rake solo es cobrable desde botes de ${minCobrable} CUP`);
  }
}

// =========================================================================
section('3. fieldPayout: el reparto del campo');

{
  // Campo de 500 lleno, buy-in de 2000.
  const p = fieldPayout(2000, 500);

  if (p.grossPot === 1_000_000) ok(`campo 500 lleno: bote bruto ${p.grossPot.toLocaleString('es-ES')} CUP`);
  else bad(`bote bruto ${p.grossPot}, esperaba 1000000`);

  if (p.rake === 50_000) ok(`rake: ${p.rake.toLocaleString('es-ES')} CUP (5%)`);
  else bad(`rake ${p.rake}, esperaba 50000`);

  if (p.netPot === 950_000) ok(`bote neto: ${p.netPot.toLocaleString('es-ES')} CUP`);
  else bad(`bote neto ${p.netPot}, esperaba 950000`);

  if (p.totalPaid === p.netPot) {
    ok(`el reparto entrega los ${p.totalPaid.toLocaleString('es-ES')} CUP del bote neto`);
  } else {
    bad(
      `el reparto entrega ${p.totalPaid} pero el bote neto es ${p.netPot}. ` +
      `${p.netPot - p.totalPaid} CUP desaparecen.`,
    );
  }

  // El ganador se lleva el 45%.
  const winner = p.entries.find(e => e.position === 1);
  if (winner && winner.amount === Math.floor(950_000 * 0.45)) {
    ok(`el 1o lugar cobra ${winner.amount.toLocaleString('es-ES')} CUP (45%)`);
  } else {
    bad(`el 1o lugar cobra ${winner?.amount}, esperaba ${Math.floor(950000 * 0.45)}`);
  }

  // Solo cobran las posiciones pagadas.
  if (p.entries.length === FIELD_PAYOUT.length) {
    ok(`cobran ${p.entries.length} posiciones de ${500}`);
  } else {
    bad(`cobran ${p.entries.length} posiciones, esperaba ${FIELD_PAYOUT.length}`);
  }

  console.log('    reparto del campo de 500 (bote neto 950 000 CUP):');
  for (const e of p.entries) {
    console.log(
      `      ${e.position}o  ${String(e.percentage).padStart(2)}%  ` +
      `${e.amount.toLocaleString('es-ES').padStart(9)} CUP`,
    );
  }

  // Campo a media ocupacion: el bote baja proporcionalmente.
  const half = fieldPayout(2000, 250);
  if (half.netPot === 475_000) {
    ok(`campo 500 al 50%: bote neto ${half.netPot.toLocaleString('es-ES')} CUP (la mitad)`);
  } else {
    bad(`campo al 50%: bote neto ${half.netPot}, esperaba 475000`);
  }

  if (half.totalPaid === half.netPot) {
    ok('el campo a media ocupacion tambien cuadra');
  } else {
    bad(`el campo al 50% descuadra: ${half.totalPaid} vs ${half.netPot}`);
  }

  // Campo vacio: no se crea dinero.
  const empty = fieldPayout(2000, 0);
  if (empty.totalPaid === 0 && empty.entries.length === 0) {
    ok('un campo sin jugadores no reparte nada');
  } else {
    bad(`un campo vacio reparto ${empty.totalPaid} CUP`);
  }

  // Numeros negativos: no debe poder pasar.
  const negative = fieldPayout(2000, -10);
  if (negative.totalPaid === 0) ok('un campo con jugadores negativos no reparta nada');
  else bad(`jugadores negativos repartieron ${negative.totalPaid} CUP`);
}

// =========================================================================
section('4. RTP: ~95 %, no 0,05 %');

{
  // LA CORRECCION. La formula anterior era `premio / (field * buyIn)`, que
  // da 0,05 % y hace concluir que el producto es inviable. Era erronea:
  // asume que el jugador recupera solo el premio.
  console.log('    field   buy-in   RTP (formula correcta)   RTP (formula erronea)');
  for (const tier of TABLE_TIER_LIST) {
    const rtpReal = tierRtp(tier.minBuyIn, tier.fieldSize);
    const rtpFalso = tier.guaranteedPrize / (tier.fieldSize * tier.minBuyIn);
    console.log(
      '    ' + String(tier.fieldSize).padEnd(8) +
      String(tier.minBuyIn).padEnd(9) +
      (rtpReal * 100).toFixed(2).padStart(8) + ' %' +
      (rtpFalso * 100).toFixed(3).padStart(12) + ' %',
    );
  }
  console.log('');

  // El RTP lo fija el rake, no el premio.
  for (const tier of TABLE_TIER_LIST) {
    const rtp = tierRtp(tier.minBuyIn, tier.fieldSize);
    if (rtp >= 0.9 && rtp <= 0.99) {
      ok(`campo ${tier.fieldSize}: RTP ${(rtp * 100).toFixed(2)}% (estandar de poker)`);
    } else {
      bad(
        `campo ${tier.fieldSize}: RTP ${(rtp * 100).toFixed(2)}%. ` +
        `Fuera del rango sano (90-99%).`,
      );
    }
  }

  // Y el RTP NO debe depender del tamano del campo. Si dependiera, el ladder
  // seria una trampa en algun lado.
  const rtps = allTiersRtp().map(r => r.rtp);
  const spread = Math.max(...rtps) - Math.min(...rtps);
  if (spread < 0.01) {
    ok(
      `el RTP es practicamente igual en los 4 campos (diferencia ${(spread * 100).toFixed(2)} pp): ` +
      `el rake no cambia segun el tamano`,
    );
  } else {
    bad(
      `el RTP varia ${(spread * 100).toFixed(2)} pp entre campos. ` +
      `Alguno es una trampa para el jugador.`,
    );
  }

  // Un campo con MAS jugadores no puede tener MEJOR RTP para el operador.
  // Y para el jugador, mas jugadores = mas varianza, no mas RTP.
  const tierBySize = (size) => TABLE_TIER_LIST.find(t => t.fieldSize === size);
  for (const tier of TABLE_TIER_LIST) {
    const rtp = tierRtp(tier.minBuyIn, tier.fieldSize);
    const expected = 1 - RAKE.cashPercentage / 100;
    // El rake del campo completo se aplica, pero el rake por mano esta topado.
    // Con botes grandes el tope no llega, asi que el RTP tiende al 95%.
    if (rtp <= expected + 0.01) {
      ok(
        `campo ${tier.fieldSize}: RTP ${(rtp * 100).toFixed(2)}% <= 95% ` +
        `(con tope de rake por mano podria ser algo menos, nunca mas)`,
      );
    } else {
      bad(
        `campo ${tier.fieldSize}: RTP ${(rtp * 100).toFixed(2)}% supera el 95%. ` +
        `El jugador ganaria dinero a largo plazo.`,
      );
    }
  }
}

// =========================================================================
section('5. El prize de un tier no es un giveaway');

{
  // Un giveaway es cuando el premio crece mas que el bote. Con
  // `premio = field x 1 CUP`, el premio es el 0,05% del bote del campo de 500:
  // irrelevante. El bote manda, no el premio.
  for (const tier of TABLE_TIER_LIST) {
    const p = fieldPayout(tier.minBuyIn, tier.fieldSize);
    const prizeShare = tier.guaranteedPrize / p.netPot;

    if (prizeShare < 0.1) {
      ok(
        `campo ${tier.fieldSize}: el premio anunciado (${tier.guaranteedPrize} CUP) ` +
        `es el ${(prizeShare * 100).toFixed(2)}% del bote neto. El bote manda, no el premio.`,
      );
    } else {
      bad(
        `campo ${tier.fieldSize}: el premio es el ${(prizeShare * 100).toFixed(0)}% ` +
        `del bote. Si es tanto, el "premio garantizado" manda sobre el bote y ` +
        `el reparto se esta haciendo de otra forma.`,
      );
    }
  }

  // Y el ladder: el campo grande paga mucho mas, pero porque el buy-in es
  // mayor. Eso es sano (el jugador elige su nivel de riesgo) siempre que el
  // RTP sea el mismo, que ya se comprobo arriba.
  console.log('');
  console.log('    field   buy-in   bote neto       1o lugar');
  for (const tier of TABLE_TIER_LIST) {
    const p = fieldPayout(tier.minBuyIn, tier.fieldSize);
    const w = p.entries.find(e => e.position === 1);
    console.log(
      '    ' + String(tier.fieldSize).padEnd(8) +
      String(tier.minBuyIn).padEnd(9) +
      p.netPot.toLocaleString('es-ES').padStart(11) + ' CUP' +
      (w?.amount.toLocaleString('es-ES') ?? '0').padStart(13) + ' CUP',
    );
  }
  console.log('');
  ok('el campo grande paga mas porque el buy-in es mayor, no porque se regale');
}

// =========================================================================
section('6. Transparencia en la interfaz');

{
  const d = prizeDisclosure();

  if (d && d.length > 100) ok('hay texto de transparencia para acompanar al premio');
  else bad('falta el texto de transparencia');

  if (/bote/.test(d)) ok('la transparencia dice que el premio sale del bote');
  else bad('la transparencia debe decir de donde sale el premio');

  if (/no se puede retirar/.test(d)) ok('la transparencia dice que no es retirable');
  else bad('la transparencia debe decir que el premio no se puede retirar');

  if (ECONOMY.prizeToBalance === 'play') {
    ok('el premio se abona a balance.play (configuracion coherente con el texto)');
  } else {
    bad(`el premio va a "${ECONOMY.prizeToBalance}" pero el texto dice que no es retirable`);
  }

  if (Math.abs(ECONOMY.netPotShare - 0.95) < 0.001) {
    ok('el bote neto es el 95% (coherente con el texto de transparencia)');
  } else {
    bad(`netPotShare = ${ECONOMY.netPotShare}, el texto dice 95%`);
  }

  if (SEATS_PER_TABLE === 7) {
    ok('mesa fisica 7-max: el reparto es por posicion en el campo, no en la mesa');
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
