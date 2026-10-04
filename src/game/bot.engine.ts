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

/** Genera perfiles de bot con nombres unicos. */
export class BotFactory {
  private usedNames = new Set<string>();
  private counter = 0;

  create(seed?: number): BotProfile {
    const rng = seed !== undefined ? mulberry32(seed) : Math.random;

    const nameIndex = Math.floor(rng() * BOT_CONFIG.names.length);
    let baseName = BOT_CONFIG.names[nameIndex];

    // Evita nombres duplicados: "Marta" y "Marta2" rompen la ilusion de que
    // son jugadores distintos.
    if (this.usedNames.has(baseName)) {
      let suffix = 2;
      while (this.usedNames.has(`${baseName}${suffix}`)) suffix++;
      baseName = `${baseName}${suffix}`;
    }
    this.usedNames.add(baseName);

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

  release(botId: string): void {
    // Reservado para cuando los bots salgan de la mesa
  }

  reset(): void {
    this.usedNames.clear();
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
}): BotDecision {
  const { hand, community, potSize, toCall, chips, profile, position, playersLeft } = params;

  const rng = Math.random;

  // Fuerza de la mano en escala 0-1
  const strength = evaluateStrength(hand, community);

  // Sin coste para igualar: solo hay decision si queremos subir
  if (toCall === 0) {
    if (strength > 0.72 && rng() < profile.raiseFreq) {
      const raise = Math.min(chips, potSize * (0.5 + rng() * 0.5));
      return raise >= chips ? { action: 'all_in' } : { action: 'raise', amount: Math.round(raise) };
    }
    return { action: 'check' };
  }

  // All-in short stack cuando la mano es fuerte y le queda poco
  if (chips <= toCall * 3 && strength > 0.6 && rng() < profile.aggression) {
    return { action: 'all_in' };
  }

  // Mano marginal: abandonar con la frecuencia que dicta el estilo
  if (strength < 0.32) {
    if (rng() < profile.foldFreq) {
      return { action: 'fold' };
    }
    // Si no abandona, iguala (no sube una mano mala)
    return { action: 'call' };
  }

  // Mano buena
  if (strength > 0.68) {
    // Presion cuando actua temprano
    const latePosition = position >= Math.max(1, playersLeft - 2);
    const pressure = latePosition ? 1.15 : 1;

    if (rng() < profile.raiseFreq * pressure) {
      const sizing = potSize * (0.6 + rng() * 0.8) * pressure;
      const raise = Math.min(chips, Math.max(toCall * 2, sizing));
      if (raise >= chips * 0.95) {
        return { action: 'all_in' };
      }
      return { action: 'raise', amount: Math.round(raise) };
    }
    return { action: 'call' };
  }

  // Mano media
  if (rng() < profile.foldFreq * 0.6) {
    return { action: 'fold' };
  }
  return { action: 'call' };
}

/**
 * Fuerza de la mano en 0-1, usando el valor del evaluador normalizado.
 * Evalua las 5 mejores cartas de las 7 disponibles y escala por ranking.
 */
export function evaluateStrength(hand: Card[], community: Card[]): number {
  const all = [...hand, ...community];
  if (all.length < 5) {
    // Preflop: fuerza aproximada por la mejor carta y los kort
    return preflopStrength(hand);
  }

  const result = evaluateHand(all);

  // Mapea el valor interno (1..10000) a 0..1
  // El valor real ya codifica el ranking, asi que basta normalizar.
  const normalized = Math.min(1, Math.max(0, result.value / 10000));

  // Comprime el rango alto: una mano media (full house) no debe sentirse
  // tan fuerte como el poker real porque asi juega el bot de forma creible.
  return Math.pow(normalized, 0.55);
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
