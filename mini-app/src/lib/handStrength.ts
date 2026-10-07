/**
 * FUERZA DE LA MANO. Que tan buena es, con lo que se ve.
 *
 * ------------------------------------------------------------------
 * QUE ES Y POR QUE
 *
 * Con 7 cartas (2 tuyas + 5 comunitarias) hay C(7,5) = 21 combinaciones posibles. Esta
 * funcion las recorre todas y devuelve la mejor, con su nombre.
 *
 * Sin esto, el jugador mira sus dos cartas y las del rival, y no tiene manera de saber si va
 * ganando. En una mesa de poker real el jugador sabe aproximadamente donde esta: eso es parte
 * del juego, no un extra. Y con una mesa de bots es aún más necesario, porque no hay cuerpo,
 * ni expressions, ni forma de leer a nadie.
 *
 * ------------------------------------------------------------------
 * POR QUE NO SE USA EL DEL SERVIDOR
 *
 * El motor sabe evaluar la mano en el showdown, cuando ya se hanilers todas las cartas. Pero
 * eso es en el servidor y solo al final. Para un indicador de fuerza hace falta en el cliente,
 * en cada carta que sale, y sin pedir nada por red: enviar el estado de la mano del rival en
 * cada jugada seria decirle al navegador lo que todavia no puede saber, y ademas ralentiza
 * cada actualizacion.
 *
 * Aqui no se calcula NADA sobre las cartas del rival. Solo sobre las tuyas y las comunitarias,
 * que son publicas por definicion.
 *
 * ------------------------------------------------------------------
 * ORDEN DE LAS MANOS (de mas fuerte a mas debil)
 *
 *   8  Escoba real      las 5 del mismo palo
 *   9  Escalera real    5 en linea del mismo palo
 *   10 Cuatro iguales   4 del mismo numero
 *   11 Full house       3 iguales + pareja
 *   12 Flush            5 del mismo palo
 *   13 Escalera         5 en linea
 *   14 Tres iguales     3 del mismo numero
 *   15 Dos parejas
 *   16 Una pareja
 *   17 Carta alta
 */

export type HandRank =
  | 'high-card' | 'pair' | 'two-pair' | 'trips' | 'straight'
  | 'flush' | 'full-house' | 'quads' | 'straight-flush' | 'royal-flush';

export interface HandResult {
  rank: HandRank;
  /** Nombre corto para el chip de la mesa: "Full House", "Dos parejas"... */
  name: string;
  /** Los numeros y palo que la forman, ordenados de mayor a menor. */
  cards: string;
  /** 0 a 1. Para la barra de fuerza. */
  score: number;
}

export interface Card {
  rank: string;
  suit: string;
}

/** El as se ordena como 14, para que "A K Q J T" sea la mejor escalera. */
const VALOR: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

const ETIQUETA: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/**
 * El as mas bajo (A-2-3-4-5) es la peor escalera y la unica con el as abajo. Se detecta
 * contando el as COMO 1 en una copia de los valores, no con una lista fija: asi funciona
 * tambien dentro de las 21 combinaciones de una mano de 7 cartas.
 */

const NOMBRES: Record<HandRank, string> = {
  'royal-flush': 'Escoba real',
  'straight-flush': 'Escalera real',
  quads: 'Cuatro iguales',
  'full-house': 'Full house',
  flush: 'Color',
  straight: 'Escalera',
  trips: 'Tres iguales',
  'two-pair': 'Dos parejas',
  pair: 'Pareja',
  'high-card': 'Carta alta',
};

/**
 * Fuerza de una mano de hasta 7 cartas.
 *
 * Con menos de 5 cartas no hay mano: devuelve `null`, que es lo que pasa al empezar una mano,
 * cuando solo tienes dos y no hay comunitarias. La interfaz muestra el chip en cuanto hay
 * cartas suficientes, y no antes.
 */
