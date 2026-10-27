import { Card, Rank } from './card.utils';
import { evaluateHand } from './hand.evaluator';
import { BOT_CONFIG } from '../config/product';

export type BotAction = 'fold' | 'check' | 'call' | 'raise' | 'all_in';

export interface BotDecision {
  action: BotAction;
  amount?: number;
}

/**
 * Personalidad del bot.
 *
 * `style` define COMO juega, y `winRate` quantifica la fuerza con la que
 * compite. El win rate esta por debajo de 0.5 a proposito (ver BOT_CONFIG):
 * si los bots ganaran mas de lo que pierden, los jugadores reales verian sus
 * saldos evaporarse y la plataforma seria insostenible.
 */
export type BotStyle = 'tight' | 'aggressive' | 'calling' | 'loose' | 'rock';

export interface BotProfile {
  id: string;
  name: string;
  style: BotStyle;
  /** Probabilidad de ganar la mano, entre 0.42 y 0.48 */
  winRate: number;
  /** Frecuencia con que sobre-impulsa (subida) */
  raiseFreq: number;
  /** Frecuencia con que abandona una mano marginal */
  foldFreq: number;
  /** Asumo de riesgo en all-in */
  aggression: number;
}

const STYLES: Record<BotStyle, Omit<BotProfile, 'id' | 'name' | 'winRate'>> = {
  // Solo entra con cartas buenas. Pocas fichas, mucho pot.
  tight: { style: 'tight', raiseFreq: 0.22, foldFreq: 0.42, aggression: 0.15 },
  // Subasta mucho. Genera pot.
  aggressive: { style: 'aggressive', raiseFreq: 0.45, foldFreq: 0.20, aggression: 0.65 },
  // Continua mucho, sube poco.
  calling: { style: 'calling', raiseFreq: 0.14, foldFreq: 0.24, aggression: 0.25 },
  // Entra a casi todo. Genera accion.
  loose: { style: 'loose', raiseFreq: 0.24, foldFreq: 0.12, aggression: 0.35 },
  // Nunca sube, solo iguala. Patron reconocible.
  rock: { style: 'rock', raiseFreq: 0.03, foldFreq: 0.30, aggression: 0.05 },
};

const STYLE_KEYS: BotStyle[] = ['tight', 'aggressive', 'calling', 'loose', 'rock'];

/**
 * Genera perfiles de bot con nombres que parecen de jugadores reales.
 *
 * La unicidad se limita a la mesa (`taken`), no al proceso entero: un nick de
 * poker se repite entre mesas distintas todo el tiempo, y mantener un registro
 * global acabaria agotando el repertorio y volviendo a los contadores tipo
 * "Marta2". Dentro de una misma mesa no se repite ninguno.
 */
export class BotFactory {
  private counter = 0;

  /**
   * @param seed  Semilla opcional para pruebas deterministicas.
   * @param taken Nombres ya sentados en la mesa; el nuevo no puede coincidir.
   */
  create(seed?: number, taken: Set<string> = new Set()): BotProfile {
    const rng = seed !== undefined ? mulberry32(seed) : Math.random;
    const nombres = BOT_CONFIG.names;
    const sufijos = BOT_CONFIG.nickSuffixes;

    let baseName = '';
    for (let intento = 0; intento < 120; intento++) {
      const base = nombres[Math.floor(rng() * nombres.length)];
      const sufijo = sufijos[Math.floor(rng() * sufijos.length)];
      const candidato = `${base}${sufijo}`;
      if (!taken.has(candidato)) {
        baseName = candidato;
        break;
      }
    }

    // Red de seguridad: 30 bases x 32 sufijos son ~960 combinaciones, mas que
    // cualquier mesa. Si aun asi se agotaran, un numero de tres cifras sigue
    // pareciendo un nick real ("Marta317"), no un contador ("Marta2").
    if (!baseName) {
      const base = nombres[Math.floor(rng() * nombres.length)];
      let numero = 100 + Math.floor(rng() * 900);
      while (taken.has(`${base}${numero}`)) {
        numero = 100 + Math.floor(rng() * 900);
      }
      baseName = `${base}${numero}`;
    }

    const style = STYLE_KEYS[Math.floor(rng() * STYLE_KEYS.length)];
    const base = STYLES[style];

    // winRate dentro del rango permitido
    const winRate =
      BOT_CONFIG.winRateMin + rng() * (BOT_CONFIG.winRateMax - BOT_CONFIG.winRateMin);

    this.counter++;

    return {
      id: `bot-${Date.now().toString(36)}-${this.counter}`,
      name: baseName,
      style,
      winRate,
      raiseFreq: base.raiseFreq,
      foldFreq: base.foldFreq,
      aggression: base.aggression,
    };
  }

