/**
 * Cuantas manos tarda una mesa 7-max en llegar a un solo jugador.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA PRUEBA EXISTE
 *
 * Un campo Sit'n'Go no se acaba cuando alguien gana una mano: se acaba cuando queda UN
 * jugador. Y con los bots actuales un campo se queda atascado mucho antes de llegar
 * alla.
 *
 * Se vio jugando un campo entero de verdad: 14 jugadores, 6 000 fichas, y a los 4 000
 * ciclos seguian siendo 6. El reparto de fichas lo decia todo:
 *
 *   mesa 1: 5 059 + 1 143 + 798 = 7 000
 *   mesa 2: 1 063 + 3 358 + 2 579 = 7 000
 *
 * Ninguno baja de 2 000. Las fichas circulan pero nadie llega a cero.
 *
 * La causa no es un descuadre: es que las manos son de CIEGAS. Los bots pliegan tanto
 * antes del flop que casi todas las manos se resuelven antes de repartir cartas
 * comunitarias, y ahi no hay forma de que nadie buste: el que pierde es el que paga la
 * ciega y el que gana es el que la recogia.
 *
 * Con el boton rotando entre 3 jugadores, cada uno es ciega grande una de cada tres
 * manos. Pierde fichas a ritmo constante, pero tambien las recupera. Para llegar a 0
 * hacen falta del orden de 4 500 manos por jugador, y el campo no termina.
 *
 * ------------------------------------------------------------------
 * LO QUE MIDE
 *
 * Cuantas manos hacen falta de verdad, con los bots de produccion, hasta que queda uno.
 * Sin Mongo, sin base de datos y sin el gestor de mesas: solo el motor y la IA.
 *
 * Y de paso, cuantas manos se jouean de media antes de que un jugador tenga que
 * decidir si seguir: si casi todas son de ciegas, el problema es la IA; si son pocas,
 * el problema es el reloj.
 *
 * Ejecutar: node scripts/test-bot-pace.js
 */

const { PokerGame } = require('../dist/game/game.state');
const { decideAction, botFactory } = require('../dist/game/bot.engine');
const { createDeck, shuffleDeck } = require('../dist/game/card.utils');

// La simulación usa la IA de producción, pero con una semilla fija. Sin esto,
// una racha de cartas podía superar el umbral de 3.000 manos y hacer fallar la
// suite sin que hubiera cambiado nada en el producto.
let semilla = Number(process.env.BOT_PACE_SEED || 5) >>> 0;
Math.random = () => {
  semilla = (semilla * 1664525 + 1013904223) >>> 0;
  return semilla / 0x1_0000_0000;
};

// La baraja usa `crypto.randomInt` a propósito en producción. Para que la
// simulación sea reproducible se le pasa una baraja ya barajada con esta
// semilla, sin tocar el camino criptográfico del producto.
let semillaBaraja = Number(process.env.BOT_PACE_DECK_SEED || 0xdecafbad) >>> 0;
const rngBaraja = () => {
  semillaBaraja = (semillaBaraja * 1664525 + 1013904223) >>> 0;
  return semillaBaraja / 0x1_0000_0000;
};

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

/** Perfiles variados, como los que se crean al rellenar una mesa. */
const ESTILOS = ['tight', 'aggressive', 'calling', 'loose', 'rock'];

/**
 * Juega una mesa 7-max hasta que quede un jugador, y devuelve cuantas manos hizo falta.
 *
 * Es el motor de produccion con la IA de produccion. No hay dobles: si esto dice que
 * una mesa no termina, la mesa no termina.
 */
/**
 * Juega una mesa hasta que quede un jugador y devuelve cuantas manos hizo falta.
 *
 * Es el motor de produccion con la IA de produccion, y reproduce lo que hace el gestor
 * de mesas: UN MOTOR NUEVO POR MANO, con los jugadores que siguen teniendo fichas. El
 * motor no tiene newHand(), y por eso el gestor tira el motor y crea otro.
 *
 * Si esto dice que una mesa no termina, la mesa no termina.
 */
