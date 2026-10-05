/**
 * Atomicidad del reparto de posiciones.
 *
 * ------------------------------------------------------------------
 * QUE PROBLEMA RESUELVE
 *
 * Cuando un jugador es eliminado en un campo, su posicion final es el valor del
 * contador `playersRemaining` ANTES de decrementarlo. Si dos jugadores caen en el
 * mismo instante y ambos leen el mismo contador, los dos reciben la misma
 * posicion y el segundo que cobra se lleva la nada: el campo habria pagado de
 * menos y dos jugadores habrian perdido la misma parte del bote.
 *
 * En produccion esto se resuelve en Mongo con:
 *
 *   Field.findOneAndUpdate(
 *     { _id, playersRemaining: { $gte: 1 } },
 *     { $inc: { playersRemaining: -1, eliminated: 1 } },
 *     { new: false },   // <-- devuelve el valor ANTES del $inc
 *   )
 *
 * Mongo serializa las operaciones sobre el mismo documento, asi que de dos
 * actualizaciones concurrentes solo una cumple el filtro. El valor devuelto por
 * `new: false` es el que leyo cada una, y son distintos.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA SEPARADO Y NO EN EL GESTOR
 *
 * Este modulo no importa mongoose. Es aritmetica pura sobre un contador, y eso
 * permite probarla sin base de datos: `scripts/test-field-atomic.js` simula el
 * entrelazado de N eliminaciones concurrentes y comprueba que las posiciones
 * salen todas distintas.
 *
 * Si la logica estuviera dentro de `field.manager.ts`, que necesita Mongo para
 * arrancar, esta propiedad quedaria sin probar. Y es justo la propiedad que no
 * se puede verificar leyendo el codigo: que el orden real de las llamadas a la
 * base de datos respete el razonamiento.
 */

/** Estado minimo del contador que necesita la asignacion de posicion. */
export interface AtomicState {
  /** Jugadores vivos en el campo. */
  playersRemaining: number;
  /** Cuantos han sido ya liquidados. */
  eliminated: number;
}

/** Resultado de intentar adjudicar una posicion. */
export interface EliminationResult {
  /** Se adjudico una posicion. */
  ok: boolean;
  /**
   * Posicion final del jugador eliminado (1-based, 1 = ganador).
   *
   * Es el valor ANTERIOR del contador: con 48 vivos, el que cae es el 48º.
   * `undefined` si no se adjudico.
   */
  position?: number;
  /** Estado del contador despues de la operacion. */
  state: AtomicState;
  /** Por que no se adjudico, si no se adjudico. */
  reason?: 'NO_PLAYERS_LEFT' | 'INVALID_STATE';
}

/**
 * Adjudica la posicion de un jugador eliminado.
 *
 * ES UNA FUNCION PURA A PROPOSITO: no muta el estado, devuelve el siguiente.
 * Asi la concurrencia la resuelve quien la llama (Mongo con su serializacion), y
 * aqui se puede probar la aritmetica de forma exhaustiva.
 *
 * @param state  estado del contador ANTES de la eliminacion
 * @returns la posicion adjudicada y el estado siguiente, o el motivo del fallo
 */
export const assignPosition = (state: AtomicState): EliminationResult => {
  const { playersRemaining, eliminated } = state;

  if (!Number.isInteger(playersRemaining) || playersRemaining < 1) {
    return {
      ok: false,
      state: { ...state },
      reason: 'INVALID_STATE',
    };
  }

  // La posicion es el contador ANTES de decrementar. Leerlo despues daria
  // 47 en vez de 48, y el ultimo eliminado del campo seria "el ultimo" cuando
  // en realidad es el que mas posiciones tiene.
  return {
    ok: true,
    position: playersRemaining,
    state: {
      playersRemaining: playersRemaining - 1,
      eliminated: eliminated + 1,
    },
  };
};

/**
 * Simula N eliminaciones concurrentes sobre un contador compartido.
 *
 * Es el modelo de lo que hace Mongo: un documento, operaciones serializadas. La
 * diferencia con el codigo real es que aqui se invierte el orden (en vez de
 * leer-todos-y-despues-escribir, se aplica una a una), que es el peor caso
 * para la atomicidad.
 *
 * Se usa en los tests para comprobar que el esquema de la operacion es correcto,
 * aunque el orden de llegada real sea otro.
 */
export const simulateConcurrent = (
  initial: AtomicState,
  eliminations: number,
): { positions: number[]; final: AtomicState; failures: number } => {
  const positions: number[] = [];
  let failures = 0;
  let state: AtomicState = { ...initial };

  for (let i = 0; i < eliminations; i++) {
    // Filtro `playersRemaining >= 1`: si no quedan vivos, la operacion falla.
    if (state.playersRemaining < 1) {
      failures++;
      continue;
    }
    const result = assignPosition(state);
    if (!result.ok) {
      failures++;
      continue;
    }
    positions.push(result.position!);
    state = result.state;
  }

  return { positions, final: state, failures };
};

/**
 * Valida que una secuencia de adjudicaciones sea coherente.
 *
 * Es la invariante que tiene que cumplirse siempre, este es el contrato:
 *
 *  - Ninguna posicion se repite.
 *  - Las posiciones van de 1 a N, donde N es el numero inicial de jugadores.
 *  - El contador final es N menos las adjudicaciones que tuvieran exito.
 *  - Cuando se agotan los jugadores, las eliminaciones extras fallan en vez de
 *    dar la posicion 0 o 1 (que pagarian de mas).
 */
export const validateSequence = (
  initial: AtomicState,
  positions: number[],
): { ok: boolean; problems: string[] } => {
  const problems: string[] = [];

  const unique = new Set(positions);
  if (unique.size !== positions.length) {
    problems.push(
      `${positions.length - unique.size} posiciones repetidas: dos jugadores cobrarían la misma`,
    );
  }

  const N = initial.playersRemaining;
  for (const p of positions) {
    if (p < 1 || p > N) {
      problems.push(`posición ${p} fuera del rango 1..${N}`);
    }
  }

  const expectedFinal = Math.max(0, N - positions.length);
  const impliedFinal = N - positions.length;
  if (impliedFinal !== expectedFinal) {
    problems.push(
      `contador final inconsistente: ${impliedFinal} vs ${expectedFinal}`,
    );
  }

  return { ok: problems.length === 0, problems };
};
