import { FIELD_PAYOUT, ECONOMY, RAKE, TABLE_TIER_LIST } from '../config/product';

/**
 * Reparto del bote de un campo.
 *
 * ------------------------------------------------------------------
 * EL MODELO
 *
 * Es un Sit'n'Go clasico: cada jugador mete su buy-in, el rake del 5 % se
 * descuenta de los botes de cada mano, y el 95 % restante se reparte a las
 * primeras posiciones segun `FIELD_PAYOUT` (45/25/15/9/6 %).
 *
 * No hay bolsa, no hay pasivo, no hay tope de gasto. El bote escala solo con
 * cuantos jugadores jueguen de verdad, asi que un campo a medio llenar paga la
 * parte proporcional. El RTP resultante es del 95 %, el estandar de poker.
 *
 * NOTA SOBRE UN ERROR PREVIO: en una iteracion anterior calcule el RTP como
 * `premio / buy-in-recAUDados` y salia un 0,05 %. Era una formula erronea:
 * asume que el jugador recupera solo el premio, cuando en un campo recupera su
 * buy-in en fichas menos el rake. La formula correcta es
 * `1 - rake + premio / (field x buyIn)`, que da ~95 % con estos numeros.
 *
 * ------------------------------------------------------------------
 * LO QUE NO HACE ESTE SERVICIO
 *
 * No mueve dinero. Solo calcula. Quien abona el saldo es
 * `seatingService.settleFreeroll` / el field manager, y lo hacen con
 * `balance.play` porque el premio no es retirable (ver ECONOMY.prizeToBalance).
 */

export interface PayoutEntry {
  /** Posicion final en el campo, 1-based. 1 = ganador. */
  position: number;
  /** Importe en CUP. Siempre > 0. */
  amount: number;
  /** Porcentaje del bote que representa. */
  percentage: number;
}

export interface FieldPayout {
  /** Bote bruto del campo (suma de buy-ins). */
  grossPot: number;
  /** Rake estimado sobre ese bote. */
  rake: number;
  /** Bote neto a repartir. */
  netPot: number;
  /** Reparto por posicion, ya redondeado y cuadrando con `netPot`. */
  entries: PayoutEntry[];
  /** Suma de `entries.amount`. Siempre igual a `netPot`. */
  totalPaid: number;
}

/**
 * Reparte un importe por porcentajes, sin perder ni inventar una unidad.
 *
 * ------------------------------------------------------------------
 * POR QUE NO BASTA CON `Math.floor` POR PORCENTAJE
 *
 * `Math.floor(50 * 45/100) = 22`, y los cinco tramos de un bote de 50
 * descuadran en 2 CUP. Con botes de 500 CUP los descuadres son de decenas de
 * CUP, y al final del campo hay alguien a quien no le cuadra la cuenta.
 *
 * Y el error grave es el contrario: repartir "floor mas un resto a partes
 * iguales" puede dar MAS de lo que hay. Con un bote de 3 CUP y cinco
 * posiciones, repartiria 4 CUP: dinero creado de la nada.
 *
 * SOLUCION: recorrido con acumulador del resto y ajuste exacto del ultimo
 * tramo. La suma cuadra por construccion, no por suerte.
 *
 * Con [45, 25, 15, 9, 6]:
 *   total 50  -> 22, 13,  7,  5,  3 = 50 exacto
 *   total 500 -> 225, 125, 75, 45, 30 = 500 exacto
 *   total 3   ->  1,  1,  0,  0,  1 =  3 exacto
 */
export const splitPrize = (
  total: number,
  percentages: readonly number[],
): number[] => {
  if (total <= 0 || percentages.length === 0) return [];

  const whole = Math.floor(total);
  if (whole === 0) return percentages.map(() => 0);

  // Se acumula el resto de la division de cada tramo para no perderlo.
  let running = 0;
  const exact = percentages.map(p => {
    const target = (whole * p) / 100 + running;
    const floored = Math.floor(target);
    running = target - floored;
    return floored;
  });

  // El ultimo tramo absorbe lo que falte, para que la suma sea identica a
  // `total` aunque los porcentajes no sumen 100.
  const beforeLast = exact.slice(0, -1).reduce((a, b) => a + b, 0);
  exact[exact.length - 1] = whole - beforeLast;

  return exact;
};

