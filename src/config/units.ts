/**
 * Unidades internas de saldo.
 *
 * ------------------------------------------------------------------
 * EL PROBLEMA
 *
 * El motor de poker trabaja con fichas ENTERAS en todas partes: `Math.floor`
 * del rake, reparto del bote, comparaciones de stacks, blinds. Eso es correcto
 * y no hay que tocarlo: la aritmetica entera es la que evita que aparezcan
 * decimales fantasma del tipo 0,30000000000000004 en los botes.
 *
 * Pero con la cuenta en USDT y un buy-in de 1 USDT para el campo micro, la ciega
 * grande es de 0,02 USDT. Si las fichas fueran USDT, el motor no podria
 * representarla y el `Math.max(1, ...)` de las ciegas la convertiria en 1 USDT
 * entera: el jugador se quedaria all-in antes de la primera accion.
 *
 * ------------------------------------------------------------------
 * LA SOLUCION
 *
 * Las fichas se guardan en UNIDADES ENTERAS de 1/1000 de USDT. Internamente
 * todo sigue siendo entero; solo se convierte al mostrar.
 *
 *   1 USDT    = 1000 unidades
 *   0,02 USDT =   20 unidades  (una ciega grande del campo micro)
 *   0,002 USDT=    2 unidades  (la ciega pequena de ese mismo campo)
 *
 * Con 1000 unidades por USDT, el campo micro con buy-in de 1 USDT tiene 1000
 * unidades, y la ciega grande son 20: un stack de 50 BB, exactamente igual que
 * en un poker normal.
 *
 * ------------------------------------------------------------------
 * DONDE SE CONVIERTE
 *
 * SOLO en dos sitios, y en la frontera:
 *
 *   - Al entrar: el buy-in en USDT se convierte a unidades (redondeando ABAJO,
 *     para que el operador nunca regale una fraccion).
 *   - Al mostrar: las unidades se dividen por 1000 para pintar USDT.
 *
 * Dentro de la mesa, del campo y del motor, todo son unidades. Si alguna vez
 * aparece un `toFixed` sobre `seat.chips` dentro de la logica de juego, es un
 * bug: la conversion no va ahi.
 */

/** Unidades internas por 1 USDT. */
export const UNITS_PER_USDT = 1000;

/** Cuantas decimales se muestran en la UI. */
export const DISPLAY_DECIMALS = 3;

/**
 * USDT -> unidades internas. Redondea hacia ABAJO.
 *
 * Hacia abajo a proposito: si un jugador tiene 1,0009 USDT, solo puede gastar
 * 1,000 USDT. Si redondeara hacia arriba, el operador regalaria una fraccion en
 * cada conversion, y multiplicado por el numero de buy-ins al dia son fugas
 * pequenas pero constantes.
 */
export const usdtToUnits = (usdt: number): number =>
  Math.floor(usdt * UNITS_PER_USDT);

/**
 * Unidades internas -> USDT. Es exacto para cualquier multiplo de 1/1000,
 * que es lo unico que puede haber dentro del sistema.
 */
export const unitsToUsdt = (units: number): number => units / UNITS_PER_USDT;

/**
 * Formatea unidades para la UI.
 *
 * Redondea hacia ARRIBA en las fracciones: si al jugador le quedan 0,0004 USDT,
 * mostrar "0" le haria pensar que no tiene nada, cuando en realidad le queda
 * una fraccion que ya no puede gastar. Es informacion honesta y evita el
 * "¿donde esta mi dinero?".
 */
export const formatUnits = (units: number): string => {
  const usdt = unitsToUsdt(units);

  if (usdt === 0) return '0';
  if (Number.isInteger(usdt)) return String(usdt);

  // Tres decimales es el maximo representable. Redondeo hacia arriba para que
  // una fraccion no se muestre como cero.
  const rounded = Math.ceil(usdt * UNITS_PER_USDT) / UNITS_PER_USDT;
  const [int, frac] = rounded.toFixed(DISPLAY_DECIMALS).split('.');
  return `${int},${frac.replace(/0+$/, '')}`;
};

/**
 * Cuanto cuesta una ciega en unidades, a partir del stack en USDT.
 *
 * Devuelve las dos ciegas ya redondeadas a unidades, con la grande siendo
 * exactamente el doble de la pequena. Un par de ciegas que no cuadra entre si
 * (por ejemplo 20 y 21) hace que el motor tenga que tratar el caso raro del
 * "extra small blind", que no esta implementado.
 */
export const blindsFor = (stackUsdt: number): { small: number; big: number } => {
  // 1/100 del stack: un stack de 1 USDT da ciegas de 0,01/0,02, y uno de
  // 100 USDT de 1/2. Equivale a 50 BB, que es un stack profundo normal.
  const small = Math.max(1, usdtToUnits(stackUsdt / 200));
  const big = Math.max(2, small * 2);
  return { small, big };
};

/** Stack en ciegas grandes, para la interfaz. */
export const stackInBigBlinds = (units: number, bigBlindUnits: number): number =>
  bigBlindUnits > 0 ? Math.round((units / bigBlindUnits) * 10) / 10 : 0;
