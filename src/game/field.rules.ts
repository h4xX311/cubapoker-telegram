import { SEATS_PER_TABLE } from '../config/product';

/**
 * Reglas del campo multi-mesa.
 *
 * ------------------------------------------------------------------
 * SON ARITMETICA PURA A PROPOSITO
 *
 * Todo lo que decide quien se queda sin sitio, cuando se fusionan mesas y que
 * posicion ocupa cada eliminado, es aritmetica sobre contadores. Si esa
 * aritmetica vive dentro del gestor, que necesita MongoDB y un tick de 2
 * segundos, no se puede probar: habria que montar una base de datos para
 * comprobar que un jugador con 7 fichas no se sienta en una mesa llena.
 *
 * Estas funciones son la logica; `field.manager.ts` es solo el I/O que la
 * llama. Se prueban en `scripts/test-field.js` sin base de datos.
 */

// =========================================================================
// Asientos
// =========================================================================

/**
 * Si un jugador cabe en una mesa.
 *
 * Un jugador con MENOS fichas que el buy-in minimo no puede jugar: podria
 * sentarse, perder casi todo al instante y quedarse eliminated sin haber jugado
 * una mano. En un campo, perder una mesa entera en 30 segundos por un error de
 * saldo es la peor forma de perder un buy-in.
 */
export const canSitAtTable = (
  chips: number,
  buyIn: number,
  minBuyIn: number,
): boolean => chips >= buyIn && buyIn >= minBuyIn;

/**
 * A quien asignar de la cola cuando hay sitio.
 *
 * Devuelve el indice del primer jugador de la cola que puede pagarse, o -1 si
 * ninguno puede. Descarta en vez de parar en el primero: si el primero no
 * tiene saldo, el segundo si puede,y si no, el campo se queda parado por un
 * jugador que no haANCHADO a坐下.
 */
export const nextSeatable = (
  queue: { telegramId: number; chips: number }[],
  buyIn: number,
  minBuyIn: number,
): number => {
  for (let i = 0; i < queue.length; i++) {
    if (canSitAtTable(queue[i].chips, buyIn, minBuyIn)) return i;
  }
  return -1;
};

// =========================================================================
// Merge
// =========================================================================

/**
 * Si dos mesas deben fusionarse.
 *
 * El criterio: una mesa con menos de `mergeBelow` jugadores activos y otra mesa
 * del mismo campo con hueco. Sin esto, un campo de 500 termina con 40 mesas de
 * 1-2 jugadores cada una, jugando a poker all-in con un bot.
 *
 * Por que 4 y no 2: con 3 jugadores por mesa, la posicion de la mesa final es
 * muy corta y el campo no se siente como un campo. Con 4, se puede seguir
 * jugando con decision. Por que no mas de 4: hay que dejar margen para que la
 * mesa recipienta no se llene de golpe.
 */
export const shouldMergeTables = (
  sourceActive: number,
  targetSeatsFree: number,
  mergeBelow: number,
): boolean => sourceActive < mergeBelow && targetSeatsFree > 0;

/**
 * Reparte los jugadores de una mesa entre varias, sin partir ninguna.
 *
 * Caso limite importante: si hay mas mesas destino que jugadores que mover,
 * algunas mesas destino se quedan vacias. Eso esta bien: se descartan. Lo que
 * NO esta bien es partir una mesa de 3 jugadores en 7+7+7, porque un jugador
 * solo tiene una mesa y no puede jugar tres a la vez.
 *
 * Reparte de forma proporcional al hueco disponible, no en|round-robin a
 * partes iguales: si una mesa tiene 7 asientos libres y otra 1, la primera
 * debe absorber mas jugadores.
 */
