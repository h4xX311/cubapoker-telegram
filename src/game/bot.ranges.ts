/**
 * Rangos preflop y push/fold de los bots.
 *
 * La estructura está inspirada en el motor de IA 4 de PokerTH (AGPL-3.0):
 * rangos por posición, defensa de ciegas, 3-bet de valor y push/fold con stack
 * corto. No se copió código C++: se adaptaron las ideas al motor de CubaPoker.
 *
 * La notación es la habitual:
 *
 *   AA        pareja exacta
 *   22+       todas las parejas desde 22
 *   A9s+      A9s, ATs, AJs, AQs, AKs
 *   AJo+      AJo, AQo, AKo
 *   KTs+      KTs, KJs, KQs
 *   98s       exacta
 *
 * El rango no decide por sí solo: `decidePreflop()` combina el rango con el
 * stack, la posición, el precio y el estilo del bot. El objetivo es que dos
 * bots con la misma mano no jueguen igual si uno está en el botón y el otro
 * en primera posición.
 */

import type { Card } from './card.utils';

export type PreflopPosition = 'early' | 'middle' | 'late' | 'button' | 'sb' | 'bb';

export interface PreflopProfile {
  style: 'tight' | 'aggressive' | 'calling' | 'loose' | 'rock';
  aggression: number;
  raiseFreq: number;
}

export interface PreflopContext {
  hand: Card[];
  profile: PreflopProfile;
  /** Jugadores que siguen en la mano, incluido el bot. */
  playersLeft: number;
  /** Índice de asiento del bot; se usa si no llegan los índices del motor. */
  position: number;
  dealerIndex?: number;
  currentPlayerIndex?: number;
  tablePlayers?: number;
  isSmallBlind?: boolean;
  isBigBlind?: boolean;
  currentBet: number;
  minRaise: number;
  bigBlind: number;
  chips: number;
  toCall: number;
  potSize: number;
  preflopRaises: number;
  rng: () => number;
}

export interface PreflopDecision {
  action: 'fold' | 'check' | 'call' | 'raise' | 'all_in';
  amount?: number;
}

const RANK_VALUE: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, 'T': 10, '10': 10, J: 11, Q: 12, K: 13, A: 14,
};

const VALUE_RANK: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
  9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/** Convierte una carta a la letra usada en la notación de rangos. */
export function rankLetter(card: Card): string {
  return VALUE_RANK[card.value] ?? card.rank;
}

/**
 * Convierte dos cartas en su clase: `AA`, `AKs` o `AKo`.
 * Si la mano no tiene dos cartas, devuelve cadena vacía.
 */
export function handClass(hand: Card[]): string {
  if (hand.length < 2) return '';
  const a = rankLetter(hand[0]);
  const b = rankLetter(hand[1]);
  const va = RANK_VALUE[a];
  const vb = RANK_VALUE[b];
  const hi = va >= vb ? a : b;
  const lo = va >= vb ? b : a;
  if (hi === lo) return `${hi}${lo}`;
  const suited = hand[0].suit === hand[1].suit ? 's' : 'o';
  return `${hi}${lo}${suited}`;
}

/**
 * Expande una notación de rango a un conjunto de clases concretas.
 * Es deliberadamente pequeño: no interpreta rangos con guiones ni porcentajes,
 * solo las formas que usan las cartas de PokerTH.
 */