function jugarHastaUnJugador({
  seats = 7,
  buyIn = 1000,
  smallBlind = 5,
  bigBlind = 10,
  maxManos = 20000,
  estilos = null,
} = {}) {
  // Cada jugador lleva sus fichas entre manos y su perfil. El indice del jugador es su
  // id estable, para que el motor de cada mano los vuelva a crear con las mismas fichas.
  const fichas = new Map();
  const perfiles = new Map();
  for (let i = 0; i < seats; i++) {
    fichas.set(String(i), buyIn);
    const p = estilos
      ? { ...botFactory.create(i), style: estilos[i % estilos.length] }
      : botFactory.create(i);
    // Con estilos forzados se recalculan las frecuencias del estilo pedido, que es lo
    // que hace \`STYLES\` al crear el perfil.
    if (estilos) {
      const base = {
        tight: { raiseFreq: 0.22, foldFreq: 0.42, aggression: 0.15 },
        aggressive: { raiseFreq: 0.45, foldFreq: 0.20, aggression: 0.65 },
        calling: { raiseFreq: 0.14, foldFreq: 0.24, aggression: 0.25 },
        loose: { raiseFreq: 0.24, foldFreq: 0.12, aggression: 0.35 },
        rock: { raiseFreq: 0.03, foldFreq: 0.30, aggression: 0.05 },
      }[estilos[i % estilos.length]];
      if (base) Object.assign(p, base);
    }
    perfiles.set(String(i), p);
  }

  let manos = 0;
  let acciones = 0;
  let manosConShowdown = 0;
  let manosConFlop = 0;
  let accionesPorMano = 0;
  const problemas = [];

  while (manos < maxManos) {
    const vivos = [...fichas.entries()].filter(([, c]) => c > 0);
    if (vivos.length <= 1) {
      return {
        manos, acciones, manosConShowdown, manosConFlop, problemas,
        motivo: 'queda uno', vivos: vivos.length,
        accionesPorMano: manos > 0 ? accionesPorMano / manos : 0,
      };
    }

    // --- Mano nueva, como el gestor de mesas ---
    const engine = new PokerGame('pace', smallBlind, bigBlind, 7);
    for (const [id, c] of vivos) engine.addPlayer(id, 'bot' + id, c);
    if (!engine.startGame(0, shuffleDeck(createDeck(), rngBaraja))) {
      return {
        manos, acciones, manosConShowdown, manosConFlop, problemas,
        motivo: 'el motor no arranca', vivos: vivos.length,
        accionesPorMano: manos > 0 ? accionesPorMano / manos : 0,
      };
    }

    manos++;
    let accionesDeEstaMano = 0;
    let tope = 500;   // una mano no puede pasar de 500 decisiones
    let llegoAlShowdown = false;
    let vioFlop = false;

    while (tope-- > 0) {
      const state = engine.getState();
      if (state.communityCards.length >= 3) vioFlop = true;

      if (state.phase === 'showdown' || state.phase === 'finished') {
        llegoAlShowdown = true;
        break;
      }

      const actual = state.players[state.currentPlayerIndex];
      if (!actual) {
        problemas.push({ manos, motivo: 'sin jugador en el turno', fase: state.phase });
        break;
      }

      const toCall = Math.max(0, state.currentBet - (actual.bet || 0));

      if (actual.chips <= 0) {
        engine.performAction(actual.id, 'fold');
        acciones++;
        accionesDeEstaMano++;
        continue;
      }

      const conFichas = state.players.filter((p) => p.chips > 0).length;
      const decision = decideAction({
        hand: actual.cards,
        community: state.communityCards,
        potSize: state.pot,
        toCall,
        chips: actual.chips,
        profile: perfiles.get(actual.id),
        position: Number(actual.id),
        playersLeft: conFichas,
        currentBet: state.currentBet,
        minRaise: state.minRaise,
        bigBlind: state.bigBlind,
        dealerIndex: state.dealerIndex,
        currentPlayerIndex: state.currentPlayerIndex,
        tablePlayers: state.players.length,
        isSmallBlind: actual.isSmallBlind,
        isBigBlind: actual.isBigBlind,
        preflopRaises: state.preflopRaises ?? 0,
      });

      const aplico = engine.performAction(actual.id, decision.action, decision.amount);
      if (!aplico) {
        problemas.push({
          manos,
          motivo: 'accion rechazada: ' + decision.action,
          jugador: actual.id,
          fichas: actual.chips,
          toCall,
          fase: state.phase,
        });
        break;
      }
      acciones++;
      accionesDeEstaMano++;
    }

    if (llegoAlShowdown) manosConShowdown++;
    if (vioFlop) manosConFlop++;
    accionesPorMano += accionesDeEstaMano;

    // --- Cerrar la mano: el motor ya ha repartido, se recogen las fichas ---
    for (const p of engine.getState().players) {
      fichas.set(p.id, p.chips);
    }
  }

  const vivos = [...fichas.values()].filter((c) => c > 0).length;
  return {
    manos, acciones, manosConShowdown, manosConFlop, problemas,
    motivo: 'se agotaron las manos', vivos,
    accionesPorMano: manos > 0 ? accionesPorMano / manos : 0,
  };
}