  reset(): void {
    this.counter = 0;
  }
}

export const botFactory = new BotFactory();

/**
 * Decide la accion de un bot.
 *
 * @param hand      cartas propias del bot
 * @param community cartas comunitarias visibles
 * @param potSize   bote actual
 * @param toCall    cantidad que debe igualar
 * @param chips     fichas del bot
 * @param profile   personalidad del bot
 * @param position  posicion en la mesa (0 = primera)
 * @param playersLeft jugadores aun activos
 */
export function decideAction(params: {
  hand: Card[];
  community: Card[];
  potSize: number;
  toCall: number;
  chips: number;
  profile: BotProfile;
  position: number;
  playersLeft: number;
  /**
   * Apuesta actual de la calle. Se necesita para devolver el `amount` con la
   * misma semántica que el motor: total al que queda la apuesta, no incremento.
   */
  currentBet?: number;
  /** Subida mínima de la calle. Si no llega, el bot no intenta una subida ilegal. */
  minRaise?: number;
}): BotDecision {
  const {
    hand, community, potSize, toCall, chips, profile, position, playersLeft,
  } = params;

  const rng = Math.random;

  // Fuerza de la mano en escala 0-1. Los proyectos que se juegan con proyectos
  // (color o escalera) no son manos hechas, pero tampoco son aire: se les da un
  // pequeño empujón para que el bot no foldee siempre una buena oportunidad.
  const strength = evaluateStrength(hand, community);
  const drawBonus = estimateDrawBonus(hand, community);
  const fuerzaEfectiva = Math.min(1, strength + (strength < 0.55 ? drawBonus : 0));

  // Pot odds: lo que cuesta igualar dividido por el bote que habrá después.
  // Sin esto, el bot igualaba cualquier cosa en un bote enorme, que es una de
  // las formas más fáciles de detectar una IA y de perder dinero sin jugar.
  const potOdds = toCall > 0 ? toCall / Math.max(1, potSize + toCall) : 0;
  const precioMalo = potOdds > 0.30;
  const precioMuyMalo = potOdds > 0.42;
  const pocosJugadores = playersLeft <= 3;

  const currentBet = Math.max(0, params.currentBet ?? 0);
  const minRaise = Math.max(1, params.minRaise ?? Math.max(1, currentBet));
  // Fichas que quedarían en la apuesta si el bot pusiera todo su stack.
  const stackTarget = currentBet - toCall + chips;
  const minTarget = currentBet + minRaise;

  // Redondea una subida y la convierte en all-in si no queda otra. Si el
  // objetivo no llega al mínimo legal, devuelve null para que el bot iguale.
  const subirA = (objetivo: number): BotDecision | null => {
    const target = Math.min(stackTarget, Math.max(minTarget, Math.round(objetivo)));
    if (target >= stackTarget) return { action: 'all_in' };
    if (target <= currentBet) return null;
    return { action: 'raise', amount: target };
  };

  // Sin coste para igualar. Se apuesta por valor, por proyecto y, de vez en
  // cuando, sin nada: un bot que solo apuesta con el nuts es una señal.
  if (toCall === 0) {
    const apuestaValor = fuerzaEfectiva > 0.62;
    const apuestaProyecto = drawBonus >= 0.12;
    const farol = fuerzaEfectiva < 0.34;

    let frecuencia = 0;
    if (apuestaValor) frecuencia = profile.raiseFreq * (0.9 + fuerzaEfectiva * 0.4);
    else if (apuestaProyecto) frecuencia = profile.aggression * 0.45;
    else if (farol) frecuencia = profile.aggression * 0.06;

    if (frecuencia > 0 && rng() < frecuencia) {
      const fraccion = apuestaValor ? 0.55 + rng() * 0.55 : 0.4 + rng() * 0.35;
      const raise = subirA(currentBet + potSize * fraccion);
      if (raise) return raise;
    }
    return { action: 'check' };
  }

  // All-in short stack cuando la mano es fuerte y le queda poco.
  if (chips <= toCall * 3 && fuerzaEfectiva > 0.6 && rng() < profile.aggression) {
    return { action: 'all_in' };
  }

  // Mano muy fuerte con un bote ya grande: se mete el stack. Sin esto, dos
  // bots con 100 BB pueden pasarse miles de manos subiendo y retirándose sin
  // que las fichas cambien de dueño; el torneo no termina nunca.
  if (
    fuerzaEfectiva > 0.85 &&
    chips <= potSize * 3 &&
    rng() < 0.35 + profile.aggression * 0.35
  ) {
    return { action: 'all_in' };
  }

  // No queda stack para igualar: o se paga el all-in o se abandona. Se exige
  // algo más que las pot odds peladas porque no hay calles futuras que cobrar.
  if (chips <= toCall) {
    if (fuerzaEfectiva >= Math.max(0.42, potOdds)) {
      return { action: 'call' };
    }
    if (rng() < profile.aggression * 0.18) {
      return { action: 'call' };
    }
    return { action: 'fold' };
  }

  // Mano buena: subir o igualar. Aquí no se foldea por precio.
  const umbralFuerte = pocosJugadores ? 0.58 : 0.62;
  if (fuerzaEfectiva > umbralFuerte) {
    // Presión cuando actúa en posición tardía o quedan pocos jugadores.
    const latePosition = position >= Math.max(1, playersLeft - 2);
    const pressure = (latePosition ? 1.15 : 1) * (pocosJugadores ? 1.2 : 1);

    if (rng() < profile.raiseFreq * pressure) {
      const sizing = potSize * (0.75 + rng() * 0.9) * pressure;
      const raise = subirA(currentBet + Math.max(toCall, sizing));
      if (raise) return raise;
    }
    return { action: 'call' };
  }

  // Proyecto: no es una mano hecha, pero tampoco aire. Se paga más que con
  // 7-2 y se semi-farolea de vez en cuando.
  if (drawBonus >= 0.12 && fuerzaEfectiva < 0.55) {
    if (precioMalo && rng() < profile.foldFreq * 0.5) {
      return { action: 'fold' };
    }
    if (rng() < profile.aggression * 0.18) {
      const raise = subirA(currentBet + Math.max(toCall, potSize * 0.55));
      if (raise) return raise;
    }
    return { action: 'call' };
  }

  // Mano débil de verdad (aire): el precio manda. Un bote grande que exige el
  // 35% de equity no se paga con 7-2 solo porque el bot sea "loose". Una pareja
  // ya no cae aquí: está por encima de 0.20 y merece ver más calles.
  if (strength < 0.20) {
    const castigo = precioMalo ? 0.28 : potOdds > 0.22 ? 0.12 : 0;
    if (rng() < Math.min(0.95, profile.foldFreq + castigo)) {
      return { action: 'fold' };
    }
    return { action: 'call' };
  }

  // Mano marginal (pareja débil, dos overcards) o proyecto: se paga si el
  // precio no es un overbet. El proyecto conserva algo de semi-farol.
  if (fuerzaEfectiva < 0.55) {
    if (precioMuyMalo && rng() < profile.foldFreq * 0.75) {
      return { action: 'fold' };
    }
    if (drawBonus > 0 && rng() < profile.aggression * 0.18) {
      const raise = subirA(currentBet + Math.max(toCall, potSize * 0.55));
      if (raise) return raise;
    }
    if (rng() < profile.foldFreq * 0.20) {
      return { action: 'fold' };
    }
    return { action: 'call' };
  }

  // Mano media: farolea de vez en cuando, sobre todo en posición tardía. Un bot
  // que solo sube con manos fuertes se lee en dos órbitas.
  if (rng() < profile.aggression * 0.08) {
    const raise = subirA(currentBet + Math.max(toCall, potSize * 0.6));
    if (raise) return raise;
  }

  if (rng() < profile.foldFreq * 0.6) {
    return { action: 'fold' };
  }
  return { action: 'call' };
}

