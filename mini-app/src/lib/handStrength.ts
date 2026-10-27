/**
 * FUERZA DE LA MANO EN EL CLIENTE
 * ================================
 *
 * Con 7 cartas (2 tuyas + 5 comunitarias) hay C(7,5) = 21 combinaciones
 * posibles. Esta función las recorre **todas** y devuelve la mejor. Antes se
 * evaluaba el array de 7 como si fuera una mano de 5: una pareja podía tapar
 * un color, y el as bajo de la rueda no se detectaba.
 *
 * No se calcula nada sobre las cartas del rival. Solo se usan las tuyas y las
 * comunitarias, que son públicas. El showdown real lo decide el servidor con
 * `hand.evaluator.ts`; este evaluador es para el indicador de fuerza y para que
 * el jugador vea su mano mientras decide.
 *
 * La lógica es deliberadamente la misma que la del servidor: misma escala de
 * categorías, mismos kickers y misma rueda. Si cambia una, cambia la otra.
 */

export type HandRank =
  | 'high-card'
  | 'pair'
  | 'two-pair'
  | 'trips'
  | 'straight'
  | 'flush'
  | 'full-house'
  | 'quads'
  | 'straight-flush'
  | 'royal-flush';

export interface HandResult {
  rank: HandRank;
  /** Nombre corto para el chip de la mesa. */
  name: string;
  /** Los rangos de las cinco cartas que forman la mano, de mayor a menor. */
  cards: string;
  /** 0 a 1. Para la barra de fuerza. */
  score: number;
}

export interface Card {
  rank: string;
  suit: string;
}

const VALOR: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

const ETIQUETA: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const NOMBRES: Record<HandRank, string> = {
  'royal-flush': 'Escalera real',
  'straight-flush': 'Escalera de color',
  quads: 'Póker',
  'full-house': 'Full house',
  flush: 'Color',
  straight: 'Escalera',
  trips: 'Trío',
  'two-pair': 'Dos parejas',
  pair: 'Pareja',
  'high-card': 'Carta alta',
};

/** La categoría, de menor a mayor. Se usa para comparar y para el score. */
const CATEGORIA: Record<HandRank, number> = {
  'high-card': 0,
  pair: 1,
  'two-pair': 2,
  trips: 3,
  straight: 4,
  flush: 5,
  'full-house': 6,
  quads: 7,
  'straight-flush': 8,
  'royal-flush': 9,
};

const SCORE_BASE: Record<HandRank, number> = {
  'high-card': 0.08,
  pair: 0.22,
  'two-pair': 0.36,
  trips: 0.5,
  straight: 0.62,
  flush: 0.7,
  'full-house': 0.82,
  quads: 0.9,
  'straight-flush': 0.96,
  'royal-flush': 1,
};

const valor = (c: Card): number => VALOR[String(c.rank).toUpperCase()] ?? 0;

/** Combinaciones de `size` cartas. Para 7 cartas son 21. */
const combinaciones = (cartas: Card[], size: number): Card[][] => {
  const resultado: Card[][] = [];
  const actual: Card[] = [];

  const recorrer = (inicio: number): void => {
    if (actual.length === size) {
      resultado.push([...actual]);
      return;
    }
    for (let i = inicio; i <= cartas.length - (size - actual.length); i++) {
      actual.push(cartas[i]);
      recorrer(i + 1);
      actual.pop();
    }
  };

  recorrer(0);
  return resultado;
};

const ordenar = (cartas: Card[]): Card[] =>
  [...cartas].sort((a, b) => valor(b) - valor(a));

/** Carta alta de la escalera, o 0 si no hay. La rueda vale 5. */
const escaleraAlta = (valores: number[]): number => {
  const unicos = [...new Set(valores)].sort((a, b) => b - a);
  if (unicos.includes(14)) unicos.push(1);

  for (let i = 0; i + 4 < unicos.length; i++) {
    const alta = unicos[i];
    if (
      unicos[i + 1] === alta - 1 &&
      unicos[i + 2] === alta - 2 &&
      unicos[i + 3] === alta - 3 &&
      unicos[i + 4] === alta - 4
    ) {
      return alta;
    }
  }
  return 0;
};

/**
 * Evalúa exactamente cinco cartas. Devuelve la categoría, las cinco que la
 * forman y el valor numérico de desempate.
 */