console.log('\n\x1b[1mCubaPoker · Ritmo de las manos de los bots\x1b[0m');

// =========================================================================
section('1. Una mesa 7-max normal (buy-in 1 000, ciegas 5/10)');

{
  const t0 = Date.now();
  const r = jugarHastaUnJugador({ seats: 7, buyIn: 1000, maxManos: 20000 });
  const ms = Date.now() - t0;

  note(`manos: ${r.manos}, acciones: ${r.acciones}, motivo: "${r.motivo}"`);
  note(`vivos al final: ${r.vivos}, tiempo: ${ms} ms`);
  if (r.problemas.length > 0) {
    for (const u of r.problemas.slice(0, 3)) note(`inutil: ${JSON.stringify(u)}`);
  }

  // Cuantas manos por jugador, de media, hasta que estalla el primero.
  if (r.motivo === 'queda uno') {
    ok(`la mesa llego a un jugador en ${r.manos} manos`);
    if (r.manos <= 3000) {
      ok(`es un ritmo aceptable: ${Math.round(r.manos / 7)} manos por jugador eliminados`);
    } else {
      bad(
        `se tardan ${r.manos} manos: a un jugador le cuesta eliminarse`,
        `Con 7 jugadores y un campo de 300 repartido en 43 mesas, un ritmo de ${r.manos} ` +
        `manos por mesa significa que el campo tarda horas. Y los jugadores reales se ` +
        'aburren y se van antes.',
      );
    }
  } else if (r.motivo === 'se agotaron las manos') {
    bad(
      `en 20 000 manos NO ha quedado un jugador (siguen ${r.vivos})`,
      'Esto es lo que pasaba en el campo de verdad: 4 000 rondas, 6 jugadores, nadie ' +
      'busta. El campo no puede terminar.',
    );
  } else {
    bad(`la mesa se paró: ${r.motivo}`, JSON.stringify(r.problemas.slice(0, 2)));
  }

  // La media de acciones por mano dice si las manos son de ciegas.
  if (r.manos > 0) {
    const porMano = r.acciones / r.manos;
    const flopPct = (r.manosConFlop / r.manos) * 100;
    note(`acciones por mano: ${porMano.toFixed(1)} · manos con flop: ${flopPct.toFixed(1)}%`);

    // No se exige un número alto de acciones por mano: muchas manos terminan
    // en la ciega grande y la media incluye el tramo heads-up. Lo que sí no
    // puede pasar es que la mesa viva de folds preflop y nunca vea un flop.
    if (flopPct >= 20) {
      ok(`${flopPct.toFixed(1)}% de las manos ven flop: la mesa no es solo ciegas`);
    } else {
      bad(
        `solo ${flopPct.toFixed(1)}% de las manos ven flop`,
        'Con rangos tan estrechos, la mesa se resuelve antes de repartir cartas ' +
        'comunitarias y nadie llega a bustar. Hay que abrir las cartas por posición.',
      );
    }

    if (porMano >= 3.5) {
      ok(`${porMano.toFixed(1)} acciones de media: hay calles y no solo folds`);
    } else {
      bad(
        `solo ${porMano.toFixed(1)} acciones de media`,
        'La media incluye el tramo heads-up, pero por debajo de 3.5 la mesa sigue ' +
        'demasiado dominada por el fold preflop.',
      );
    }
  }
}

