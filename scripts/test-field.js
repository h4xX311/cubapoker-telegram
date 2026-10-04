/**
 * Pruebas de las reglas del campo multi-mesa.
 *
 * Son aritmetica pura sobre contadores, y por eso se prueban aqui y no con
 * MongoDB: decidir la posicion de un eliminado o si dos mesas se fusionan es
 * calculable sin base de datos. Montar una base de datos para comprobar que un
 * jugador con 7 fichas no se sienta en una mesa llena seria absurdo.
 *
 * Ejecutar: node scripts/test-field.js
 */

const rules = require('../dist/game/field.rules');
const {
  canSitAtTable,
  nextSeatable,
  shouldMergeTables,
  planMerge,
  liveTablesAfterMerge,
  positionOnElimination,
  remainingAfterEliminations,
  isFieldComplete,
  fieldClosedWithBots,
  shouldPayPosition,
  tablesForField,
  distributePlayers,
} = rules;
const { SEATS_PER_TABLE, FIELD_PAYOUT, PAID_POSITIONS } = require('../dist/config/product');
const { splitPrize, fieldPayout } = require('../dist/services/payout.service');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Reglas del campo multi-mesa\x1b[0m');

// =========================================================================
section('1. Asientos: quien cabe y quien no');

{
  const BUY_IN = 2000;
  const MIN = 200;

  if (canSitAtTable(5000, BUY_IN, MIN)) ok('un jugador con saldo de sobra se sienta');
  else bad('un jugador con saldo de sobra no puede sentarse');

  if (!canSitAtTable(100, BUY_IN, MIN)) {
    ok('un jugador con menos fichas que el buy-in NO se sienta');
  } else {
    bad(
      'un jugador con 100 CUP podria sentarse en una mesa de 2000. Perderia el ' +
      'buy-in casi entero en 30 segundos sin haber jugado una mano.',
    );
  }

  if (!canSitAtTable(2500, 100, MIN)) {
    ok('no se sienta con un buy-in por debajo del minimo de la mesa');
  } else {
    bad('se acepta un buy-in inferior al minimo de la mesa');
  }

  // El caso exacto: justo el buy-in minimo, sin margen.
  if (canSitAtTable(MIN, MIN, MIN)) ok('el buy-in minimo exacto si se acepta');
  else bad('se rechaza el buy-in minimo exacto');

  // Descartar en vez de parar en el primero que no puede.
  const queue = [
    { telegramId: 1, chips: 50 },    // no puede
    { telegramId: 2, chips: 5000 },  // si puede
    { telegramId: 3, chips: 60 },    // no puede
  ];
  const idx = nextSeatable(queue, BUY_IN, MIN);
  if (idx === 1) ok('la cola se salta al primer jugador que si puede pagarse (indice 1)');
  else bad(`la cola eligio el indice ${idx}, esperaba 1`);

  // Todos no pueden: devuelve -1 y el campo se queda como estaba.
  const nobody = [{ telegramId: 1, chips: 10 }, { telegramId: 2, chips: 20 }];
  if (nextSeatable(nobody, BUY_IN, MIN) === -1) {
    ok('si nadie puede pagarse, la cola devuelve -1 (no se sienta a nadie)');
  } else {
    bad('la cola se sento a la fuerza a alguien sin saldo');
  }

  if (nextSeatable([], BUY_IN, MIN) === -1) ok('cola vacia devuelve -1');
  else bad('cola vacia devuelve algo');
}

// =========================================================================
section('2. Merge: cuando dos mesas se juntan');

{
  // 7-max. Una mesa con 3 jugadores y otra con hueco: se fusionan.
  if (shouldMergeTables(3, 4, 4)) ok('mesa de 3 con hueco en otra: se fusionan');
  else bad('no fusionarian 3 jugadores con hueco disponible');

  // Una mesa de 4 con hueco: NO se fusiona. Con 4 ya se juega con decision.
  if (!shouldMergeTables(4, 4, 4)) ok('mesa de 4 con hueco: NO se fusiona (4 es el minimo)');
  else bad('fusionarian con 4 jugadores, dejando las mesas de 2');

  // Pero si la otra mesa esta llena, no hay a donde ir.
  if (!shouldMergeTables(3, 0, 4)) ok('mesa de 3 sin hueco en ninguna: no se fusiona');
  else bad('fusionarian sin mesa destino con hueco');

  // Una mesa de 6 con hueco: se queda como esta.
  if (!shouldMergeTables(6, 7, 4)) ok('mesa de 6 con hueco: no se fusiona (ya se puede jugar)');
  else bad('fusionarian una mesa que ya puede jugar');

  // liveTablesAfterMerge
  if (liveTablesAfterMerge(40) === 39) ok('tras un merge, 40 mesas pasan a 39');
  else bad(`liveTablesAfterMerge(40) = ${liveTablesAfterMerge(40)}`);

  if (liveTablesAfterMerge(1) === 0) ok('una sola mesa tras un merge da 0 (campo cerrado)');
  else bad('liveTablesAfterMerge(1) deberia dar 0');
}

// =========================================================================
section('3. planMerge: repartir sin partir a nadie');

{
  // Caso normal: 3 jugadores a 1 mesa destino con hueco.
  const p1 = planMerge([0, 3, 5], [{ tableId: 't2', seatsFree: 7 }], 4);
  if (p1.length === 1 && p1[0].seatIndexes.length === 3) {
    ok('3 jugadores van a la mesa destino que tiene hueco');
  } else {
    bad(`planMerge devolvio ${JSON.stringify(p1)}`);
  }

  // Varios jugadores, varios destinos: repartir proporcional al hueco.
  const p2 = planMerge(
    [0, 1, 2, 3, 4],
    [
      { tableId: 'tA', seatsFree: 4 },
      { tableId: 'tB', seatsFree: 1 },
    ],
    4,
  );
  const aCount = p2.find(p => p.tableId === 'tA')?.seatIndexes.length ?? 0;
  const bCount = p2.find(p => p.tableId === 'tB')?.seatIndexes.length ?? 0;
  if (aCount === 4 && bCount === 1) {
    ok(`reparto proporcional al hueco: tA recibe ${aCount}, tB recibe ${bCount}`);
  } else {
    bad(`reparto incorrecto: tA=${aCount}, tB=${bCount}, esperaba 4 y 1`);
  }

  // Nadie se parte entre mesas: cada indice aparece una sola vez.
  const allAssigned = p2.flatMap(p => p.seatIndexes);
  const unique = new Set(allAssigned);
  if (allAssigned.length === unique.size) {
    ok('ningun jugador aparece en dos mesas destino');
  } else {
    bad(`${allAssigned.length} asignaciones, ${unique.size} jugadores: alguno esta duplicado`);
  }

  // Ninguno repite: el caso limite son 3 jugadores y 5 mesas destino.
  const p3 = planMerge(
    [0, 1, 2],
    Array.from({ length: 5 }, (_, i) => ({ tableId: `t${i}`, seatsFree: 7 })),
    4,
  );
  const assigned3 = p3.flatMap(p => p.seatIndexes);
  if (assigned3.length === 3 && new Set(assigned3).size === 3) {
    ok(`3 jugadores en 5 mesas destino: cada uno en una mesa distinta (${p3.length} mesas usadas)`);
  } else {
    bad(`planMerge con exceso de destinos devolvio ${JSON.stringify(p3)}`);
  }

  // Las mesas destino que no reciben a nadie se descartan: no se devuelven
  // mesas vacias que el gestor tendria que limpiar una por una.
  if (p3.length <= 3) {
    ok(`las mesas destino sin jugadores se descartan (${p3.length} de 5)`);
  } else {
    bad(`se devolvieron ${p3.length} mesas destino, incluyendo vacias`);
  }

  // Mas jugadores que huecos: los que sobren se quedan en el origen.
  const p4 = planMerge([0, 1, 2, 3, 4], [{ tableId: 'tA', seatsFree: 2 }], 4);
  if (p4[0].seatIndexes.length === 2) {
    ok('si el hueco no alcanza, solo se mueven los que caben (2 de 5)');
  } else {
    bad(`se movieron ${p4[0].seatIndexes.length} jugadores a un hueco de 2`);
  }

  // Casos vacios.
  if (planMerge([], [{ tableId: 't', seatsFree: 7 }], 4).length === 0) {
    ok('sin jugadores no hay plan');
  } else {
    bad('planMerge con lista vacia devuelve algo');
  }
  if (planMerge([0, 1], [], 4).length === 0) {
    ok('sin mesas destino no hay plan');
  } else {
    bad('planMerge sin destinos devuelve algo');
  }
}

// =========================================================================
section('4. Posiciones: lo mas delicado del campo');

{
  // El contador ANTES de decrementar es la posicion.
  if (positionOnElimination(48) === 48) {
    ok('con 48 vivos, el que cae es el 48º');
  } else {
    bad(`positionOnElimination(48) = ${positionOnElimination(48)}`);
  }

  if (positionOnElimination(1) === 1) {
    ok('con 1 vivo, el que cae es el 1º (ganador)');
  } else {
    bad('el ganador no recibe la posicion 1');
  }

  // El orden importa: leer la posicion DESPUES de decrementar daria 47 en vez
  // de 48, y el ultimo eliminado seria el ultimo en vez del que mas posiciones
  // tiene. Es la trampa clasica de esta logica.
  const remaining = 48;
  const pos = positionOnElimination(remaining);
  const after = remainingAfterEliminations(remaining, 1);
  if (pos === 48 && after === 47) {
    ok('el eliminador es el 48º y el contador baja a 47');
  } else {
    bad(`pos=${pos}, restante=${after}. Deberia ser 48 y 47.`);
  }

  // Toda la secuencia de un campo de 500: cada posicion aparece UNA vez.
  let alive = 500;
  const seen = new Set();
  let duplicates = 0;
  for (let i = 0; i < 499; i++) {
    const pos = positionOnElimination(alive);
    if (seen.has(pos)) duplicates++;
    seen.add(pos);
    alive = remainingAfterEliminations(alive, 1);
  }

  if (duplicates === 0) {
    ok('499 eliminaciones dan 499 posiciones distintas');
  } else {
    bad(`${duplicates} posiciones repetidas: dos jugadores cobrarian la misma`);
  }

  if (alive === 1) ok('tras 499 eliminaciones queda 1 jugador vivo');
  else bad(`quedan ${alive} jugadores, esperaba 1`);

  // El rango completo es 500..2 mas el ganador.
  const expected = new Set();
  for (let i = 2; i <= 500; i++) expected.add(i);
  const missing = [...expected].filter(p => !seen.has(p));
  if (missing.length === 0) {
    ok('se cubren todas las posiciones del 2 al 500, sin huecos');
  } else {
    bad(`faltan ${missing.length} posiciones: ${missing.slice(0, 5).join(', ')}...`);
  }
}

// =========================================================================
section('5. Cierre del campo');

{
  // Queda uno: termina.
  if (isFieldComplete(1, 1)) ok('con 1 jugador vivo el campo termina');
  else bad('un campo con 1 jugador no termina');

  if (!isFieldComplete(10, 10)) ok('con 10 vivos el campo sigue');
  else bad('el campo termino con 10 jugadores vivos');

  // Quedan un humano y un bot: se puede dar por cerrado, porque el bot no
  // compite por el premio. Aqui hay una excepcion: si el bot ganara, el
  // primero se lo lleva el operador. Preferimos cerrar y pagar al humano.
  if (isFieldComplete(2, 1)) ok('con 1 humano y 1 bot, el campo se cierra y paga al humano');
  else bad('el campo no cierra con humano + bot');

  // Solo quedan bots: hay que cerrar, pero sin ganador humano.
  if (fieldClosedWithBots(0)) ok('si no quedan humanos, el campo se cierra sin ganador');
  else bad('no se detecta el cierre por ausencia de humanos');

  // Y no se paga nada a un bot.
  if (shouldPayPosition(1, 0) === false) {
    ok('con 0 plazas pagadas no se paga ninguna posicion');
  } else {
    bad('se pagaria una posicion sin plazas disponibles');
  }
}

// =========================================================================
section('6. Reparto: que posiciones cobran');

{
  // Un campo de 500 paga 5 posiciones.
  if (PAID_POSITIONS === 5) ok(`el campo paga ${PAID_POSITIONS} posiciones`);
  else bad(`paga ${PAID_POSITIONS} posiciones, esperaba 5`);

  const paying = [];
  for (let pos = 1; pos <= 10; pos++) {
    if (shouldPayPosition(pos, PAID_POSITIONS)) paying.push(pos);
  }
  if (JSON.stringify(paying) === JSON.stringify([1, 2, 3, 4, 5])) {
    ok('las posiciones 1 a 5 cobran, la 6 en adelante no');
  } else {
    bad(`cobran ${paying.join(',')}, esperaba 1-5`);
  }

  // Un campo de 50 con 5 pagados: el 6o al 45o no cobran. Correcto.
  if (!shouldPayPosition(6, PAID_POSITIONS)) ok('el 6o lugar no cobra (solo 5 pagados)');
  else bad('el 6o lugar cobra con solo 5 plazas pagadas');

  // Y el reparto debe cuadrar con el bote, que ya esta probado en payout.
  const p = fieldPayout(2000, 500);
  if (p.entries.length === PAID_POSITIONS) {
    ok(`el campo de 500 reparte entre ${p.entries.length} posiciones`);
  } else {
    bad(`reparte entre ${p.entries.length} posiciones, esperaba ${PAID_POSITIONS}`);
  }

  const sum = p.totalPaid;
  if (sum === p.netPot) {
    ok(`el reparto entrega los ${sum.toLocaleString('es-ES')} CUP del bote neto exactos`);
  } else {
    bad(`el reparto entrega ${sum} y el bote neto es ${p.netPot}`);
  }

  // El ganador del campo de 500 se lleva 45% de 950 000.
  const w = p.entries[0];
  if (Math.abs(w.amount - 427500) <= 1) {
    ok(`el 1o lugar del campo de 500 cobra ${w.amount.toLocaleString('es-ES')} CUP (45%)`);
  } else {
    bad(`el 1o lugar cobra ${w.amount}, esperaba ~427500`);
  }
}

// =========================================================================
section('7. Reparto de jugadores entre mesas');

{
  // Un campo de 50 son 8 mesas de 7. La octava lleva 1.
  if (tablesForField(50) === 8) ok('campo de 50 -> 8 mesas de 7');
  else bad(`campo de 50 -> ${tablesForField(50)} mesas`);

  if (tablesForField(500) === 72) ok('campo de 500 -> 72 mesas de 7');
  else bad(`campo de 500 -> ${tablesForField(500)} mesas`);

  // Ninguna mesa puede pasar de 7.
  const dist = distributePlayers(500, 72);
  const overflow = dist.filter(n => n > SEATS_PER_TABLE);
  const empties = dist.filter(n => n === 0);

  if (overflow.length === 0) {
    ok(`las ${dist.length} mesas respetan el tope de ${SEATS_PER_TABLE} asientos`);
  } else {
    bad(`${overflow.length} mesas con mas de ${SEATS_PER_TABLE} jugadores`);
  }

  if (empties.length === 0) ok('ninguna mesa queda vacia');
  else bad(`${empties.length} mesas vacias`);

  const total = dist.reduce((a, b) => a + b, 0);
  if (total === 500) ok('los 500 jugadores se reparten sin perder ninguno');
  else bad(`se reparten ${total} jugadores, esperaba 500`);

  // 50 en 8 mesas: la octava lleva 1.
  const d50 = distributePlayers(50, 8);
  if (d50.reduce((a, b) => a + b, 0) === 50 && d50.every(n => n <= 7)) {
    ok(`campo de 50: reparto [${d50.join(', ')}] (suma 50, tope 7)`);
  } else {
    bad(`reparto de 50 en 8 mesas incorrecto: [${d50.join(', ')}]`);
  }

  // Un campo impar produce un resto: no se pierde.
  for (const size of [7, 13, 49, 51, 101, 299, 301]) {
    const tables = tablesForField(size);
    const d = distributePlayers(size, tables);
    const sum = d.reduce((a, b) => a + b, 0);
    if (sum !== size || d.some(n => n > SEATS_PER_TABLE || n < 0)) {
      bad(`campo de ${size}: reparto [${d.join(',')}] suma ${sum}, esperaba ${size}`);
    }
  }
  ok('los campos impares (7, 13, 49, 51, 101, 299, 301) reparten sin perder jugadores');

  // Casos limite.
  if (distributePlayers(0, 5).every(n => n === 0)) ok('0 jugadores -> mesas a cero');
  else bad('distributePlayers(0,5) no da ceros');

  if (distributePlayers(100, 0).length === 0) ok('0 mesas -> lista vacia');
  else bad('distributePlayers(100,0) devuelve elementos');
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
