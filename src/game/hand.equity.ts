import { Card, createDeck } from './card.utils';
import { evaluateHand } from './hand.evaluator';

/**
 * Equidad de las manos conocidas en un showdown all-in.
 *
 * El servidor ya no reparte el board calle a calle cuando todos estan all-in:
 * el motor resuelve la mano de golpe. Para que la interfaz pueda ensenar algo
 * parecido a lo que se ve en una mesa real, calculamos aqui la probabilidad de
 * cada mano con las cartas que ya se conocen. La UI reproduce esas fotografias
 * en orden (preflop, flop, turn, river) mientras muestra las cartas all-in.
 *
 * Es una estimacion Monte Carlo, no una promesa de resultado: con 3.000
 * repartos aleatorios el error es de decimas y el jugador ve porcentajes que
 * se mueven como en cualquier retransmision. La semilla es fija para que el
 * mismo board y las mismas manos den siempre el mismo numero; si no, dos
 * peticiones seguidas del cliente podrian ensenar 72 % y 71 % de la misma
 * calle y pareceria que la mesa esta rota.
 */

export interface EquityPlayer {
  /** Identificador estable, normalmente el indice de asiento. */
  id: string;
  cards: Card[];
}

export interface EquityResult {
  playerId: string;
  /** Porcentaje de ganar el bote completo (las ties se reparten). */
  equity: number;
  /** Porcentaje de veces que gana sin compartir. */
  win: number;
  /** Porcentaje de veces que empata. */
  tie: number;
}

const key = (card: Card): string => `${card.rank}|${card.suit}`;

/** Generador pequeno y reproducible. No se usa para barajar dinero. */
const seededRandom = (seed: number): (() => number) => {
  let estado = seed >>> 0;
  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0;
    let t = estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

const cartasUnicas = (cartas: Card[]): Card[] => {
  const vistos = new Set<string>();
  return cartas.filter((c) => {
    const k = key(c);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
};

/**
 * Calcula la equidad de `players` con el board parcial indicado.
 *
 * Si el board ya tiene cinco cartas no se simula nada: se evalua la mano final
 * y se reparte el 100 % entre los que empatan. Para las calles anteriores se
 * reparten las cartas que faltan y se evalua cada resultado.
 */
export const calculateEquity = (
  players: EquityPlayer[],
  board: Card[],
  iterations = 3_000,
  seed = 1,
): EquityResult[] => {
  const activos = players.filter((p) => p.cards.length >= 2);
  if (activos.length === 0) return [];
  if (activos.length === 1) {
    return [{ playerId: activos[0].id, equity: 100, win: 100, tie: 0 }];
  }

  const boardConocido = cartasUnicas(board).slice(0, 5);
  const conocidas = new Set<string>([
    ...boardConocido.map(key),
    ...activos.flatMap((p) => p.cards.slice(0, 2).map(key)),
  ]);

  const mazo = createDeck().filter((c) => !conocidas.has(key(c)));
  const faltan = 5 - boardConocido.length;

  const victorias = new Map<string, number>();
  const empates = new Map<string, number>();
  const equidad = new Map<string, number>();
  for (const p of activos) {
    victorias.set(p.id, 0);
    empates.set(p.id, 0);
    equidad.set(p.id, 0);
  }

  const evaluar = (boardFinal: Card[]): void => {
    const valores = activos.map((p) => ({
      id: p.id,
      valor: evaluateHand([...p.cards.slice(0, 2), ...boardFinal]).value,
    }));
    const maximo = Math.max(...valores.map((v) => v.valor));
    const ganadores = valores.filter((v) => v.valor === maximo);
    const reparto = 1 / ganadores.length;

    for (const g of ganadores) {
      victorias.set(g.id, (victorias.get(g.id) ?? 0) + (ganadores.length === 1 ? 1 : 0));
      if (ganadores.length > 1) {
        empates.set(g.id, (empates.get(g.id) ?? 0) + 1);
      }
      equidad.set(g.id, (equidad.get(g.id) ?? 0) + reparto);
    }
  };

  if (faltan <= 0) {
    evaluar(boardConocido);
  } else {
    const rnd = seededRandom(seed);
    const total = Math.max(200, Math.min(10_000, Math.floor(iterations)));
    for (let i = 0; i < total; i++) {
      // Fisher-Yates parcial: solo se barajan las cartas que hacen falta.
      const copia = [...mazo];
      for (let j = 0; j < faltan; j++) {
        const k = j + Math.floor(rnd() * (copia.length - j));
        [copia[j], copia[k]] = [copia[k], copia[j]];
      }
      evaluar([...boardConocido, ...copia.slice(0, faltan)]);
    }
  }

  const totalIteraciones = faltan <= 0 ? 1 : Math.max(200, Math.min(10_000, Math.floor(iterations)));

  const redondeados = activos.map((p) => ({
    playerId: p.id,
    equity: Math.round(((equidad.get(p.id) ?? 0) / totalIteraciones) * 100),
    win: Math.round(((victorias.get(p.id) ?? 0) / totalIteraciones) * 100),
    tie: Math.round(((empates.get(p.id) ?? 0) / totalIteraciones) * 100),
  }));

  // El redondeo independiente puede dejar 99 % o 101 %. Se corrige en el
  // jugador con mayor equidad para que la interfaz nunca sume de mas.
  const suma = redondeados.reduce((acc, r) => acc + r.equity, 0);
  if (suma !== 100 && redondeados.length > 0) {
    const indice = redondeados.reduce(
      (mejor, r, i) => (r.equity > redondeados[mejor].equity ? i : mejor),
      0,
    );
    redondeados[indice].equity += 100 - suma;
  }

  return redondeados;
};
