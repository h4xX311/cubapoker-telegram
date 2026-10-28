/**
 * Reloj de ciegas de torneos.
 *
 * No depende de Mongo: solo de fechas fijas. Lo importante no es que la
 * escalera sea la de un torneo televisado, sino que sea monótona, entera y que
 * nunca produzca una mesa que el motor rechace (`bigBlind < smallBlind`).
 */

const {
  blindLevelFor,
  blindLevelLabel,
  BLIND_LEVEL_DURATION_MS,
  BLIND_LEVEL_MULTIPLIERS,
} = require('../dist/game/blind.levels');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d !== undefined) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Niveles de ciegas\x1b[0m');

const inicio = Date.UTC(2026, 0, 1, 20, 0, 0);
const min = 60_000;

section('1. La escalera avanza con el reloj');
{
  const n0 = blindLevelFor(5, 10, inicio, inicio);
  const n1 = blindLevelFor(5, 10, inicio, inicio + BLIND_LEVEL_DURATION_MS);
  const n3 = blindLevelFor(5, 10, inicio, inicio + 3 * BLIND_LEVEL_DURATION_MS);

  if (n0.level === 0 && n0.small === 5 && n0.big === 10) {
    ok('el nivel 0 conserva las ciegas base 5/10');
  } else {
    bad('el nivel 0 no conserva las ciegas base', JSON.stringify(n0));
  }

  if (n1.level === 1 && n1.small > n0.small && n1.big > n0.big) {
    ok(`el nivel 1 sube a ${n1.small}/${n1.big}`);
  } else {
    bad('el nivel 1 no sube las ciegas', JSON.stringify(n1));
  }

  if (n3.level === 3 && n3.small > n1.small && n3.big > n1.big) {
    ok(`el nivel 3 sube a ${n3.small}/${n3.big}`);
  } else {
    bad('el nivel 3 no sube las ciegas', JSON.stringify(n3));
  }
}

section('2. El reloj no se rompe en los bordes');
{
  const antes = blindLevelFor(5, 10, inicio, inicio + BLIND_LEVEL_DURATION_MS - 1);
  const justo = blindLevelFor(5, 10, inicio, inicio + BLIND_LEVEL_DURATION_MS);
  if (antes.level === 0 && justo.level === 1) {
    ok('el cambio de nivel es exacto al milisegundo');
  } else {
    bad('el borde del nivel no cambia cuando debe', JSON.stringify({ antes, justo }));
  }

  const negativo = blindLevelFor(5, 10, inicio, inicio - 10 * min);
  if (negativo.level === 0 && negativo.small === 5) {
    ok('un reloj en el pasado no genera niveles negativos');
  } else {
    bad('el reloj negativo genera un nivel inválido', JSON.stringify(negativo));
  }

  const maximo = blindLevelFor(
    5,
    10,
    inicio,
    inicio + 365 * 24 * 60 * min,
  );
  if (maximo.level === BLIND_LEVEL_MULTIPLIERS.length - 1) {
    ok('al agotar la escalera se queda en el ultimo nivel');
  } else {
    bad('la escalera no se detuvo en el ultimo nivel', JSON.stringify(maximo));
  }

  if (blindLevelLabel(maximo).startsWith('Nivel ')) {
    ok('la etiqueta del nivel es apta para la interfaz');
  } else {
    bad('la etiqueta del nivel no es válida');
  }
}

section('3. Invariantes para el motor');
{
  let invalidos = 0;
  let revisados = 0;
  for (let t = 0; t <= 60; t++) {
    const n = blindLevelFor(5, 10, inicio, inicio + t * BLIND_LEVEL_DURATION_MS);
    revisados++;
    if (!Number.isInteger(n.small) || !Number.isInteger(n.big) ||
        n.small < 1 || n.big < n.small * 2) {
      invalidos++;
      bad(`nivel invalido en minuto ${t}: ${JSON.stringify(n)}`);
    }
  }
  if (invalidos === 0) {
    ok(`${revisados} niveles son enteros y respetan bigBlind >= 2 * smallBlind`);
  }

  const baseGrande = blindLevelFor(50, 100, inicio, inicio + 4 * BLIND_LEVEL_DURATION_MS);
  if (baseGrande.small % 5 === 0 && baseGrande.big % 10 === 0) {
    ok('la escalera de una mesa de 50/100 conserva múltiplos legibles');
  } else {
    bad('la escalera de 50/100 produce ciegas raras', JSON.stringify(baseGrande));
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