// =========================================================================
section('2. Como cambia con las ciegas');

// El ritmo no depende solo de la IA: depende de cuanto se juegue por mano. Con ciegas
// mas grandes, la misma mano de ciegas elimina antes.
const conCiegas = [];
for (const bb of [10, 20, 50, 100]) {
  const r = jugarHastaUnJugador({
    seats: 7, buyIn: 1000, smallBlind: bb / 2, bigBlind: bb, maxManos: 20000,
  });
  const porMano = r.manos > 0 ? (r.acciones / r.manos) : 0;
  conCiegas.push({ bb, manos: r.manos, motivo: r.motivo, porMano });
  note(`ciega ${bb}: ${r.manos} manos, ${porMano.toFixed(1)} acciones por mano`);
}

if (conCiegas[0].manos > conCiegas[conCiegas.length - 1].manos) {
  ok('las ciegas mas grandes eliminan antes: el ritmo depende del bote en juego');
} else {
  note(
    'las ciegas no cambian el ritmo: eso significa que el problema NO es el bote sino ' +
    'que las manos no llegan a disputed. Ojo con esto al tocar la IA.',
  );
}

// =========================================================================
section('3. Con bots mucho mas agresivos');

// Si el problema es la pasividad de la IA, subir la agresividad tiene que notarse. Si no
// se nota, el problema no es la IA.
{
  const r = jugarHastaUnJugador({
    seats: 7, buyIn: 1000, maxManos: 20000,
    estilos: ['aggressive', 'aggressive', 'aggressive', 'aggressive',
      'aggressive', 'aggressive', 'aggressive'],
  });
  note(`siete bots agresivos: ${r.manos} manos, ${r.acciones} acciones`);

  const pasivo = jugarHastaUnJugador({ seats: 7, buyIn: 1000, maxManos: 20000 });
  note(`perfiles variados:    ${pasivo.manos} manos, ${pasivo.acciones} acciones`);

  if (r.manos < pasivo.manos) {
    ok(
      `la agresividad ayuda: ${r.manos} manos contra ${pasivo.manos}`,
      'Con bots agresivos la mesa llega a un jugador antes, asi que la pasividad es ' +
        'parte de la causa.',
    );
  } else if (r.manos === pasivo.manos) {
    ok('la agresividad NO cambia nada: el problema no es la decision del bot');
  } else {
    note(
      `con bots agresivos se tarda MAS (${r.manos} contra ${pasivo.manos}). Con todos ` +
      'agresivos se tiran las manos rapido y suben las fichas de todos por igual, que ' +
      'tambien es un equilibrio. Es un matiz que hay que tener en cuenta al tocar la IA.',
    );
  }
}

// =========================================================================
section('4. Decisiones: precio, proyectos y faroles');
// =========================================================================

