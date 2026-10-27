/**
 * Conservación de fichas en manos aleatorias.
 *
 * Adaptado como idea y como invariante del test de propiedad de
 * `poker-engine-ts` (MIT, Ge-limin):
 *
 *   https://github.com/Ge-limin/poker-engine-ts
 *
 * No copia su motor ni su reducer. Lo que se prueba es la misma propiedad,
 * aplicada al motor de CubaPoker: después de cada acción legal, y al cerrar la
 * mano, el total de fichas de los jugadores más el rake debe ser exactamente
 * el total con el que empezó la mano.
 *
 * Si esta prueba falla, hay un bug de dinero. No es una prueba de estilo ni de
 * estrategia: es la red que impide que una mano cree o destruya fichas.
 *
 * Ejecutar: node scripts/test-chip-conservation.js
 */

const { PokerGame } = require('../dist/game/game.state');

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

/** RNG determinista, para que un fallo se pueda reproducir. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const elegir = (rng, lista) => lista[Math.floor(rng() * lista.length)];

const totalEnMesa = (state) =>
  state.players.reduce((sum, p) => sum + p.chips, 0) + state.pot;

const totalAlCerrar = (state) =>
  state.players.reduce((sum, p) => sum + p.chips, 0) + (state.rake || 0);

/**
 * Construye las acciones legales para el jugador del turno. No se inventa una
 * acción que el motor vaya a rechazar: el objetivo es ejercitar caminos reales,
 * no provocar rechazos.
 */
function accionesLegales(state, rng) {
  const p = state.players[state.currentPlayerIndex];
  if (!p || p.folded || p.allIn || p.chips <= 0) return [];

  const toCall = Math.max(0, state.currentBet - p.bet);
  const acciones = [];

  if (toCall === 0) acciones.push({ action: 'check' });
  else {
    acciones.push({ action: 'call' });
    acciones.push({ action: 'fold' });
  }

  const stackTarget = p.bet + p.chips;
  const minTarget = state.currentBet + state.minRaise;
  if (stackTarget > state.currentBet) {
    if (stackTarget >= minTarget) {
      // Subida normal. Se prueban el mínimo, el máximo y un punto intermedio.
      const objetivo = elegir(rng, [
        minTarget,
        Math.floor((minTarget + stackTarget) / 2),
        stackTarget,
      ]);
      acciones.push({
        action: 'raise',
        amount: Math.max(minTarget, Math.min(stackTarget, objetivo)),
      });
    }
    acciones.push({ action: 'all_in' });
  }

  return acciones;
}

/**
 * Juega una mano aleatoria y comprueba la invariante después de cada paso.
 *
 * Devuelve un objeto con el resultado; no lanza en el caso normal para que el
 * runner pueda contar varias manos sin abortar la primera.
 */
function jugarMano({ seed, seats, stacks, smallBlind, bigBlind, rakeConfig }) {
  const rng = mulberry32(seed);
  const engine = new PokerGame(
    `conservacion-${seed}`,
    smallBlind,
    bigBlind,
    seats,
    rakeConfig,
  );

  for (let i = 0; i < seats; i++) {
    engine.addPlayer(String(i), `jugador-${i}`, stacks[i]);
  }

  const inicial = stacks.reduce((a, b) => a + b, 0);
  const dealer = Math.floor(rng() * seats);

  if (!engine.startGame(dealer)) {
    return { ok: false, motivo: 'el motor no arrancó', inicial };
  }

  let acciones = 0;
  let state = engine.getState();

  if (totalEnMesa(state) !== inicial) {
    return {
      ok: false,
      motivo: 'el reparto inicial ya descuadra',
      inicial,
      total: totalEnMesa(state),
    };
  }

  for (let paso = 0; paso < 300; paso++) {
    state = engine.getState();
    if (state.phase === 'finished') break;

    const legales = accionesLegales(state, rng);
    if (legales.length === 0) {
      return {
        ok: false,
        motivo: `sin acciones legales en fase ${state.phase}`,
        inicial,
        acciones,
      };
    }

    // Barajar y probar. Una acción puede ser rechazada por una regla de
    // reapertura o por un objetivo que ya no es válido; se intenta la
    // siguiente antes de declarar que la mano se ha atascado.
    let aplicada = false;
    for (let i = legales.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [legales[i], legales[j]] = [legales[j], legales[i]];
    }

    for (const accion of legales) {
      if (engine.performAction(
        state.players[state.currentPlayerIndex].id,
        accion.action,
        accion.amount,
      )) {
        aplicada = true;
        acciones++;
        break;
      }
    }

    if (!aplicada) {
      return {
        ok: false,
        motivo: 'ninguna acción legal fue aceptada',
        inicial,
        acciones,
        fase: state.phase,
        jugador: state.players[state.currentPlayerIndex]?.id,
      };
    }

    state = engine.getState();

    if (state.phase !== 'finished') {
      const total = totalEnMesa(state);
      if (total !== inicial) {
        return {
          ok: false,
          motivo: 'descuadre durante la mano',
          inicial,
          total,
          acciones,
          fase: state.phase,
          pot: state.pot,
        };
      }
      if (state.players.some(p => p.chips < 0) || state.pot < 0) {
        return {
          ok: false,
          motivo: 'hay una cantidad negativa',
          inicial,
          acciones,
        };
      }
    }
  }

  state = engine.getState();
  if (state.phase !== 'finished') {
    return {
      ok: false,
      motivo: 'la mano no terminó en 300 acciones',
      inicial,
      acciones,
      fase: state.phase,
    };
  }

  const total = totalAlCerrar(state);
  if (total !== inicial) {
    return {
      ok: false,
      motivo: 'descuadre al cerrar la mano',
      inicial,
      total,
      rake: state.rake || 0,
      acciones,
    };
  }

  if (state.pot !== 0) {
    return {
      ok: false,
      motivo: 'el bote no quedó a cero',
      inicial,
      pot: state.pot,
      acciones,
    };
  }

  return { ok: true, inicial, acciones, rake: state.rake || 0 };
}

