import { Card } from './card.utils';

/**
 * EVALUADOR DE MANOS DE POKER
 * ===========================
 *
 * Este archivo es la última palabra sobre quién gana una mano. Un error aquí no
 * se ve en pantalla: se ve como un jugador que pierde un bote que había ganado,
 * o como dos jugadores que deberían empatar y uno cobra de más. Por eso el
 * evaluador se prueba aparte del motor, con las 21 combinaciones de 7 cartas.
 *
 * Reglas que implementa, y que antes faltaban:
 *
 *   - Kickers completos. Dos parejas de ases y reyes NO empatan si una lleva
 *     kicker de dama y la otra de diez. Antes el valor solo miraba las parejas.
 *   - La rueda A-2-3-4-5. El as vale 1 y la escalera es la más baja. Antes se
 *     ordenaba como A-5-4-3-2 y no se detectaba.
 *   - Desempate de color por las cinco cartas, no solo por la más alta.
 *   - La mejor combinación de 5 entre 7, no una aproximación.
 *
 * El valor numérico se construye con base 15 (2..14 y un hueco para el as bajo)
 * y cinco posiciones. Así el desempate es una simple comparación de enteros:
 *
 *     valor = categoría * 15^5 + c1*15^4 + c2*15^3 + c3*15^2 + c4*15 + c5
 *
 * No se usan números decimales ni `Math.random`: dos evaluaciones de la misma
 * mano dan exactamente el mismo valor, siempre.
 */

export type HandRank =
  | 'high_card'
  | 'pair'
  | 'two_pair'
  | 'three_of_a_kind'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'four_of_a_kind'
  | 'straight_flush'
  | 'royal_flush';

export interface HandResult {
  rank: HandRank;
  name: string;
  /** Valor entero comparable. Mayor gana; igual empata. */
  value: number;
  /** Las cinco cartas exactas que forman la mano. */
  bestCards: Card[];
}

const HAND_RANK_NAMES: Record<HandRank, string> = {
  high_card: 'Carta Alta',
  pair: 'Pareja',
  two_pair: 'Doble Pareja',
  three_of_a_kind: 'Trío',
  straight: 'Escalera',
  flush: 'Color',
  full_house: 'Full House',
  four_of_a_kind: 'Póker',
  straight_flush: 'Escalera de Color',
  royal_flush: 'Escalera Real',
};

/**
 * Orden de categorías. El índice es la parte alta del valor numérico.
 * `royal_flush` va por encima de `straight_flush` solo para poder mostrarla con
 * nombre propio; en comparación siempre es una escalera de color al as.
 */
const CATEGORY: Record<HandRank, number> = {
  high_card: 0,
  pair: 1,
  two_pair: 2,
  three_of_a_kind: 3,
  straight: 4,
  flush: 5,
  full_house: 6,
  four_of_a_kind: 7,
  straight_flush: 8,
  royal_flush: 9,
};

/** 15^5. Cada posición de desempate admite valores 0..14. */
const CATEGORY_SIZE = 15 ** 5;

const encode = (rank: HandRank, slots: number[]): number => {
  // Siempre cinco posiciones. Si falta alguna se rellena con 0, que es más bajo
  // que cualquier carta real (2..14). Así no hay colisiones entre manos.
  const cinco = [0, 0, 0, 0, 0];
  for (let i = 0; i < 5 && i < slots.length; i++) cinco[i] = slots[i];

  return CATEGORY[rank] * CATEGORY_SIZE +
    cinco[0] * 15 ** 4 +
    cinco[1] * 15 ** 3 +
    cinco[2] * 15 ** 2 +
    cinco[3] * 15 +
    cinco[4];
};

const rankValue = (card: Card): number => {
  // El cliente manda `rank` como texto. El servidor construye las cartas con
  // `value`, pero se acepta cualquiera de las dos formas para que una carta
  // serializada no rompa el showdown.
  if (Number.isFinite(card.value) && card.value >= 2) return card.value;
  const table: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, J: 11, Q: 12, K: 13, A: 14, T: 10,
  };
  return table[String(card.rank).toUpperCase()] ?? 0;
};