const evaluarCinco = (cartas: Card[]): HandResult & { valor: number } => {
  const ordenadas = ordenar(cartas);
  const valores = ordenadas.map(valor);
  const grupos = new Map<number, number>();
  for (const v of valores) grupos.set(v, (grupos.get(v) ?? 0) + 1);

  const conteos = [...grupos.entries()]
    .map(([v, count]) => ({ v, count }))
    .sort((a, b) => b.count - a.count || b.v - a.v);

  const color = ordenadas.every((c) => c.suit === ordenadas[0].suit);
  const altaEscalera = escaleraAlta(valores);

  if (color && altaEscalera > 0) {
    const rango: HandRank = altaEscalera === 14 ? 'royal-flush' : 'straight-flush';
    return {
      rank: rango,
      name: NOMBRES[rango],
      cards: [altaEscalera, altaEscalera - 1, altaEscalera - 2, altaEscalera - 3, altaEscalera - 4]
        .map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE[rango],
      valor: CATEGORIA[rango] * 15 ** 5 + altaEscalera * 15 ** 4,
    };
  }

  if (conteos[0]?.count === 4) {
    const cuadruple = conteos[0].v;
    const kicker = conteos.find((c) => c.v !== cuadruple)?.v ?? 0;
    return {
      rank: 'quads',
      name: NOMBRES.quads,
      cards: [cuadruple, kicker].map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE.quads,
      valor: CATEGORIA.quads * 15 ** 5 + cuadruple * 15 ** 4 + kicker * 15 ** 3,
    };
  }

  if (conteos[0]?.count === 3 && (conteos[1]?.count ?? 0) >= 2) {
    const trio = conteos[0].v;
    const pareja = conteos[1].v;
    return {
      rank: 'full-house',
      name: NOMBRES['full-house'],
      cards: [trio, pareja].map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE['full-house'],
      valor: CATEGORIA['full-house'] * 15 ** 5 + trio * 15 ** 4 + pareja * 15 ** 3,
    };
  }

  if (color) {
    const top5 = valores.slice(0, 5);
    return {
      rank: 'flush',
      name: NOMBRES.flush,
      cards: top5.map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE.flush,
      valor: CATEGORIA.flush * 15 ** 5 +
        top5[0] * 15 ** 4 + top5[1] * 15 ** 3 + top5[2] * 15 ** 2 + top5[3] * 15 + top5[4],
    };
  }

  if (altaEscalera > 0) {
    return {
      rank: 'straight',
      name: NOMBRES.straight,
      cards: [altaEscalera, altaEscalera - 1, altaEscalera - 2, altaEscalera - 3, altaEscalera - 4]
        .map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE.straight,
      valor: CATEGORIA.straight * 15 ** 5 + altaEscalera * 15 ** 4,
    };
  }

  if (conteos[0]?.count === 3) {
    const trio = conteos[0].v;
    const kickers = conteos
      .filter((c) => c.v !== trio)
      .map((c) => c.v)
      .sort((a, b) => b - a)
      .slice(0, 2);
    return {
      rank: 'trips',
      name: NOMBRES.trips,
      cards: [trio, ...kickers].map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE.trips,
      valor: CATEGORIA.trips * 15 ** 5 +
        trio * 15 ** 4 + (kickers[0] ?? 0) * 15 ** 3 + (kickers[1] ?? 0) * 15 ** 2,
    };
  }

  const parejas = conteos.filter((c) => c.count === 2).sort((a, b) => b.v - a.v);
  if (parejas.length >= 2) {
    const alta = parejas[0].v;
    const baja = parejas[1].v;
    const kicker = conteos
      .filter((c) => c.v !== alta && c.v !== baja)
      .map((c) => c.v)
      .sort((a, b) => b - a)[0] ?? 0;
    return {
      rank: 'two-pair',
      name: NOMBRES['two-pair'],
      cards: [alta, baja, kicker].map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE['two-pair'],
      valor: CATEGORIA['two-pair'] * 15 ** 5 +
        alta * 15 ** 4 + baja * 15 ** 3 + kicker * 15 ** 2,
    };
  }

  if (parejas.length === 1) {
    const pareja = parejas[0].v;
    const kickers = conteos
      .filter((c) => c.v !== pareja)
      .map((c) => c.v)
      .sort((a, b) => b - a)
      .slice(0, 3);
    return {
      rank: 'pair',
      name: NOMBRES.pair,
      cards: [pareja, ...kickers].map((v) => ETIQUETA[v]).join(' '),
      score: SCORE_BASE.pair,
      valor: CATEGORIA.pair * 15 ** 5 +
        pareja * 15 ** 4 + (kickers[0] ?? 0) * 15 ** 3 +
        (kickers[1] ?? 0) * 15 ** 2 + (kickers[2] ?? 0) * 15,
    };
  }

  const top5 = valores.slice(0, 5);
  return {
    rank: 'high-card',
    name: NOMBRES['high-card'],
    cards: top5.map((v) => ETIQUETA[v]).join(' '),
    score: SCORE_BASE['high-card'],
    valor: CATEGORIA['high-card'] * 15 ** 5 +
      top5[0] * 15 ** 4 + top5[1] * 15 ** 3 + top5[2] * 15 ** 2 + top5[3] * 15 + top5[4],
  };
};

/**
 * Fuerza de una mano de 5 a 7 cartas. Devuelve `null` si todavía no hay cinco
 * cartas: antes de eso no existe una mano de póker que calificar.
 */
export function evaluarMano(cards: Card[]): HandResult | null {
  if (!Array.isArray(cards) || cards.length < 5) return null;

  const combos = cards.length === 5 ? [cards] : combinaciones(cards, 5);
  let mejor = evaluarCinco(combos[0]);

  for (let i = 1; i < combos.length; i++) {
    const candidato = evaluarCinco(combos[i]);
    if (candidato.valor > mejor.valor) mejor = candidato;
  }

  // El score añade hasta 0.04 según el desempate dentro de la categoría. No
  // cambia el orden: la categoría siempre pesa más.
  const dentro = (mejor.valor % 15 ** 5) / 15 ** 5;
  const score = Math.min(1, mejor.score + dentro * 0.04);

  return {
    rank: mejor.rank,
    name: mejor.name,
    cards: mejor.cards,
    score,
  };
}

/** Convierte una carta serializada por el servidor (`"A|spades"`). */
export const parseCard = (raw: string): Card | null => {
  if (!raw || typeof raw !== 'string') return null;
  const [rank, suit] = raw.split('|');
  if (!rank || !suit) return null;
  return { rank, suit };
};
