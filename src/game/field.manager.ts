import { Field, IField, FieldTable } from '../models/Field';
import { Table, ITable, ISeat } from '../models/Table';
import { User } from '../models/User';
import { fieldPayout, rakeOfField } from '../services/payout.service';
import {
  TABLE_TIERS,
  TABLE_TIER_LIST,
  SEATS_PER_TABLE,
  FIELD_PAYOUT,
  PAID_POSITIONS,
  FREEROLL_TARGET_FIELD,
  getTier,
  type TableTierId,
} from '../config/product';
import {
  shouldMergeTables,
  planMerge,
  remainingAfterEliminations,
  isFieldComplete,
  tablesForField,
  distributePlayers,
  nextSeatable,
} from './field.rules';
import { logger } from '../utils/logger';
import { assignPosition } from './field.atomic';
import { formatUnits, unitsToUsdt } from '../config/units';
import { unlockService } from '../services/unlock.service';

/**
 * Gestor de campos multi-mesa.
 * =============================
 *
 * Un "campo" es un Sit'n'Go repartido en mesas de 7 que se fusionan hasta que
 * queda una mesa final. `table.manager.ts` gestiona UNA mesa (motor, turnos,
 * bots); este servicio gestiona el agregado: cuantos jugadores quedan, que
 * plazas se han pagado, cuando se fusionan mesas y cuando se liquida.
 *
 * ------------------------------------------------------------------
 * EL CAMBIO DE FONDO QUE ESTE SERVICIO REQUIERE
 *
 * Antes, `table.manager.finishHand()` devuelve las fichas de cada humano a su
 * monedero al cerrar CADA mano (`$inc: { 'balance.real': seat.chips }`) y el
 * jugador vuelve a comprar. Eso es una mesa de cash: se entra y se sale
 * cuando uno quiere.
 *
 * En un campo no puede ser asi. El buy-in se cobra UNA vez al registrarse, las
 * fichas quedan bloqueadas en la mesa, y la posicion se decide por orden de
 * eliminacion. Si las fichas volvieran al monedero cada mano, "campo de 500"
 * serian 500 partidas sueltas de una mesa de 7, que no es un campo.
 *
 * Por eso `TournamentMode` apaga ese comportamiento mientras la mesa pertenece
 * a un campo en juego. Las mesas cash sueltas (sin `field.fieldId`) siguen
 * como antes: no hay que romper el modo actual mientras se construye esto.
 *
 * ------------------------------------------------------------------
 * CONCURRENCIA
 *
 * El contador `playersRemaining` decide la posicion de cada eliminado. Si dos
 * eliminaciones ocurren a la vez y ambas leen el mismo valor, dos jugadores
 * cobran la misma posicion. Por eso el decremento se hace con
 * `findOneAndUpdate` y filtro `playersRemaining >= 1`: Mongo garantiza que
 * solo una operacion cumple el filtro a la vez, y devuelve el valor que cada
 * una leyo. Ese valor devuelto es la posicion.
 */

/** Un jugador esperando sitio en el campo. */
interface QueuedPlayer {
  telegramId: number;
  chips: number;
  username?: string;
}

export class FieldError extends Error {
  constructor(message: string, readonly code: string = 'FIELD_ERROR') {
    super(message);
    this.name = 'FieldError';
  }
}

/** Cola de espera en memoria de un campo. */
const queues = new Map<string, QueuedPlayer[]>();

/**
 * Marca de apagado. La pone `tableManager.shutdownEngine()`.
 *
 * Es una variable de modulo y no un metodo porque el gestor de campos es un objeto
 * literal, no una clase: anadirle un metodo obliga a tocar el tipo. Ademas la
 * necesita `table.manager`, que ya importa el campo.
 *
 * Que sea una variable compartida es correcto aqui: solo la escribe el apagado, que
 * ocurre una vez en la vida del proceso, y la leen los ticks. No hay condicion de
 * carrera que importe: si un tick se salta, el siguiente lo cogera tras el
 * reinicio.
 */
let isShuttingDown = false;

/** Lo pone el apagado ordenado. A partir de aqui los ticks no hacen nada. */
export const markShuttingDown = (): void => {
  isShuttingDown = true;
};

/**
 * Apagado del gestor de campos.
 *
 * No liquida ni pausa nada, y esa es la decision importante. Un campo a medias se
 * deja como esta: las mesas de campo ya estan en `paused` (ver
 * `TableManager.refundTable`) y `/api/admin/paused-tables` las lista para que el
 * operador decida.
 *
 * La razon para no automatizarlo es que una liquidacion a medias es peor que no
 * liquidar. Un campo que se cierra con las escrituras cortadas deja jugadores sin
 * posicion adjudicada y un bote sin pagar, y eso no lo arregla un reinicio: exige
 * intervencion manual con los numeros delante. Pausar y que una persona mire es
 * mas lento pero reversible.
 */