/**
 * Valor aproximado de un proyecto de color o escalera, entre 0 y 0.26.
 *
 * No intenta calcular outs exactos: eso exige conocer las cartas de los
 * rivales y sería información privilegiada. Solo mira lo que el bot puede ver:
 * sus cartas y el board. Es una señal para no tratar un proyecto como aire.
 */
export function estimateDrawBonus(hand: Card[], community: Card[]): number {
  if (community.length < 3) return 0;

  const cartas = [...hand, ...community];
  const porPalo = new Map<string, number>();
  for (const c of cartas) {
    porPalo.set(c.suit, (porPalo.get(c.suit) ?? 0) + 1);
  }
  const maxPalo = Math.max(...porPalo.values());
  // Cuatro del mismo palo y el board incompleto: proyecto de color. Si ya hay
  // cinco, el evaluador lo cuenta como color y no hace falta sumar nada.
  const proyectoColor = community.length < 5 && maxPalo === 4 ? 0.16 : 0;

  const valores = new Set(cartas.map((c) => c.value));
  if (valores.has(14)) valores.add(1); // la rueda también es proyecto

  let proyectoEscalera = 0;
  for (let inicio = 1; inicio <= 10; inicio++) {
    let presentes = 0;
    for (let i = 0; i < 5; i++) {
      if (valores.has(inicio + i)) presentes++;
    }
    // Cuatro de cinco: falta una carta. No se distingue gutshot de abierta;
    // ambos merecen algo de crédito, el abierto algo más.
    if (presentes === 4) {
      const abierta = valores.has(inicio - 1) || valores.has(inicio + 5);
      proyectoEscalera = Math.max(proyectoEscalera, abierta ? 0.14 : 0.09);
    }
  }

  return Math.min(0.26, proyectoColor + proyectoEscalera);
}