export function expandRange(notation: string): Set<string> {
  const result = new Set<string>();

  for (const raw of notation.split(',')) {
    const token = raw.trim();
    if (!token) continue;

    const plus = token.endsWith('+');
    const base = plus ? token.slice(0, -1) : token;
    const match = /^([AKQJT2-9])([AKQJT2-9])([so])?$/.exec(base);
    if (!match) continue;

    const [, hi, lo, suited] = match;
    const vHi = RANK_VALUE[hi];
    const vLo = RANK_VALUE[lo];

    if (hi === lo && !suited) {
      if (plus) {
        for (let v = vLo; v <= 14; v++) {
          result.add(`${VALUE_RANK[v]}${VALUE_RANK[v]}`);
        }
      } else {
        result.add(`${hi}${lo}`);
      }
      continue;
    }

    // `A9s+` sube la segunda carta manteniendo la primera. Es la forma que
    // usan las cartas de PokerTH para "A9s o mejor".
    const last = plus ? vHi - 1 : vLo;
    for (let v = vLo; v <= Math.max(vLo, last); v++) {
      if (v >= vHi) break;
      result.add(`${hi}${VALUE_RANK[v]}${suited ?? ''}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cartas de rango
// ---------------------------------------------------------------------------

// Rangos de mesa social: el objetivo es que la mesa no se convierta en una
// sucesión de folds de ciegas. No son los rangos más teóricos del mundo, pero
// sí son defendibles y mantienen acción en 7-max con 100 BB.
const EARLY_OPEN = '22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 64s+, 54s, A9o+, KTo+, QTo+, JTo';
const MIDDLE_OPEN = '22+, A2s+, K5s+, Q7s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o+, K9o+, Q9o+, J9o+, T9o, 98o';
const LATE_OPEN = '22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 95s+, 84s+, 74s+, 63s+, 53s+, 43s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o, 87o';
const BUTTON_OPEN = '22+, A2s+, K2s+, Q2s+, J4s+, T5s+, 95s+, 84s+, 73s+, 63s+, 52s+, 42s+, 32s, A2o+, K4o+, Q6o+, J7o+, T7o+, 97o+, 86o+, 76o, 65o';
const BB_DEFEND = '22+, A2s+, K2s+, Q2s+, J3s+, T4s+, 94s+, 83s+, 72s+, 62s+, 52s+, 42s+, 32s, A2o+, K2o+, Q4o+, J5o+, T6o+, 95o+, 85o+, 75o+, 65o, 54o';
const SB_DEFEND = '22+, A2s+, K3s+, Q5s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o';

// Los estilos tight/rock conservan una carta más cercana a PokerTH. El resto
// de estilos usa la carta social, que produce más calles y más showdowns.
const TIGHT_EARLY = '22+, A9s+, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo';
const TIGHT_MIDDLE = '22+, A7s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+, QJo';
const TIGHT_LATE = '22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, A5o+, K9o+, Q9o+, J9o+, T9o';
const TIGHT_BUTTON = '22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o';
const TIGHT_BB = '22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o+, K5o+, Q7o+, J8o+, T8o+, 98o, 87o';
const TIGHT_SB = '22+, A2s+, K5s+, Q7s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, A7o+, K9o+, Q9o+, J9o+, T9o';

const THREE_BET_VALUE = 'QQ+, AKs, AKo';
const THREE_BET_BLUFF = 'A5s, A4s, A3s, A2s, KQs, KJs, QJs, T9s, 98s';
const CALL_RAISE_IP = '22+, A2s+, K5s+, Q7s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, A5o+, K9o+, Q9o+, J9o+, T9o, 98o';
const CALL_RAISE_OOP = '22+, A7s+, K9s+, QTs+, JTs, T9s, 98s, ATo+, KJo+, QJo';

const SHORT_PUSH_EARLY = '44+, A7s+, KTs+, QJs, ATo+, KQo';
const SHORT_PUSH_LATE = '22+, A2s+, K7s+, Q9s+, J9s+, T9s, A5o+, K9o+, QTo+, JTo';
const SHORT_PUSH_BLINDS = '22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, A2o+, K8o+, Q9o+, J9o+, T9o';

const LIMP_RANGE = '22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, A9o+, KTo+, QTo+, JTo';

const LOOSE_EXTRA = 'A2s+, K5s+, Q7s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o, 87o';
const AGGRO_EXTRA = 'A5s+, K9s+, QTs+, JTs, T9s, 98s, ATo+, KJo+';

const cache = new Map<string, Set<string>>();

function range(notation: string): Set<string> {
  const cached = cache.get(notation);
  if (cached) return cached;
  const expanded = expandRange(notation);
  cache.set(notation, expanded);
  return expanded;
}

function withStyle(base: string, profile: PreflopProfile): Set<string> {
  if (profile.style === 'loose' || profile.style === 'calling') {
    return range(`${base}, ${LOOSE_EXTRA}`);
  }
  if (profile.style === 'aggressive') {
    return range(`${base}, ${AGGRO_EXTRA}`);
  }
  // tight/rock no se ensanchan: la carta base ya está elegida para ellos.
  return range(base);
}

function inRange(hand: string, rangeSet: Set<string>): boolean {
  return rangeSet.has(hand);
}

/**
 * Calcula la posición preflop sin depender de que el llamante traduzca índices.
 *
 * La distancia 0 es el botón. En una mesa de 7, las distancias 1 y 2 son las
 * ciegas, 3–4 primera/media y 5–6 corte. Es una aproximación suficiente para
 * elegir carta: no se usa para mover dinero, solo para decidir.
 */
export function preflopPosition(ctx: PreflopContext): PreflopPosition {
  if (ctx.isSmallBlind) return 'sb';
  if (ctx.isBigBlind) return 'bb';

  const n = Math.max(2, ctx.tablePlayers ?? ctx.playersLeft);
  const dealer = ctx.dealerIndex ?? 0;
  const current = ctx.currentPlayerIndex ?? ctx.position;
  const distance = ((current - dealer) % n + n) % n;

  if (n === 2) return distance === 0 ? 'button' : 'bb';
  if (distance === 0) return 'button';
  if (distance >= n - 2) return 'late';
  if (distance === 3) return 'early';
  return 'middle';
}

function openRange(position: PreflopPosition, profile: PreflopProfile): Set<string> {
  const tight = profile.style === 'tight' || profile.style === 'rock';
  switch (position) {
    case 'early': return withStyle(tight ? TIGHT_EARLY : EARLY_OPEN, profile);
    case 'middle': return withStyle(tight ? TIGHT_MIDDLE : MIDDLE_OPEN, profile);
    case 'late': return withStyle(tight ? TIGHT_LATE : LATE_OPEN, profile);
    case 'button': return withStyle(tight ? TIGHT_BUTTON : BUTTON_OPEN, profile);
    case 'sb': return withStyle(tight ? TIGHT_SB : SB_DEFEND, profile);
    case 'bb': return withStyle(tight ? TIGHT_BB : BB_DEFEND, profile);
  }
}

function callRange(position: PreflopPosition, profile: PreflopProfile): Set<string> {
  const base = position === 'early' || position === 'middle'
    ? CALL_RAISE_OOP
    : CALL_RAISE_IP;
  return withStyle(base, profile);
}

function pushRange(position: PreflopPosition, profile: PreflopProfile): Set<string> {
  let base = SHORT_PUSH_LATE;
  if (position === 'early' || position === 'middle') base = SHORT_PUSH_EARLY;
  if (position === 'sb' || position === 'bb') base = SHORT_PUSH_BLINDS;
  return withStyle(base, profile);
}

/**
 * Decide una acción preflop. Devuelve siempre una acción; nunca `null`.
 *
 * Reglas:
 * 1. Con 14 BB o menos se juega push/fold: no se hacen subidas pequeñas que
 *    dejen al bot sin stack para las calles siguientes.
 * 2. Sin subida previa se abre con el rango de la posición. El tamaño base es
 *    3 BB más una BB por cada jugador que ya entró.
 * 3. Contra una subida se hace 3-bet con el rango premium, se iguala con el
 *    rango de defensa y se tira el resto.
 * 4. La ciega grande puede ver el flop gratis con manos que no abriría.
 */
export function decidePreflop(ctx: PreflopContext): PreflopDecision {
  const bb = Math.max(1, Math.floor(ctx.bigBlind));
  const stackBB = ctx.chips / bb;
  const position = preflopPosition(ctx);
  const profile = ctx.profile;
  const hand = handClass(ctx.hand);
  const rng = ctx.rng;

  const currentBet = Math.max(0, ctx.currentBet);
  const toCall = Math.max(0, ctx.toCall);
  const canCheck = toCall === 0;
  const facingRaise = currentBet > bb || ctx.preflopRaises > 0;

  const playerBet = Math.max(0, currentBet - toCall);
  const stackTarget = playerBet + ctx.chips;
  const minTarget = currentBet + Math.max(1, ctx.minRaise);

  const subirA = (objetivo: number): PreflopDecision | null => {
    const target = Math.min(stackTarget, Math.max(minTarget, Math.round(objetivo)));
    if (target >= stackTarget) return { action: 'all_in' };
    if (target <= currentBet) return null;
    return { action: 'raise', amount: target };
  };

  // -----------------------------------------------------------------------
  // Stack corto: todo o nada. Es la parte que más cambia el ritmo de un campo.
  // -----------------------------------------------------------------------
  if (stackBB <= 14) {
    const push = pushRange(position, profile);
    if (inRange(hand, push)) {
      return { action: 'all_in' };
    }
    return canCheck ? { action: 'check' } : { action: 'fold' };
  }

  // Si igualar cuesta todo el stack, no hay calles futuras: se decide entre
  // pagar o retirarse usando los rangos de defensa, no una corazonada.
  if (toCall >= ctx.chips) {
    const defense = callRange(position, profile);
    if (inRange(hand, defense)) return { action: 'call' };
    return { action: 'fold' };
  }

  // -----------------------------------------------------------------------
  // Sin subida previa
  // -----------------------------------------------------------------------
  if (!facingRaise) {
    const opens = openRange(position, profile);

    if (inRange(hand, opens)) {
      // La ciega grande no sube cualquier mano con la que podría ver gratis.
      if (position === 'bb' && canCheck && !inRange(hand, range(THREE_BET_VALUE))) {
        return { action: 'check' };
      }

      const limpers = Math.max(0, ctx.playersLeft - 3);
      const target = Math.max(
        bb * 3 + limpers * bb,
        currentBet + bb * 2 + limpers * bb,
      );
      const raise = subirA(target);
      if (raise) return raise;
      return canCheck ? { action: 'check' } : { action: 'call' };
    }

    // Limping controlado: una mano marginal que no abre puede ver el flop
    // barato. Sin esto, la mesa se llena de folds y el jugador humano pasa
    // media partida mirando ciegas. Tight/rock no limpan: para ellos la mano
    // no está en la carta.
    const limpia = profile.style !== 'tight' && profile.style !== 'rock';
    if (limpia && toCall <= bb && inRange(hand, withStyle(LIMP_RANGE, profile))) {
      return { action: 'call' };
    }

    return canCheck ? { action: 'check' } : { action: 'fold' };
  }

  // -----------------------------------------------------------------------
  // Contra una subida
  // -----------------------------------------------------------------------
  const premium = withStyle(THREE_BET_VALUE, profile);
  const bluff3Bet = profile.style === 'aggressive' || profile.style === 'loose';
  const threeBetRange = bluff3Bet
    ? range(`${THREE_BET_VALUE}, ${THREE_BET_BLUFF}`)
    : premium;

  if (inRange(hand, threeBetRange) && ctx.preflopRaises < 3) {
    // 3-bet a 3x la subida, con un mínimo de 8 BB para no dar precio.
    const target = Math.max(bb * 8, currentBet * 3);
    const raise = subirA(target);
    if (raise) return raise;
  }

  const defense = callRange(position, profile);
  const blindDefense = position === 'bb' || position === 'sb'
    ? withStyle(BB_DEFEND, profile)
    : null;

  if (inRange(hand, defense) || (blindDefense && inRange(hand, blindDefense))) {
    // Un 3-bet ligero de vez en cuando evita que el bot sea una estatua.
    if (rng() < profile.aggression * 0.06 && ctx.preflopRaises < 3) {
      const raise = subirA(Math.max(bb * 8, currentBet * 3));
      if (raise) return raise;
    }
    return { action: 'call' };
  }

  return { action: 'fold' };
}