/**
 * Rake de UN BOTE DE MANO, con el tope por mano.
 *
 * `Math.floor` y no un porcentaje exacto: las fichas son enteras. Por debajo de
 * 20 CUP de bote el rake se trunca a 0, lo cual solo importa con buy-ins
 * miserables (con buy-in de 1 CUP, el rake seria siempre 0).
 *
 * IMPORTANTE: el tope de `RAKE.cashMax` es POR MANO, no por campo. No se puede
 * aplicar aqui a un bote de campo entero, porque un campo no es una mano: son
 * cientos de manos. Usar `rakeOf(1 000 000)` dariia 100 CUP, cuando el rake
 * real de un campo de 500 con buy-in de 2000 es 50 000.
 * Para el rake de un campo usa `fieldPayout`, que aplica el porcentaje sin tope.
 */
export const rakeOf = (pot: number): number => {
  if (pot < RAKE.minPot) return 0;
  return Math.min(Math.floor((pot * RAKE.cashPercentage) / 100), RAKE.cashMax);
};

/**
 * Rake de un CAMPO completo: porcentaje sin tope.
 *
 * El tope de `RAKE.cashMax` aplica a cada mano, y un campo son cientos de
 * manos. Por eso aqui no se topea: un campo de 500 con buy-in de 2000 levanta
 * un rake de 50 000 CUP, no de 100.
 */
export const rakeOfField = (grossPot: number): number => {
  if (grossPot <= 0) return 0;
  return Math.floor((grossPot * RAKE.cashPercentage) / 100);
};

/**
 * Bote y reparto de un campo completo.
 *
 * @param buyIn      buy-in por jugador, en CUP
 * @param players    cuantos jugadores hay realmente en el campo
 * @param percentages  tramos del reparto. Por defecto `FIELD_PAYOUT`.
 */
export const fieldPayout = (
  buyIn: number,
  players: number,
  percentages: readonly number[] = FIELD_PAYOUT,
): FieldPayout => {
  const grossPot = Math.max(0, Math.floor(buyIn * players));
  const rake = rakeOfField(grossPot);
  const netPot = Math.max(0, grossPot - rake);

  const shares = splitPrize(netPot, percentages);

  const entries: PayoutEntry[] = shares
    .map((amount, i) => ({
      position: i + 1,
      amount,
      percentage: percentages[i],
    }))
    .filter(e => e.amount > 0);

  return {
    grossPot,
    rake,
    netPot,
    entries,
    totalPaid: entries.reduce((sum, e) => sum + e.amount, 0),
  };
};

/**
 * RTP teorico de un tier: lo que el campo devuelve dividido por lo que entra.
 *
 * Esto es lo que estaba mal calculado antes. La cuenta correcta es:
 *
 *   RTP = (buyIn - rake% + premio/players) / buyIn
 *
 * O, dicho de otra forma, en un Sit'n'Go el jugador recupera su buy-in en
 * fichas cuando le quedan (se lleva la pila) y el rake se lleva su parte. El
 * RTP lo fija el rake, no el premio.
 */
export const tierRtp = (buyIn: number, players: number): number => {
  if (buyIn <= 0 || players <= 0) return 0;
  return 1 - rakeOfField(buyIn * players) / (buyIn * players);
};

/** RTP de todos los tiers, para el informe. */
export const allTiersRtp = () =>
  TABLE_TIER_LIST.map(t => ({
    id: t.id,
    fieldSize: t.fieldSize,
    buyIn: t.minBuyIn,
    rtp: tierRtp(t.minBuyIn, t.fieldSize),
  }));

/**
 * Texto que la UI debe mostrar junto al premio.
 *
 * "Premio garantizado" sin explicar que es el 95 % del bote y que no es
 * retirable es publicidad engañosa. En Cuba, sin marco legal de juego online,
 * un reclamo por publicidad falsa es el riesgo mas probable del proyecto.
 */
export const prizeDisclosure = (): string => ECONOMY.disclosure;