/**
 * Fuerza de la mano en 0-1, usando el valor del evaluador normalizado.
 * Evalua las 5 mejores cartas de las 7 disponibles y escala por ranking.
 */
/**
 * Fuerza de la mano en 0..1.
 *
 * No se normaliza el entero del evaluador: con base 15 y cinco posiciones, el
 * valor de un full house es millones y dividirlo por 10 000 daba siempre 1. Eso
 * hacía que el bot jugara todas las manos postflop como si fueran la nuts.
 *
 * Se usa la categoría como escala base y se añade un pequeño ajuste por el
 * desempate, suficiente para distinguir dos parejas de ases con distinto kicker.
 */
export function evaluateStrength(hand: Card[], community: Card[]): number {
  const all = [...hand, ...community];
  if (all.length < 5) {
    // Preflop: fuerza aproximada por la mejor carta y el parejamiento
    return preflopStrength(hand);
  }

  const result = evaluateHand(all);

  const base: Record<string, number> = {
    high_card: 0.08,
    pair: 0.22,
    two_pair: 0.36,
    three_of_a_kind: 0.52,
    straight: 0.64,
    flush: 0.72,
    full_house: 0.84,
    four_of_a_kind: 0.93,
    straight_flush: 0.97,
    royal_flush: 1,
  };

  const categoria = base[result.rank] ?? 0.08;
  // Dentro de la categoría, el desempate mueve como mucho 0.04. Es una señal
  // para elegir entre manos del mismo tipo, no para saltar de categoría.
  const dentro = (result.value % (15 ** 5)) / (15 ** 5);
  return Math.max(0, Math.min(1, categoria + dentro * 0.04));
}

/** Fuerza aproximada preflop usando la mejor carta y el parejamiento. */
function preflopStrength(hand: Card[]): number {
  if (hand.length < 2) return 0.3;

  const values = hand.map(c => c.value).sort((a, b) => b - a);
  const [hi, lo] = values;

  let score = (hi - 2) / 12; // As alto ~ 1.0, 2 ~ 0

  if (hi === lo) {
    // Pareja: sube bastante
    score = 0.45 + (hi / 14) * 0.5;
  } else if (hi === 14) {
    // As alto siempre decente
    score = Math.max(score, 0.62);
  } else if (hi === 13 && lo >= 10) {
    // Rey alto con 10+
    score = Math.max(score, 0.55);
  }

  // suited / offsuit
  const suited = hand.length === 2 && hand[0].suit === hand[1].suit;
  if (suited) score = Math.min(1, score * 1.18);

  return Math.max(0, Math.min(1, score));
}

/**
 * Generador pseudoaleatorio determinista (mulberry32).
 * Permite reproducir una partida dado un seed, util para depurar.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cuenta cartas que ya se han visto (community + hole de un jugador).
 * Se usa para detectar si un bot tiene informacion que no deberia.
 */
export function countSeenCards(cards: Card[]): Set<string> {
  return new Set(cards.map(c => `${c.rank}${c.suit}`));
}
