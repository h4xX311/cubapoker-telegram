/**
 * Niveles de ciegas de los torneos.
 *
 * Una mesa cash mantiene sus ciegas fijas. Un campo (torneo o freeroll) tiene
 * que subirlas con el reloj o la partida puede durar dias: con
 * 100 ciegas grandes y sin subidas, un campo de 300 jugadores no termina.
 *
 * La escalera es deliberadamente simple y entera. Las ciegas del motor son
 * unidades internas, así que cada nivel se redondea y se garantiza que la
 * ciega grande sea al menos el doble de la pequeña: el motor rechaza una mesa
 * con `bigBlind < smallBlind` y un torneo no puede romperse por un decimal.
 */

export interface BlindLevel {
  /** Nivel actual, empezando en 0. */
  level: number;
  small: number;
  big: number;
  /** Momento en que empezó este nivel. */
  startedAt: Date;
  /** Momento en que entra el siguiente nivel (aunque ya no queden más). */
  nextAt: Date;
}

/** Multiplicadores sobre las ciegas base. El último se mantiene. */
export const BLIND_LEVEL_MULTIPLIERS = [
  1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64,
] as const;

/** Cuánto dura cada nivel. Ocho minutos es habitual en torneos rápidos. */
export const BLIND_LEVEL_DURATION_MS = 8 * 60 * 1000;

/**
 * Calcula las ciegas que corresponden a un instante.
 *
 * No modifica nada: el gestor de mesas es quien decide si las aplica. Se puede
 * probar con fechas fijas y no depende de `Date.now()` salvo que no se pase
 * `now`.
 */
export function blindLevelFor(
  baseSmall: number,
  baseBig: number,
  startedAt: Date | number,
  now: number = Date.now(),
): BlindLevel {
  const inicio = startedAt instanceof Date
    ? startedAt.getTime()
    : Number(startedAt);
  const basePequena = Math.max(1, Math.floor(baseSmall));
  const baseGrande = Math.max(basePequena, Math.floor(baseBig));
  const transcurrido = Math.max(0, now - inicio);
  const nivelBruto = Math.floor(transcurrido / BLIND_LEVEL_DURATION_MS);
  const level = Math.min(nivelBruto, BLIND_LEVEL_MULTIPLIERS.length - 1);
  const multiplicador = BLIND_LEVEL_MULTIPLIERS[level];

  const small = Math.max(1, Math.round(basePequena * multiplicador));
  // La grande conserva la proporción base (normalmente 2x) pero nunca queda por
  // debajo del doble de la pequeña tras el redondeo.
  const big = Math.max(
    small * 2,
    Math.round(baseGrande * multiplicador),
  );

  const inicioNivel = inicio + level * BLIND_LEVEL_DURATION_MS;

  return {
    level,
    small,
    big,
    startedAt: new Date(inicioNivel),
    nextAt: new Date(inicioNivel + BLIND_LEVEL_DURATION_MS),
  };
}

/** Etiqueta corta para la UI: `Nivel 3 · 20/40`. */
export function blindLevelLabel(level: BlindLevel): string {
  return `Nivel ${level.level} · ${level.small}/${level.big}`;
}