console.log('\n\x1b[1mCubaPoker — Conservación de fichas\x1b[0m');

// =========================================================================
section('1. Manos sin rake: las fichas solo cambian de dueño');

{
  let manos = 0;
  let acciones = 0;
  let fallos = 0;

  for (let seed = 1; seed <= 120; seed++) {
    const rng = mulberry32(seed * 17);
    const seats = 2 + Math.floor(rng() * 6);
    const stacks = Array.from(
      { length: seats },
      () => 50 + Math.floor(rng() * 1950),
    );
    // Ciegas variadas, incluidas las que dejan stacks de una sola ciega.
    const bigBlind = elegir(rng, [2, 10, 50]);
    const smallBlind = bigBlind / 2;

    const r = jugarMano({
      seed,
      seats,
      stacks,
      smallBlind,
      bigBlind,
      rakeConfig: undefined,
    });

    manos++;
    if (!r.ok) {
      fallos++;
      bad(`semilla ${seed}: ${r.motivo}`, JSON.stringify(r));
    } else {
      acciones += r.acciones;
    }
  }

  if (fallos === 0) {
    ok(`${manos} manos aleatorias sin descuadre`);
    note(`${acciones} acciones legales ejecutadas`);
  }
}

// =========================================================================
section('2. Manos con rake: el rake sale del bote y se conserva aparte');

{
  let manos = 0;
  let acciones = 0;
  let fallos = 0;
  let rakeTotal = 0;
  const rakeConfig = {
    percentage: 5,
    cap: 500,
    minPot: 10,
    requireFlopOr3Bet: false,
  };

  for (let seed = 1000; seed < 1120; seed++) {
    const rng = mulberry32(seed * 23);
    const seats = 2 + Math.floor(rng() * 6);
    const stacks = Array.from(
      { length: seats },
      () => 100 + Math.floor(rng() * 1900),
    );
    // Ciegas enteras: 25/50 es válido, 12,5/25 no existe en una mesa real.
    const bigBlind = elegir(rng, [10, 20, 50]);
    const smallBlind = bigBlind / 2;

    const r = jugarMano({
      seed,
      seats,
      stacks,
      smallBlind,
      bigBlind,
      rakeConfig,
    });

    manos++;
    if (!r.ok) {
      fallos++;
      bad(`semilla ${seed}: ${r.motivo}`, JSON.stringify(r));
    } else {
      acciones += r.acciones;
      rakeTotal += r.rake;
    }
  }

  if (fallos === 0) {
    ok(`${manos} manos aleatorias con rake sin descuadre`);
    note(`${acciones} acciones legales, rake total ${rakeTotal} unidades`);
    ok('el rake nunca se confundió con una ficha de jugador');
  }
}

// =========================================================================
section('3. Casos límite que suelen romper la conservación');

{
  const casos = [
    { nombre: 'heads-up con ciegas iguales al stack', seats: 2, stacks: [10, 10], sb: 5, bb: 10 },
    { nombre: 'tres jugadores, dos all-in', seats: 3, stacks: [100, 100, 2000], sb: 5, bb: 10 },
    { nombre: 'siete jugadores con stacks desiguales', seats: 7, stacks: [50, 80, 120, 300, 700, 1500, 2000], sb: 10, bb: 20 },
    { nombre: 'ciegas grandes frente a stacks pequeños', seats: 4, stacks: [60, 60, 60, 600], sb: 25, bb: 50 },
  ];

  for (const c of casos) {
    let fallos = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const r = jugarMano({
        seed: seed * 101,
        seats: c.seats,
        stacks: c.stacks,
        smallBlind: c.sb,
        bigBlind: c.bb,
        rakeConfig: { percentage: 5, cap: 1000, minPot: 10, requireFlopOr3Bet: true },
      });
      if (!r.ok) {
        fallos++;
        bad(`${c.nombre}, semilla ${seed}: ${r.motivo}`, JSON.stringify(r));
      }
    }
    if (fallos === 0) ok(c.nombre);
  }
}

// =========================================================================
console.log(
  `\n${'='.repeat(60)}\n` +
  `Resultado: ${pass} correctos, ${fail} fallidos\n` +
  `${'='.repeat(60)}\n`,
);

process.exit(fail > 0 ? 1 : 0);