const byRank = (cards: Card[]): Map<number, Card[]> => {
  const map = new Map<number, Card[]>();
  for (const card of cards) {
    const value = rankValue(card);
    const list = map.get(value) ?? [];
    list.push(card);
    map.set(value, list);
  }
  return map;
};

/**
 * Devuelve la carta alta de la escalera, o 0 si no hay.
 *
 * Se trabaja con valores únicos. La rueda se detecta añadiendo un as bajo (1)
 * además del as alto (14), que es la única excepción del poker.
 */
const straightHigh = (uniqueValues: number[]): number => {
  const values = [...new Set(uniqueValues)].sort((a, b) => b - a);
  if (values.includes(14)) values.push(1);

  for (let i = 0; i + 4 < values.length; i++) {
    const high = values[i];
    if (
      values[i + 1] === high - 1 &&
      values[i + 2] === high - 2 &&
      values[i + 3] === high - 3 &&
      values[i + 4] === high - 4
    ) {
      return high;
    }
  }
  return 0;
};

/** Toma una carta de cada valor pedido. Para la rueda, el 1 se busca como as. */
const pickRanks = (cards: Card[], ranks: number[]): Card[] => {
  const groups = byRank(cards);
  const picked: Card[] = [];
  for (const rank of ranks) {
    const realRank = rank === 1 ? 14 : rank;
    const group = groups.get(realRank);
    if (group && group.length > 0) picked.push(group.shift()!);
  }
  return picked;
};

const sortDesc = (cards: Card[]): Card[] =>
  [...cards].sort((a, b) => rankValue(b) - rankValue(a));

/**
 * Evalúa exactamente cinco cartas. Es la unidad de verdad del evaluador.
 * `evaluateHand` solo la llama con combinaciones de cinco.
 */