export function evaluarMano(cards: Card[]): HandResult | null {
  if (!Array.isArray(cards) || cards.length < 5) return null;

  const valores = cards.map((c) => VALOR[c.rank] ?? 0).sort((a, b) => b - a);
  const palos = cards.map((c) => c.suit);

  // El AS alto (14) se cuenta TAMBIEN como 1 para detectar A-2-3-4-5, que es la peor escalera.
  const conAsBajo = [...valores.map((v) => (v === 14 ? 1 : v))].sort((a, b) => b - a);

  const porNumero = new Map<number, number>();
  for (const v of valores) porNumero.set(v, (porNumero.get(v) ?? 0) + 1);

  // Los palos que se repiten.
  const porPalo = new Map<string, string[]>();
  for (let i = 0; i < palos.length; i++) {
    const l = porPalo.get(palos[i]) ?? [];
    l.push(cards[i].rank);
    porPalo.set(palos[i], l);
  }
  const color = [...porPalo.values()].find((l) => l.length >= 5);

  const escalera = (vals: number[]): number[] | null => {
    for (let i = 0; i <= vals.length - 5; i++) {
      const r = vals.slice(i, i + 5);
      if (r.every((v, j) => j === 0 || r[j - 1] - v === 1)) return r;
    }
    return null;
  };

  const escPorNumero = escalera(valores);
  const escPorAs = escalera(conAsBajo);

  const gruposOrdenados = [...porNumero.entries()].sort((a, b) =>
    b[1] - a[1] || b[0] - a[0],
  );

  const [mayor, sgundo] = gruposOrdenados;

  // `undefined` mientras no se haya clasificado. La comprobacion de abajo es `if (!rank)`, y
  // con una cadena inicializada SIEMPRE seria falsa: se saltaria el bloque entero y todo
  // acabaria como "carta alta". El tipo lo declara como opcional para que quepa la idea de
  // "todavia sin clasificar" y para que no se queja de usar la variable antes de asignarla.
  let rank: HandRank | undefined;
  let cartas: string[] = [];
  let score = 0;

  // Escalera de color
  if (color && color.length >= 5) {
    const vals = color.map((r) => VALOR[r]).sort((a, b) => b - a);
    const esc = escalera(vals) ?? escalera(vals.map((v) => (v === 14 ? 1 : v)));
    if (esc) {
      const masAlta = Math.max(...esc);
      rank = masAlta === 14 ? 'royal-flush' : 'straight-flush';
      cartas = esc.map((v) => ETIQUETA[v]);
      score = rank === 'royal-flush' ? 1 : 0.94;
    }
  }

  if (!rank) {
    // Cuatro iguales
    if (mayor && mayor[1] === 4) {
      rank = 'quads';
      cartas = [ETIQUETA[mayor[0]], ETIQUETA[sgundo[0]]];
      score = 0.9;
    }
    // Full house
    else if (mayor && mayor[1] === 3 && sgundo && sgundo[1] >= 2) {
      rank = 'full-house';
      cartas = [ETIQUETA[mayor[0]], ETIQUETA[sgundo[0]]];
      score = 0.82;
    }
    // Color
    else if (color && color.length >= 5) {
      rank = 'flush';
      const orden = color
        .map((r) => VALOR[r])
        .sort((a, b) => b - a)
        .slice(0, 5);
      cartas = orden.map((v) => ETIQUETA[v]);
      score = 0.66;
    }
    // Escalera
    else if (escPorNumero || escPorAs) {
      rank = 'straight';
      const esc = escPorNumero ?? escPorAs!;
      cartas = esc.map((v) => ETIQUETA[v]);
      score = 0.58;
    }
    // Tres iguales
    else if (mayor && mayor[1] === 3) {
      rank = 'trips';
      const resto = valores.filter((v) => v !== mayor[0]).slice(0, 2);
      cartas = [ETIQUETA[mayor[0]], ...resto.map((v) => ETIQUETA[v])];
      score = 0.44;
    }
    // Dos parejas
    else if (mayor && sgundo && mayor[1] === 2 && sgundo[1] === 2) {
      rank = 'two-pair';
      const kicker = valores.find((v) => v !== mayor[0] && v !== sgundo[0]);
      cartas = [ETIQUETA[mayor[0]], ETIQUETA[sgundo[0]], ETIQUETA[kicker ?? 0]];
      score = 0.3;
    }
    // Una pareja
    else if (mayor && mayor[1] === 2) {
      rank = 'pair';
      const resto = valores.filter((v) => v !== mayor[0]).slice(0, 3);
      cartas = [ETIQUETA[mayor[0]], ...resto.map((v) => ETIQUETA[v])];
      score = 0.16;
    }
    // Carta alta
    else {
      rank = 'high-card';
      cartas = valores.slice(0, 5).map((v) => ETIQUETA[v]);
      score = 0.04;
    }
  }

  return { rank, name: NOMBRES[rank], cards: cartas.join(' '), score };
}