export const shutdownFieldManager = async (): Promise<void> => {
  markShuttingDown();

  const active = await Field.countDocuments({
    status: { $in: ['filling', 'running', 'final'] },
  });
  const paused = await Field.countDocuments({ status: 'paused' });

  if (active > 0 || paused > 0) {
    logger.warn(
      `Apagando con ${active} campo(s) sin terminar. Sus mesas quedan pausadas ` +
      'y el dinero sigue bloqueado: hay que decidir si se continua o se cancela ' +
      'con devolucion (ver /api/admin/paused-tables).',
    );
  }
};

export const fieldManager = {
  // ======================================================================
  // Apertura e inscripcion
  // ======================================================================

  /**
   * Abre un campo nuevo, o devuelve el que ya esta abierto para ese tier.
   *
   * Un campo por tier a la vez. Con dos campos del mismo tier abiertos a la
   * vez, un jugador podria estar en los dos cobrando dos premios con el mismo
   * buy-in.
   */
  async openField(tierId: TableTierId): Promise<IField> {
    const tier = getTier(tierId);
    if (!tier) throw new FieldError('Tier desconocido', 'UNKNOWN_TIER');

    const existing = await Field.findOne({
      tierId,
      status: { $in: ['filling', 'running', 'final'] },
    });
    if (existing) return existing;

    const fieldId = `cash-${tierId}-${Date.now().toString(36)}`;

    const field = await Field.create({
      fieldId,
      kind: 'cash',
      tierId,
      status: 'filling',
      buyInUnits: tier.buyInUnits,
      targetField: tier.fieldSize,
      waiting: 0,
      seated: 0,
      playersRemaining: 0,
      paidPositionsLeft: PAID_POSITIONS,
      plannedTables: tablesForField(tier.fieldSize),
      tables: [],
    });

    logger.info(
      `Campo ${fieldId} abierto: ${tier.fieldSize} participantes, ` +
      `bote bruto ${formatUnits(tier.buyInUnits * tier.fieldSize)} USDT, ` +
      `${field.plannedTables} mesas de ${SEATS_PER_TABLE}`,
    );

    return field;
  },

  /**
   * Registra a un jugador en el campo: le cobra el buy-in y lo mete en cola.
   *
   * COBRO. El buy-in se descuenta aqui y solo aqui. Al final, lo que no se
   * quedo el rake vuelve a `balance.real`. Si tambien lo cobrara el gestor de
   * mesas al sentar, seria un doble cobro.
   *
   * El consumo es `play` primero (ver BALANCE.playFirstOnCashTables), igual
   * que en las mesas cash.
   */
  async register(
    telegramId: number,
    tierId: TableTierId,
    username?: string,
  ): Promise<{ fieldId: string; position: number; seated: boolean }> {
    const field = await this.openField(tierId);
    const tier = getTier(tierId)!;

    if (field.status !== 'filling') {
      throw new FieldError(
        'Ese campo ya empezo. Entra en el siguiente.',
        'FIELD_STARTED',
      );
    }

    // Un jugador no puede estar en dos campos a la vez.
    const busy = await Field.findOne({
      status: { $in: ['filling', 'running', 'final'] },
      'tables.tableId': { $exists: true },
    });
    if (busy) {
      const seatedElsewhere = await this.isSeated(telegramId);
      if (seatedElsewhere) {
        throw new FieldError('Ya estas jugando en un campo', 'ALREADY_IN_FIELD');
      }
    }

    if (!this.canAfford(telegramId, tier.buyInUnits)) {
      throw new FieldError(
        `No tienes saldo para un buy-in de ${tier.buyInUsdt} USDT.`,
        'INSUFFICIENT_FUNDS',
      );
    }

    // --- Cobro del buy-in, una sola vez ---
    const charged = await this.chargeBuyIn(telegramId, tier.buyInUnits);
    if (!charged) {
      throw new FieldError(
        'No se pudo cobrar el buy-in. Intentalo de nuevo.',
        'CHARGE_FAILED',
      );
    }

    await Field.updateOne(
      { _id: field._id },
      { $inc: { waiting: 1, buyInsCollected: tier.buyInUnits } },
    );
    field.waiting += 1;
    field.buyInsCollected += tier.buyInUnits;

    const queue = queues.get(field.fieldId) ?? [];
    queue.push({ telegramId, chips: tier.buyInUnits, username });
    queues.set(field.fieldId, queue);

    const position = queue.length;
    const seated = await this.trySeat(field);

    logger.info(
      `Jugador ${telegramId} registrado en ${field.fieldId} ` +
      `(cola #${position}, ${seated ? 'sentado' : 'en espera'})`,
    );

    return { fieldId: field.fieldId, position, seated };
  },

  /** Sale del campo y le devuelve el buy-in. Solo antes de empezar. */
  async unregister(telegramId: number, fieldId: string): Promise<{ refunded: number }> {
    const field = await Field.findOne({ fieldId });
    if (!field) throw new FieldError('Campo no encontrado', 'NOT_FOUND');

    if (field.status !== 'filling') {
      throw new FieldError(
        'El campo ya empezo: no se puede salir hasta que termine.',
        'FIELD_STARTED',
      );
    }

    const queue = queues.get(fieldId) ?? [];
    const idx = queue.findIndex(p => p.telegramId === telegramId);
    if (idx === -1) {
      throw new FieldError('No estas en la cola de este campo', 'NOT_IN_QUEUE');
    }

    queue.splice(idx, 1);
    queues.set(fieldId, queue);

    // Lo que no llego a sentarse esta integro: se devuelve entero.
    await this.refund(telegramId, field.buyIn);
    await Field.updateOne(
      { _id: field._id },
      { $inc: { waiting: -1, buyInsCollected: -field.buyIn } },
    );

    return { refunded: field.buyIn };
  },

  // ======================================================================
  // Asignacion de asientos
  // ======================================================================

  /**
   * Intenta sentar a quien este en cola.
   *
   * Crea mesas segun hagan falta y reparte la cola. Se llama al registrar y en
   * cada tick, porque un jugador que no tenia saldo puede recargarlo y volver
   * a entrar en cola sin volver a registrarse.
   */
  async trySeat(field: IField): Promise<boolean> {
    if (field.status !== 'filling') return false;

    const tier = getTier(field.tierId as TableTierId);
    if (!tier) return false;

    const queue = queues.get(field.fieldId) ?? [];
    let seatedAny = false;

    // --- Asegurar mesas suficientes ---
    const wantedTables = tablesForField(Math.max(queue.length, 2));
    const liveTables = field.tables.filter(t => !t.mergedInto);

    if (liveTables.length < wantedTables) {
      for (let i = liveTables.length; i < wantedTables; i++) {
        await this.createFieldTable(field, i + 1);
        seatedAny = true;
      }
      await field.save();
    }

    // --- Repartir la cola ---
    const tables = await Table.find({
      'field.fieldId': field.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    for (const table of tables) {
      const queueIdx = nextSeatable(
        queue,
        field.buyIn,
        table.buyInUnits,
      );
      if (queueIdx === -1) break;

      const player = queue[queueIdx];

      // Verificar que el jugador no este ya en otra mesa del campo.
      if (await this.isSeated(player.telegramId, field.fieldId)) {
        queue.splice(queueIdx, 1);
        continue;
      }

      const seat = this.buildSeat(table, player.telegramId, player.chips, player.username);
      table.seats.push(seat);
      await table.save();

      await Field.updateOne(
        { _id: field._id },
        {
          $inc: { waiting: -1, seated: 1, playersRemaining: 1 },
          $push: {
            tables: {
              tableId: table.tableId,
              seated: 1,
              eliminated: 0,
              createdAt: new Date(),
            } as FieldTable,
          },
        },
      );

      // El `$push` anterior duplica la entrada de la mesa en cada asiento. Se
      // deja una sola por mesa: el contador `seated` de la tabla es el que
      // dice cuantos hay, no el numero de entradas.
      await this.dedupeFieldTables(field._id.toString(), table.tableId);

      queue.splice(queueIdx, 1);
      queues.set(field.fieldId, queue);
      seatedAny = true;
    }

    // --- Arrancar si se lleno ---
    if (queue.length === 0 && this.countSeated(field) >= field.targetField) {
      await this.startField(field);
    }

    return seatedAny;
  },

  /** Crea una mesa de 7 que pertenece al campo. */
  async createFieldTable(field: IField, tableNumber: number): Promise<ITable> {
    const tier = getTier(field.tierId as TableTierId)!;
    const tableId = `field-${field.fieldId}-t${tableNumber}`;

    return Table.create({
      tableId,
      kind: 'cash',
      tierId: field.tierId,
      status: 'waiting',
      // Las ciegas salen del tier ya calculadas en unidades internas. No se
      // derivan aqui con `Math.round(buyIn / 100)`: el redondeo puede dar dos
      // valores distintos para el mismo tier segun cuando se cree la mesa, y el
      // jugador lo notaria al pasar de una mesa a otra del mismo campo.
      smallBlind: tier.blinds.small,
      bigBlind: tier.blinds.big,
      buyInUnits: field.buyIn,
      maxSeats: SEATS_PER_TABLE,
      seats: [],
      field: {
        fieldId: field.fieldId,
        tableNumber,
        targetField: field.targetField,
        registered: field.seated + field.waiting,
        seated: 0,
        fieldStatus: 'filling',
      },
      hand: {
        handNumber: 0,
        phase: 'idle',
        communityCards: [],
        pot: 0,
        currentBet: 0,
        actingSeat: -1,
        dealerSeat: 0,
      },
    });
  },

  /** Construye el asiento de un humano. */
  buildSeat(
    table: ITable,
    telegramId: number,
    chips: number,
    username?: string,
  ): ISeat {
    return {
      index: table.seats.length,
      kind: 'human',
      playerId: String(telegramId),
      displayName: username || `Jugador ${telegramId}`,
      chips,
      bet: 0,
      totalBet: 0,
      status: 'active',
      lastAction: undefined,
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      handsPlayed: 0,
      handsWon: 0,
      netChips: 0,
      joinedAt: new Date(),
    };
  },

  /** Deja una sola entrada por mesa en `field.tables`. */
  async dedupeFieldTables(fieldId: string, tableId: string): Promise<void> {
    const field = await Field.findOne({ fieldId });
    if (!field) return;

    const byTable = new Map<string, FieldTable>();
    for (const t of field.tables) {
      const prev = byTable.get(t.tableId);
      if (!prev) {
        byTable.set(t.tableId, t);
      } else {
        prev.seated += t.seated;
        prev.eliminated += t.eliminated;
      }
    }
    field.tables = Array.from(byTable.values());
    await field.save();
  },

  // ======================================================================
  // Arranque
  // ======================================================================

  /**
   * Arranca el campo: pasa las mesas a `running` y deja de aceptar gente.
   *
   * Solo arranca si hay al menos una mesa con 2 jugadores. Un campo que "arranca"
   * con mesas de 1 no es un campo, y arrancarlo igualmente deja jugadores
   * esperando a un rival que no llega nunca.
   */
  async startField(field: IField): Promise<boolean> {
    const tables = await Table.find({
      'field.fieldId': field.fieldId,
    });

    const playable = tables.filter(
      t => t.seats.filter(s => s.status === 'active' && s.chips > 0).length >= 2,
    );

    if (playable.length === 0) {
      logger.warn(
        `Campo ${field.fieldId}: no arranca, ninguna mesa tiene 2 jugadores activos.`,
      );
      return false;
    }

    field.status = 'running';
    field.startedAt = new Date();
    // El contador arranca en los jugadores reales sentados, no en el objetivo.
    // El campo puede llenarse por encima o por debajo del targetField.
    field.playersRemaining = tables.reduce(
      (n, t) => n + t.seats.filter(s => s.status === 'active' && s.chips > 0).length,
      0,
    );
    await field.save();

    for (const t of tables) {
      t.status = 'running';
      t.field!.fieldStatus = 'running';
      t.field!.registered = field.seated + field.waiting;
      await t.save();
    }

    // Las mesas que no llegaron a 2 jugadores se vacian con reembolso.
    for (const t of tables) {
      const active = t.seats.filter(s => s.status === 'active' && s.chips > 0).length;
      if (active < 2) {
        await this.refundTable(t);
      }
    }

    logger.info(
      `Campo ${field.fieldId} arrancado: ${field.playersRemaining} jugadores, ` +
      `${playable.length} mesas en juego`,
    );

    return true;
  },

  // ======================================================================
  // Tick: eliminaciones, merges y cierre
  // ======================================================================

  /**
   * Ciclo de los campos activos.
   *
   * El orden importa:
   *  1. Se atienden las eliminaciones (para actualizar `playersRemaining`).
   *  2. Se fusionan las mesas que se han quedado cortas.
   *  3. Se comprueba si queda una sola mesa (mesa final) o un jugador (fin).
   *
   * Al reves, se fusionarian mesas que aun tenian jugadores eliminandose y se
   * declararia la mesa final antes de tiempo.
   */
  async tick(): Promise<void> {
    // Durante el apagado ordenado no se hace nada. Sin esta comprobacion, un
    // tick que arrancara mientras `shutdownEngine` esta esperando escribiria
    // adjudicaciones de posicion a medias, que es justo lo que el apagado evita.
    if (isShuttingDown) {
      logger.debug('tick del campo omitido: el motor esta apagandose.');
      return;
    }

    const fields = await Field.find({
      status: { $in: ['filling', 'running', 'final'] },
    });

    for (const field of fields) {
      try {
        // Campos llenandose:Repasar la cola, por si alguien ya puede pagar.
        if (field.status === 'filling') {
          await this.trySeat(field);
          await this.checkFieldStart(field);
          continue;
        }

        await this.collectEliminations(field);
        await this.checkMerges(field);
        await this.checkCompletion(field);
      } catch (error) {
        logger.error(`Error en tick del campo ${field.fieldId}:`, error);
      }
    }
  },

  /** Arranca el campo si se lleno, sin esperar al siguiente registro. */
  async checkFieldStart(field: IField): Promise<void> {
    if (this.countSeated(field) >= field.targetField) {
      const queue = queues.get(field.fieldId) ?? [];
      if (queue.length === 0) {
        await this.startField(field);
      }
    }
  },

  /**
   * Recoge los jugadores eliminados de las mesas y les asigna posicion.
   *
   * La posicion se lee del valor que devuelve el `findOneAndUpdate`. Con dos
   * eliminaciones simultaneas, Mongo serializa las operaciones y cada una lee un
   * valor distinto: es la unica forma de garantizar que dos jugadores no
   * cobran la misma posicion.
   */
  async collectEliminations(field: IField): Promise<void> {
    const tables = await Table.find({ 'field.fieldId': field.fieldId });

    for (const table of tables) {
      const busted = table.seats.filter(
        s => s.kind === 'human' && s.status === 'eliminated',
      );
      if (busted.length === 0) continue;

      for (const seat of busted) {
        const telegramId = Number(seat.playerId);

        // Decremento atomico. `new: false` devuelve el documento ANTES del $inc,
        // y ese `playersRemaining` es la posicion del eliminado.
        //
        // El filtro `playersRemaining: { $gte: 1 }` hace dos cosas a la vez:
        // que la operacion falle si no quedan vivos (pagar de mas es peor que
        // pagar de menos), y que Mongo serialice las eliminaciones concurrentes
        // sobre el mismo documento, de modo que dos jugadores que caen en el
        // mismo tick lean valores distintos.
        //
        // La aritmetica de la posicion vive en `field.atomic.ts`, con tests
        // propios. Aqui solo se pide el numero.
        const updated = await Field.findOneAndUpdate(
          { _id: field._id, playersRemaining: { $gte: 1 } },
          { $inc: { playersRemaining: -1, eliminated: 1 } },
          { new: false },
        );

        if (!updated) {
          // El campo ya no tiene jugadores vivos: nada mas que adjudicar.
          logger.warn(
            `Campo ${field.fieldId}: eliminacion sin contador valido ` +
            `(jugador ${telegramId}). Se ignora.`,
          );
          continue;
        }

        const position = assignPosition({
          playersRemaining: updated.playersRemaining,
          eliminated: updated.eliminated,
        }).position;

        if (position === undefined) {
          logger.error(
            `Campo ${field.fieldId}: contador incoherente al eliminar a ` +
            `${telegramId} (playersRemaining=${updated.playersRemaining}). ` +
            'Se salta la adjudicacion.',
          );
          continue;
        }

        // Lo que le quedaba en la mesa vuelve a `balance.real`.
        await this.refund(telegramId, Math.max(0, seat.chips + seat.bet));
        seat.chips = 0;
        seat.bet = 0;

        await this.recordResult(field, {
          position,
          telegramId,
          username: seat.displayName,
          amount: 0,
          tableId: table.tableId,
        });

        logger.info(
          `Campo ${field.fieldId}: jugador ${telegramId} eliminado ` +
          `en la posicion ${position} (mesa ${table.tableId})`,
        );
      }

      // Marcar los eliminados como ya liquidados, para no volver a contarlos.
      for (const seat of busted) {
        const idx = table.seats.findIndex(s => s.index === seat.index);
        if (idx >= 0) table.seats[idx].status = 'out';
      }

      // Registrar en la mesa y en el campo.
      await Field.updateOne(
        { _id: field._id },
        { $inc: { 'tables.$[t].eliminated': busted.length } },
        { arrayFilters: [{ 't.tableId': table.tableId }] },
      );
      await table.save();
    }
  },

  /**
   * Fusiona las mesas que se han quedado cortas con las que tienen hueco.
   *
   * Solo con al menos dos mesas: no se fusiona la ultima, que ya es la final.
   */
  async checkMerges(field: IField): Promise<void> {
    const tables = await Table.find({ 'field.fieldId': field.fieldId });

    const live = tables.filter(t => t.status !== 'finished');
    if (live.length <= 1) return;

    const activeCounts = live.map(t => ({
      table: t,
      active: t.seats.filter(s => s.status === 'active' && s.chips > 0).length,
    }));

    for (const source of activeCounts) {
      if (source.active === 0) {
        await this.closeEmptyTable(source.table);
        continue;
      }

      if (!shouldMergeTables(source.active, 1, MERGE_BELOW)) continue;

      const targets = live
        .filter(t => t.tableId !== source.table.tableId)
        .map(t => ({
          tableId: t.tableId,
          seatsFree: t.maxSeats - t.seats.length,
        }))
        .filter(t => t.seatsFree > 0);

      if (targets.length === 0) continue;

      const movers = source.table.seats.filter(
        s => s.kind === 'human' && s.status === 'active' && s.chips > 0,
      );
      if (movers.length === 0) continue;

      const plan = planMerge(
        movers.map(s => s.index),
        targets,
        MERGE_BELOW,
      );

      for (const move of plan) {
        const target = tables.find(t => t.tableId === move.tableId)!;
        for (const seatIndex of move.seatIndexes) {
          const seat = source.table.seats.find(s => s.index === seatIndex);
          if (!seat) continue;

          // Reindizar: el destino puede tener menos jugadores, y el motor usa
          // el indice de asiento como id del jugador. Un indice duplicado
          // haria que un jugador actuara como si fuera dos.
          const newIndex = target.seats.length;
          source.table.seats = source.table.seats.filter(s => s.index !== seatIndex);
          target.seats.push({ ...seat, index: newIndex });
        }
        await target.save();
      }

      // Si la mesa origen quedo vacia, se retira del campo.
      const remaining = source.table.seats.filter(s => s.status !== 'out').length;
      if (remaining === 0) {
        await this.retireTable(field, source.table);
      } else {
        await source.table.save();
      }

      logger.info(
        `Campo ${field.fieldId}: fusionada la mesa ${source.table.tableId} ` +
        `(${movers.length} jugadores) en ${plan.length} mesa(s) destino`,
      );

      // Solo una fusion por ciclo. Fusionar en cascada en el mismo tick
      // moveria jugadores varias veces y es mas lento sin mejorar el resultado.
      return;
    }
  },

  /** Cierra una mesa sin jugadores activos y reembolsa lo que quede. */
  async closeEmptyTable(table: ITable): Promise<void> {
    for (const seat of table.seats) {
      if (seat.kind !== 'human') continue;
      await this.refund(Number(seat.playerId), Math.max(0, seat.chips + seat.bet));
    }
    table.seats = [];
    table.status = 'finished';
    if (table.field) table.field.fieldStatus = 'finished';
    await table.save();
  },

  /** Retira una mesa del campo sin liquidarla. */
  async retireTable(field: IField, table: ITable): Promise<void> {
    table.status = 'finished';
    if (table.field) table.field.fieldStatus = 'finished';
    await table.save();

    await Field.updateOne(
      { _id: field._id },
      { $set: { 'tables.$[t].mergedInto': table.tableId } },
      { arrayFilters: [{ 't.tableId': table.tableId }] },
    );
  },

  /**
   * Comprueba si el campo termino y, si toca, lo liquida.
   *
   * Tres formas de terminar:
   *  - queda un jugador: gana el campo.
   *  - queda una sola mesa con gente: es la mesa final, se marca como tal y se
   *    sigue jugando hasta que quede uno.
   *  - no quedan humanos: se cierra sin ganador y los eliminados conservan sus
   *    posiciones (no se paga a un bot).
   */
  async checkCompletion(field: IField): Promise<void> {
    const tables = await Table.find({
      'field.fieldId': field.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    const humans = tables.reduce(
      (n, t) =>
        n +
        t.seats.filter(s => s.kind === 'human' && s.status !== 'out').length,
      0,
    );

    // Sin humanos: no hay a quien pagar.
    if (humans === 0) {
      logger.warn(
        `Campo ${field.fieldId}: se cierra sin ganador humano. ` +
        `${field.playersRemaining} jugadores vivos pero ninguno humano.`,
      );
      await this.settleField(field, null);
      return;
    }

    const live = tables.filter(
      t => t.seats.some(s => s.kind === 'human' && s.status !== 'out'),
    );

    // Una sola mesa viva: es la final.
    if (live.length === 1 && field.status !== 'final') {
      field.status = 'final';
      await field.save();
      live[0].field!.fieldStatus = 'final';
      live[0].status = 'running';
      await live[0].save();
      logger.info(`Campo ${field.fieldId}: mesa final en ${live[0].tableId}`);
      return;
    }

    // Queda un jugador: el campo se liquida.
    if (field.playersRemaining <= 1) {
      const winner = live
        .flatMap(t => t.seats)
        .find(s => s.kind === 'human' && s.status !== 'out');

      await this.settleField(field, winner ?? null);
      return;
    }

    // Caso borde: quedan dos jugadores en dos mesas distintas. Ninguno puede
    // ganar solo, asi que hay que reunirlos.
    if (field.playersRemaining <= 2 && live.length > 1) {
      await this.forceMergeIntoOne(field, live);
    }
  },

  /**
   * Junta a los ultimos jugadores en una sola mesa.
   *
   * Sin esto, un campo puede quedar con 2 jugadores en 2 mesas distintas y
   * acabar sin ganador: nadie se sienta con nadie.
   */
  async forceMergeIntoOne(field: IField, tables: ITable[]): Promise<void> {
    const keeper = tables[0];
    const fieldStatus = field.status;
    field.status = 'running'; // para que el merge no se tome por mesa final

    for (const donor of tables.slice(1)) {
      for (const seat of donor.seats) {
        if (seat.kind !== 'human' || seat.status === 'out') continue;
        keeper.seats.push({ ...seat, index: keeper.seats.length });
      }
      donor.seats = [];
      donor.status = 'finished';
      if (donor.field) donor.field.fieldStatus = 'finished';
      await donor.save();
      await this.retireTable(field, donor);
    }

    field.status = fieldStatus;
    await field.save();
    await keeper.save();

    logger.info(
      `Campo ${field.fieldId}: los ultimos jugadores se reunen en ${keeper.tableId}`,
    );
  },

  /**
   * Liquida el campo: paga por posicion y devuelve lo que no se quedo el rake.
   *
   * ------------------------------------------------------------------
   * EL ORDEN DE LAS OPERACIONES IMPORTA
   *
   * Primero se paga el premio, despues se devuelve el resto. Si se devolviera
   * primero y el pago fallara, el operador habria pagado de su bolsillo y el
   * jugador habria recuperado el buy-in entero: doble dinero.
   *
   * Y el pago se hace ANTES de marcar el campo como finished, con filtro
   * `status != finished`. Dos liquidaciones simultaneas (un tick y una peticion
   * manual) solo pueden pasar la filtro una.
   */
  async settleField(field: IField, winner: ISeat | null): Promise<FieldResultOut> {
    const alreadySettled = await Field.findOne({
      fieldId: field.fieldId,
      status: 'finished',
    });
    if (alreadySettled) {
      return { paid: [], totalPaid: 0, refunded: 0 };
    }

    // --- Estimar el bote del campo ---
    // En una mesa se juega con fichas, no con CUP. El bote del campo es lo que
    // puso todo el mundo menos lo que se llevo el rake. Como el gestor de mesas
    // cobra el rake por mano, aqui se reconstruye desde los contadores.
    const tables = await Table.find({ 'field.fieldId': field.fieldId });

    // Cuanto se ha repartido ya entre los eliminados (su cambio de fichas).
    // Se recorre el historial de resultados guardado en el campo.
    const grossPot = field.buyInsCollected;
    const rake = field.rakeCollected;
    const netPot = Math.max(0, grossPot - rake);

    // El premio del campo va a `balance.play` (Promotional Dollars): no se
    // retira directamente, se desbloquea jugando a ratio 1:10.
    //
    // ESTA ES LA REGLA QUE PROTEGE LA PLATAFORMA. Si el premio fuera a
    // `balance.real`, ganar un campo (que requiere buy-in) seria
    // indistinguible de un deposito, y un jugador podria comprar entradas con
    // dinero de promocion y convertirlo a saldo retirable. Con el ratio 1:10,
    // el premio sirve para jugar, no para retirar.
    const paidPositionsLeft = PAID_POSITIONS;

    const fieldPayoutResult = fieldPayout(field.buyIn, field.playersRemaining);
    const shares = fieldPayoutResult.entries;

    const paid: FieldResultOut['paid'] = [];

    // --- Ganador: posicion 1 ---
    if (winner) {
      const telegramId = Number(winner.playerId);
      const share = shares.find(s => s.position === 1)?.amount ?? 0;

      if (share > 0) {
        // El premio va a `balance.play`: no es retirable (ECONOMY.prizeToBalance).
        await User.updateOne(
          { telegramId },
          {
            $inc: {
              'balance.play': share,
              'stats.totalFreerollWon': share,
            },
          },
        );
        paid.push({
          position: 1,
          telegramId,
          username: winner.displayName,
          amount: share,
          tableId: tables.find(t => t.seats.includes(winner))?.tableId,
        });
        logger.info(
          `Campo ${field.fieldId}: ganador ${telegramId} cobra ` +
          `${formatUnits(share)} USDT de promocion`,
        );
      }

      // Devolver lo que le quedaba en la mesa mas su parte del bote no
      // repartido. En un Sit'n'Go el ganador se lleva la pila Y el premio.
      await this.refund(telegramId, Math.max(0, winner.chips + winner.bet));
    }

    // --- Cerrar el campo (atomico) ---
    const closed = await Field.findOneAndUpdate(
      { fieldId: field.fieldId, status: { $ne: 'finished' } },
      {
        $set: { status: 'finished', finishedAt: new Date() },
        $inc: { paidPositionsLeft: -paidPositionsLeft },
      },
      { new: true },
    );

    if (!closed) {
      logger.warn(
        `Campo ${field.fieldId}: ya liquidado por otravia. No se paga dos veces.`,
      );
      return { paid, totalPaid: paid.reduce((s, p) => s + p.amount, 0), refunded: 0 };
    }

    // --- Devolver lo que no llego al bote ---
    // Los jugadores que quedaron fuera antes de empezar (los que estaban en
    // cola cuando el campo arranco) reciben su buy-in intacto.
    const refunded = await this.refundUnseated(field);

    // Registrar el resultado.
    await Field.updateOne(
      { _id: field._id },
      { $set: { results: [...closed.results, ...paid] } },
    );

    // Cerrar las mesas.
    for (const t of tables) {
      if (t.status === 'finished') continue;
      for (const seat of t.seats) {
        if (seat.kind !== 'human' || seat.status === 'out') continue;
        await this.refund(Number(seat.playerId), Math.max(0, seat.chips + seat.bet));
      }
      t.seats = [];
      t.status = 'finished';
      if (t.field) t.field.fieldStatus = 'finished';
      await t.save();
    }

    const totalPaid = paid.reduce((s, p) => s + p.amount, 0);

    logger.info(
      `Campo ${field.fieldId} liquidado: bote ${formatUnits(grossPot)} USDT, ` +
      `rake ${formatUnits(rake)} USDT, premio ${formatUnits(totalPaid)} USDT ` +
      `de promocion, reembolsos ${formatUnits(refunded)} USDT`,
    );

    return { paid, totalPaid, refunded };
  },

  /** Registra un resultado intermedio (eliminados que no cobran). */
  async recordResult(field: IField, result: FieldResultOut['paid'][number]) {
    await Field.updateOne(
      { _id: field._id },
      { $push: { results: result } },
    );
  },

  /** Devuelve el buy-in a quien no llego a sentarse. */
  async refundUnseated(field: IField): Promise<number> {
    const queue = queues.get(field.fieldId) ?? [];
    let total = 0;
    for (const player of queue) {
      await this.refund(player.telegramId, player.chips);
      total += player.chips;
    }
    queues.delete(field.fieldId);
    if (queue.length > 0) {
      await Field.updateOne(
        { _id: field._id },
        { $set: { waiting: 0 }, $inc: { buyInsCollected: -total } },
      );
    }
    return total;
  },

  // ======================================================================
  // Utilidades
  // ======================================================================

  /** Jugadores sentados reales (no el contador, que puede ir atrasado). */
  countSeated(field: IField): number {
    const queue = queues.get(field.fieldId) ?? [];
    return field.seated + queue.length;
  },

  /** Si un jugador esta sentado en algun campo. */
  async isSeated(telegramId: number, fieldId?: string): Promise<boolean> {
    const filter: any = {
      'field.fieldId': { $exists: true },
      'seats.playerId': String(telegramId),
      'seats.status': { $ne: 'out' },
    };
    if (fieldId) filter['field.fieldId'] = fieldId;
    return (await Table.countDocuments(filter)) > 0;
  },

  /** Campo en el que esta sentado un jugador, si esta. */
  async fieldOf(telegramId: number): Promise<{ fieldId: string; tableId: string } | null> {
    const table = await Table.findOne({
      'field.fieldId': { $exists: true },
      'seats.playerId': String(telegramId),
      'seats.status': { $ne: 'out' },
    });
    if (!table?.field?.fieldId) return null;
    return { fieldId: table.field.fieldId, tableId: table.tableId };
  },

  /** Estado del campo para la API. */
  async status(fieldId: string) {
    const field = await Field.findOne({ fieldId });
    if (!field) throw new FieldError('Campo no encontrado', 'NOT_FOUND');

    const tables = await Table.find({ 'field.fieldId': fieldId });
    const queue = queues.get(fieldId) ?? [];

    return {
      fieldId: field.fieldId,
      kind: field.kind,
      tierId: field.tierId,
      status: field.status,
      buyIn: field.buyIn,
      targetField: field.targetField,
      seated: field.seated,
      waiting: field.waiting,
      queueLength: queue.length,
      playersRemaining: field.playersRemaining,
      paidPositionsLeft: field.paidPositionsLeft,
      rakeCollected: field.rakeCollected,
      buyInsCollected: field.buyInsCollected,
      tables: tables
        .filter(t => t.status !== 'finished')
        .map(t => ({
          tableId: t.tableId,
          seated: t.seats.filter(s => s.status === 'active' && s.chips > 0).length,
          maxSeats: t.maxSeats,
          hand: t.hand.handNumber,
          isFinal: t.field?.fieldStatus === 'final',
        })),
      myTable: await this.fieldOfByTable(tables, null),
      startedAt: field.startedAt,
      finishedAt: field.finishedAt,
      results: field.results ?? [],
    };
  },

  async fieldOfByTable(_tables: ITable[], _tg: number) {
    return undefined;
  },

  /**
   * Cobra el buy-in: `play` primero (con su desbloqueo a 1:10), `real` despues.
   *
   * Delega el reparto en `unlockService.splitBuyIn()`, que es el unico sitio
   * donde se toca `balance.play` para una compra. Si aqui se hiciera el reparto a
   * mano, el desbloqueo podria quedar sin aplicar en unos caminos y aplicarse dos
   * veces en otros, y el descuadre seria invisible.
   *
   * Devuelve false si no habia saldo.
   */
  async chargeBuyIn(telegramId: number, amount: number): Promise<boolean> {
    const user = await User.findOne({ telegramId });
    if (!user) return false;

    if (user.balance.real + user.balance.play < amount) return false;

    // Lo que sale de `play` se desbloquea a retirable segun el ratio.
    const split = await unlockService.splitBuyIn(telegramId, amount, 'cash');
    const fromPlay = split.fromPlay;
    const fromReal = amount - fromPlay;

    // `splitBuyIn` ya descontó `fromPlay` de `play` y acreditó el unlock a
    // `real`. Aquí solo se descuenta el resto de `real`: si se descontara
    // tambien `play`, la parte de promoción se cobraría dos veces.
    await User.updateOne(
      { telegramId },
      {
        $inc: {
          'balance.real': -fromReal,
          'stats.tablesJoined': 1,
        },
      },
    );

    unlockService.log(split, 'cash');
    return true;
  },

  /** Devuelve saldo a `balance.real`. */
  async refund(telegramId: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    await User.updateOne(
      { telegramId },
      { $inc: { 'balance.real': amount } },
    );
  },

  canAfford(telegramId: number, amount: number): Promise<boolean> {
    return User.exists({
      telegramId,
      $expr: {
        $gte: [{ $add: ['$balance.real', '$balance.play'] }, amount],
      },
    }).then(Boolean);
  },

  /** Reembolsa una mesa y la deja como estaba antes de empezar. */
  async refundTable(table: ITable): Promise<void> {
    for (const seat of table.seats) {
      if (seat.kind !== 'human') continue;
      await this.refund(Number(seat.playerId), Math.max(0, seat.chips + seat.bet));
    }
    table.seats = [];
    table.status = 'finished';
    if (table.field) table.field.fieldStatus = 'finished';
    await table.save();
  },
};

/**
 * Umbral por debajo del cual una mesa se fusiona.
 *
 * 4 y no 2: con 3 jugadores por mesa la mesa final es demasiado corta y el
 * campo no se siente como un campo. Con 4 se puede seguir jugando con decision.
 */
const MERGE_BELOW = 4;

export interface FieldResultOut {
  paid: Array<{
    position: number;
    telegramId: number;
    username?: string;
    amount: number;
    tableId?: string;
  }>;
  totalPaid: number;
  refunded: number;
}

export const fieldConstants = { MERGE_BELOW };