const evaluateFive = (cards: Card[]): HandResult => {
  const sorted = sortDesc(cards);
  const values = sorted.map(rankValue);
  const groups = byRank(cards);
  const counts = [...groups.entries()]
    .map(([value, list]) => ({ value, count: list.length }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const flush = sorted.every(card => card.suit === sorted[0].suit);
  const highStraight = straightHigh(values);

  // --- Escalera de color / escalera real -------------------------------
  if (flush && highStraight > 0) {
    const ranks = [highStraight, highStraight - 1, highStraight - 2, highStraight - 3, highStraight - 4];
    const best = sortDesc(pickRanks(cards, ranks));
    const royal = highStraight === 14;
    const rank: HandRank = royal ? 'royal_flush' : 'straight_flush';
    return {
      rank,
      name: HAND_RANK_NAMES[rank],
      value: encode(rank, [highStraight, 0, 0, 0, 0]),
      bestCards: best,
    };
  }

  // --- Póker ------------------------------------------------------------
  if (counts[0]?.count === 4) {
    const quad = counts[0].value;
    const kicker = counts.find(c => c.value !== quad)?.value ?? 0;
    return {
      rank: 'four_of_a_kind',
      name: HAND_RANK_NAMES.four_of_a_kind,
      value: encode('four_of_a_kind', [quad, kicker, 0, 0, 0]),
      bestCards: sortDesc(pickRanks(cards, [quad, quad, quad, quad, kicker])),
    };
  }

  // --- Full house -------------------------------------------------------
  if (counts[0]?.count === 3 && counts[1]?.count >= 2) {
    const trip = counts[0].value;
    const pair = counts[1].value;
    return {
      rank: 'full_house',
      name: HAND_RANK_NAMES.full_house,
      value: encode('full_house', [trip, pair, 0, 0, 0]),
      bestCards: sortDesc(pickRanks(cards, [trip, trip, trip, pair, pair])),
    };
  }

  // --- Color ------------------------------------------------------------
  if (flush) {
    const top5 = sorted.slice(0, 5).map(rankValue);
    return {
      rank: 'flush',
      name: HAND_RANK_NAMES.flush,
      value: encode('flush', top5),
      bestCards: sorted.slice(0, 5),
    };
  }

  // --- Escalera ---------------------------------------------------------
  if (highStraight > 0) {
    const ranks = [highStraight, highStraight - 1, highStraight - 2, highStraight - 3, highStraight - 4];
    return {
      rank: 'straight',
      name: HAND_RANK_NAMES.straight,
      value: encode('straight', [highStraight, 0, 0, 0, 0]),
      bestCards: sortDesc(pickRanks(cards, ranks)),
    };
  }

  // --- Trío -------------------------------------------------------------
  if (counts[0]?.count === 3) {
    const trip = counts[0].value;
    const kickers = counts
      .filter(c => c.value !== trip)
      .map(c => c.value)
      .sort((a, b) => b - a)
      .slice(0, 2);
    return {
      rank: 'three_of_a_kind',
      name: HAND_RANK_NAMES.three_of_a_kind,
      value: encode('three_of_a_kind', [trip, kickers[0] ?? 0, kickers[1] ?? 0, 0, 0]),
      bestCards: sortDesc(pickRanks(cards, [trip, trip, trip, kickers[0] ?? 0, kickers[1] ?? 0])),
    };
  }

  // --- Dos parejas ------------------------------------------------------
  const pairs = counts.filter(c => c.count === 2).sort((a, b) => b.value - a.value);
  if (pairs.length >= 2) {
    const highPair = pairs[0].value;
    const lowPair = pairs[1].value;
    const kicker = counts
      .filter(c => c.value !== highPair && c.value !== lowPair)
      .map(c => c.value)
      .sort((a, b) => b - a)[0] ?? 0;
    return {
      rank: 'two_pair',
      name: HAND_RANK_NAMES.two_pair,
      value: encode('two_pair', [highPair, lowPair, kicker, 0, 0]),
      bestCards: sortDesc(pickRanks(cards, [highPair, highPair, lowPair, lowPair, kicker])),
    };
  }

  // --- Pareja -----------------------------------------------------------
  if (pairs.length === 1) {
    const pair = pairs[0].value;
    const kickers = counts
      .filter(c => c.value !== pair)
      .map(c => c.value)
      .sort((a, b) => b - a)
      .slice(0, 3);
    return {
      rank: 'pair',
      name: HAND_RANK_NAMES.pair,
      value: encode('pair', [pair, kickers[0] ?? 0, kickers[1] ?? 0, kickers[2] ?? 0, 0]),
      bestCards: sortDesc(pickRanks(cards, [pair, pair, kickers[0] ?? 0, kickers[1] ?? 0, kickers[2] ?? 0])),
    };
  }

  // --- Carta alta -------------------------------------------------------
  const top5 = sorted.slice(0, 5).map(rankValue);
  return {
    rank: 'high_card',
    name: HAND_RANK_NAMES.high_card,
    value: encode('high_card', top5),
    bestCards: sorted.slice(0, 5),
  };
};

/** Combinaciones de `size` cartas. Para 7 cartas son 21, no hace falta más. */
const combinations = (cards: Card[], size: number): Card[][] => {
  const result: Card[][] = [];
  const current: Card[] = [];

  const walk = (start: number): void => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let i = start; i <= cards.length - (size - current.length); i++) {
      current.push(cards[i]);
      walk(i + 1);
      current.pop();
    }
  };

  walk(0);
  return result;
};

/**
 * Evalúa una mano de 5 a 7 cartas y devuelve la mejor combinación posible.
 *
 * Con 7 cartas hay C(7,5) = 21 combinaciones. Se evalúan todas; quedarse con
 * una aproximación es exactamente lo que produce ganadores equivocados en las
 * manos con color y escalera al mismo tiempo.
 */
export const evaluateHand = (cards: Card[]): HandResult => {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { rank: 'high_card', name: HAND_RANK_NAMES.high_card, value: 0, bestCards: [] };
  }

  if (cards.length < 5) {
    return {
      rank: 'high_card',
      name: HAND_RANK_NAMES.high_card,
      value: encode('high_card', sortDesc(cards).slice(0, 5).map(rankValue)),
      bestCards: sortDesc(cards).slice(0, 5),
    };
  }

  const combos = cards.length === 5 ? [cards] : combinations(cards, 5);
  let best = evaluateFive(combos[0]);

  for (let i = 1; i < combos.length; i++) {
    const candidate = evaluateFive(combos[i]);
    if (candidate.value > best.value) best = candidate;
  }

  return best;
};

/** Compara dos manos. Positivo si `a` gana, negativo si gana `b`, 0 si empatan. */
export const compareHands = (a: HandResult, b: HandResult): number => a.value - b.value;