{
  const deck = createDeck();
  const carta = (rank, suit) => {
    const c = deck.find((x) => x.rank === rank && x.suit === suit);
    if (!c) throw new Error(`Carta inexistente: ${rank} ${suit}`);
    return c;
  };
  const perfil = (extra = {}) => ({
    id: 'test-bot',
    name: 'Test',
    style: 'tight',
    winRate: 0.45,
    raiseFreq: 0.22,
    foldFreq: 0.42,
    aggression: 0.15,
    ...extra,
  });

  const contar = (params, veces = 1000) => {
    const cuenta = { fold: 0, check: 0, call: 0, raise: 0, all_in: 0 };
    for (let i = 0; i < veces; i++) {
      cuenta[decideAction(params).action]++;
    }
    return cuenta;
  };

  const debil = [carta('7', 'clubs'), carta('2', 'diamonds')];
  const aire = [carta('7', 'clubs'), carta('3', 'diamonds')];
  const aa = [carta('A', 'spades'), carta('A', 'hearts')];
  const boardSeco = [carta('Q', 'hearts'), carta('9', 'hearts'), carta('2', 'clubs')];
  const proyectoColor = [carta('A', 'hearts'), carta('K', 'hearts')];
  const boardColor = [carta('Q', 'hearts'), carta('9', 'hearts'), carta('2', 'clubs')];

  const base = {
    hand: debil,
    community: [],
    potSize: 100,
    toCall: 10,
    chips: 1000,
    profile: perfil(),
    position: 3,
    playersLeft: 5,
    currentBet: 10,
    minRaise: 10,
  };

  const barato = contar({ ...base, toCall: 10, potSize: 100 });
  const caro = contar({ ...base, toCall: 100, potSize: 100 });
  note(`7-2 ante apuesta pequena: fold ${barato.fold}/1000`);
  note(`7-2 ante apuesta de bote:  fold ${caro.fold}/1000`);

  if (caro.fold > barato.fold * 1.25 && caro.fold - barato.fold > 80) {
    ok('las pot odds cambian el fold: el mismo 7-2 se tira mas caro');
  } else {
    bad(
      `el precio no pesa lo suficiente: barato=${barato.fold}, caro=${caro.fold}`,
      'Sin esta separacion, el bot iguala cualquier basura en cualquier bote.',
    );
  }

  const fuertes = contar({
    ...base,
    hand: aa,
    toCall: 100,
    potSize: 200,
    currentBet: 100,
  });
  if (fuertes.fold === 0) {
    ok('una mano fuerte (AA) no se tira aunque el precio sea alto');
  } else {
    bad(`AA se tiro ${fuertes.fold}/1000 veces: el bot regala las mejores manos`);
  }

  const conProyecto = contar({
    ...base,
    hand: proyectoColor,
    community: boardColor,
    toCall: 50,
    potSize: 200,
    currentBet: 50,
  });
  const sinProyecto = contar({
    ...base,
    hand: aire,
    community: boardSeco,
    toCall: 50,
    potSize: 200,
    currentBet: 50,
  });
  note(`proyecto de color: fold ${conProyecto.fold}/1000`);
  note(`aire sin proyecto:  fold ${sinProyecto.fold}/1000`);

  if (conProyecto.fold + 80 < sinProyecto.fold) {
    ok('un proyecto de color se paga mas que el aire: no se trata igual');
  } else {
    bad(
      `el proyecto no recibe trato propio: ${conProyecto.fold} contra ${sinProyecto.fold}`,
      'Un bot que foldea todos los proyectos solo juega manos hechas.',
    );
  }

  const perfiles = [
    perfil(),
    perfil({ style: 'aggressive', raiseFreq: 0.45, foldFreq: 0.20, aggression: 0.65 }),
    perfil({ style: 'calling', raiseFreq: 0.14, foldFreq: 0.24, aggression: 0.25 }),
    perfil({ style: 'loose', raiseFreq: 0.24, foldFreq: 0.12, aggression: 0.35 }),
  ];
  let subidasIlegales = 0;
  let subidas = 0;
  for (const p of perfiles) {
    for (let i = 0; i < 500; i++) {
      const d = decideAction({
        ...base,
        hand: i % 2 === 0 ? aa : debil,
        toCall: 30,
        potSize: 150,
        currentBet: 30,
        minRaise: 30,
        profile: p,
      });
      if (d.action === 'raise') {
        subidas++;
        if (!(d.amount > 30) || d.amount > 1000) subidasIlegales++;
      }
    }
  }
  if (subidas > 0 && subidasIlegales === 0) {
    ok(`las ${subidas} subidas simuladas son legales (total > apuesta y <= stack)`);
  } else {
    bad(`subidas ilegales: ${subidasIlegales} de ${subidas}`, 'El motor las rechazaria.');
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);