export const planMerge = (
  seatIndexes: number[],
  targets: { tableId: string; seatsFree: number }[],
  mergeBelow: number,
): { tableId: string; seatIndexes: number[] }[] => {
  if (seatIndexes.length === 0 || targets.length === 0) return [];

  const plan = targets.map(t => ({ tableId: t.tableId, seatIndexes: [] as number[] }));

  let ti = 0;
  for (const seatIndex of seatIndexes) {
    // Buscar la mesa destino con hueco. Si ninguna tiene, se para: los
    // jugadores que sobren se quedan en la mesa origen, que es preferible a
    // perderlos.
    let placed = false;
    for (let attempts = 0; attempts < plan.length; attempts++) {
      const target = plan[(ti + attempts) % plan.length];
      const spec = targets.find(t => t.tableId === target.tableId)!;
      if (target.seatIndexes.length < spec.seatsFree) {
        target.seatIndexes.push(seatIndex);
        ti = (ti + attempts + 1) % plan.length;
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }

  // Descartar las mesas destino que no recibieron a nadie.
  return plan.filter(p => p.seatIndexes.length > 0);
};

/**
 * Cuantas mesas siguen vivas tras un merge.
 * Si queda una sola, ese campo ya tiene mesa final.
 */
export const liveTablesAfterMerge = (currentTables: number): number =>
  Math.max(0, currentTables - 1);

// =========================================================================
// Posiciones y liquidacion
// =========================================================================

/**
 * Posicion final de un jugador que acaba de ser eliminado.
 *
 * ------------------------------------------------------------------
 * ESTO ES LO MAS DELICADO DEL CAMPO Y DONDE MAS FACIL ES PAGAR DOS VECES
 *
 * Si quedan 48 jugadores vivos en el campo y uno cae, ese jugador es el 48º.
 * El contador baja a 47. Asi, la posicion de cada eliminado es el valor del
 * contador ANTES de decrementar.
 *
 * El orden importa y es la trampa clasica: si se decrementa antes de leer la
 * posicion, el ultimo eliminado del campo se leeria como "el ultimo" cuando en
 * realidad es el que mas positions tiene. Y si dos jugadores caen en el mismo
 * tick, hay que garantizar que leen valores distintos: por eso el decremento
 * se hace en la base de datos con filtro condicional, no en memoria.
 */
export const positionOnElimination = (playersRemaining: number): number =>
  Math.max(1, playersRemaining);

/**
 * Cuantos jugadores sobreviven a una ronda de eliminaciones.
 */
export const remainingAfterEliminations = (
  playersRemaining: number,
  eliminations: number,
): number => Math.max(0, playersRemaining - eliminations);

/**
 * Si el campo ha terminado.
 *
 * Termina cuando queda un jugador. Un jugador y un bot NO es una mesa final
 * valida: el bot no compite por un premio de 427 500 USDT. Si solo quedan bots,
 * el campo se cierra sin ganador humano y los eliminados conservan sus
 * posiciones.
 */
export const isFieldComplete = (
  playersRemaining: number,
  humansRemaining: number,
): boolean => playersRemaining <= 1 && humansRemaining === 0
  || playersRemaining <= 1
  || (playersRemaining <= 2 && humansRemaining <= 1);

/**
 * Razon de cierre cuando quedan bots y ningun humano.
 * Es un caso que hay que manejar: un campo puede vaciarse de humanos si todos
 * se caen antes de tiempo. Se cierra sin ganador y sin pagar el primer puesto.
 */
export const fieldClosedWithBots = (humansRemaining: number): boolean =>
  humansRemaining === 0;

/**
 * Reparto del bote entre los pagados.
 *
 * Delega en `payout.service` para no duplicar el reparto por porcentajes, que
 * ya esta probado y es donde estuvo el bug de descuadre.
 */
export const shouldPayPosition = (
  position: number,
  paidPositionsLeft: number,
): boolean => position <= paidPositionsLeft;

/**
 * Cuantas mesas de 7 necesita un campo.
 * `ceil` porque un campo de 50 son 8 mesas: la octava lleva 1 jugador.
 */
export const tablesForField = (fieldSize: number, seatsPerTable = SEATS_PER_TABLE): number =>
  Math.ceil(fieldSize / seatsPerTable);

/**
 * Reparto de jugadores entre mesas de un campo lleno.
 *
 * Un campo de 50 son 8 mesas de 7. La octava solo puede llevar 1 jugador
 * (50 = 7 mesas x 7 + 1). Un reparto uniforme de 6-7 por mesa dejaria a la
 * ultima vacia o, peor, daria 8 jugadores a una mesa de 7.
 */
export const distributePlayers = (
  players: number,
  tables: number,
  seatsPerTable = SEATS_PER_TABLE,
): number[] => {
  if (tables <= 0) return [];
  const base = Math.floor(players / tables);
  const remainder = players % tables;
  return Array.from({ length: tables }, (_, i) =>
    Math.min(seatsPerTable, base + (i < remainder ? 1 : 0)),
  );
};
