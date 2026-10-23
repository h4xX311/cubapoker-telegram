import { Field, IField, FieldTable } from '../models/Field';
import { Table, ITable, ISeat } from '../models/Table';
import { User } from '../models/User';
import { unlockService } from '../services/unlock.service';
import { splitPrize } from '../services/payout.service';
import {
  CENTROLL,
  UNLOCK_RATES,
  FREEROLL_PAYOUT,
  SEATS_PER_TABLE,
} from '../config/product';
import { usdtToUnits, unitsToUsdt, formatUnits, blindsFor } from '../config/units';
import { logger } from '../utils/logger';
// El mismo cerrojo por nivel que usa `field.manager`. `field.manager` no importa este modulo,
// asi que no hay ciclo. Se comparte para que "dos personas pulsando JUGAR a la vez" se
// serialice igual en un centroll que en un campo de cash.
import { withFieldLock } from './field.manager';

/** Clave del cerrojo. Un centroll es un solo nivel, siempre el mismo. */
const LOCK_CENTROLL = 'centroll';

/**
 * Centrolls: buy-in de 0,01 USDT que consume saldo REAL y paga fichas.
 *
 * ------------------------------------------------------------------
 * QUE RESUELVE
 *
 * El freeroll de CubaPoker era gratis de verdad y sin ninguna via de ingresos:
 * el operador pagaba el premio y no cobraba nada a cambio. CoinPoker tiene esta
 * pieza y es la que hace su freeroll rentable:
 *
 *   "CoinPoker Centrolls: $0.01 Buy-Ins"
 *   "These events require you to have a real money balance of at least $0.01"
 *
 * El bucle es: deposito -> centroll -> fichas de promocion -> centroll o
 * freeroll. El centroll es el punto por el que entra el dinero real, y el
 * freeroll es el que lo devuelve como fichas.
 *
 * ------------------------------------------------------------------
 * POR QUE 1 USDT Y NO 0,01
 *
 * El buy-in de CoinPoker es de un centavo. Aqui son 1000 unidades internas
 * (1 USDT = 1000 unidades, ver `config/units.ts`), que es 1,20 CUP al tipo
 * oficial. Dos razones:
 *
 *  1. ARITMETICA ENTERA. Con buy-in de 0,01 USDT y un field de 100, cada
 *     jugador empezaria con 0,0001 USDT de fichas, que en unidades internas es
 *     0,1: no es un entero. El motor entero no puede repartir eso, y
 *     `Math.floor` lo convertiria en 0 fichas. Un buy-in que no se puede
 *     representar no es un buy-in.
 *
 *  2. ACCESIBILIDAD EN CUBA. 1,20 CUP es pagable con cualquier recarga movil.
 *     Un centavo es mas barato pero con el no se puede jugar de verdad.
 *
 * La consecuencia de que sea 1 USDT y no 0,01 es que el centroll cuesta 100
 * veces mas: es una entrada de verdad, no una jugada de prueba. Para el
 * jugador,proto.
 */

export class CentrollError extends Error {
  constructor(message: string, readonly code: string = 'CENTROLL_ERROR') {
    super(message);
    this.name = 'CentrollError';
  }
}

/** Cola de espera de un centroll en curso. */
const queues = new Map<string, { telegramId: number; username?: string }[]>();

export const centrollService = {
  /**
   * Registra a un jugador en un centroll.
   *
   * A diferencia del freeroll, consume saldo REAL: el buy-in sale de
   * `balance.real` directamente. No pasa por `play` ni por el desbloqueo, porque
   * un centroll es de pago y el jugador ha paid con dinero real.
   *
   * El PREMIO, en cambio, va a `balance.play`. Es la misma logica de CoinPoker:
   * en un centroll no se gana dinero, se ganan tickets (aquí, fichas de
   * promocion).
   */
  async register(
    telegramId: number,
    username?: string,
  ): Promise<{ fieldId: string; queued: boolean }> {
    // Todo el registro en serie, por el mismo motivo que en `field.manager.register`: sin
    // esto, dos registros a la vez leen el mismo documento, cada uno suma su buy-in con un
    // `$inc`, y el `save()` de `trySeat` escribe una copia vieja encima. Medido en los campos
    // de cash: 20 jugadores dejaban el bote en 1.000 de 20.000.
    return withFieldLock(LOCK_CENTROLL, () => this.registrarEnCentroll(telegramId, username));
  },

  /** El cuerpo de `register()`, ya dentro del cerrojo. */
  async registrarEnCentroll(
    telegramId: number,
    username?: string,
  ): Promise<{ fieldId: string; queued: boolean }> {
    const user = await User.findOne({ telegramId });
    if (!user) throw new CentrollError('Usuario no encontrado', 'NOT_FOUND');

    const buyIn = usdtToUnits(CENTROLL.buyInUsdt);

    // Solo saldo REAL. Este es el requisito explicito de CoinPoker: "require
    // you to have a real money balance of at least $0.01".
    if (user.balance.real < buyIn) {
      throw new CentrollError(
        `Un centroll necesita ${formatUnits(buyIn)} USDT de saldo real. ` +
        `Tienes ${formatUnits(user.balance.real)}. El saldo de promoción no ` +
        'sirve para entrar.',
        'INSUFFICIENT_REAL_BALANCE',
      );
    }

    // Un jugador no puede estar en dos centrolls a la vez.
    if (await this.isSeated(telegramId)) {
      throw new CentrollError('Ya estás jugando un centroll', 'ALREADY_IN');
    }

    // ------------------------------------------------------------------
    // Y NO PUEDE PAGAR DOS VECES EL MISMO
    //
    // `isSeated` mira solo las mesas. Un jugador que esta EN COLA no tiene asiento, asi que
    // pasaba el filtro y podia pulsar JUGAR otra vez: se le cobraba el buy-in dos veces y
    // se le apuntaba dos veces. El segundo cobro no le daba ninguna ventaja, solo le quitaba
    // el dinero.
    //
    // La lista de `registrations` es la que sabe quien pago, tenga asiento o no.
    // ------------------------------------------------------------------
    const yaApuntado = await Field.findOne({
      kind: 'centroll',
      status: { $in: ['filling', 'running', 'final'] },
      registrations: {
        $elemMatch: { telegramId, status: { $in: ['waiting', 'seated'] } },
      },
    });

    if (yaApuntado) {
      throw new CentrollError(
        'Ya estás apuntado a este centroll. No hace falta pagar otra entrada.',
        'ALREADY_IN',
      );
    }

    const field = await this.openField();

    // --- Cobro ---
    const charged = await User.updateOne(
      { telegramId, 'balance.real': { $gte: buyIn } },
      { $inc: { 'balance.real': -buyIn, 'stats.tablesJoined': 1 } },
    );

    if (charged.modifiedCount === 0) {
      throw new CentrollError(
        'No se pudo cobrar el buy-in',
        'CHARGE_FAILED',
      );
    }

    // ------------------------------------------------------------------
    // EL COBRO Y LA ANOTACION, EN LA MISMA ESCRITURA
    //
    // Antes solo se subia un contador. Si el centroll se cancelaba no habia a quien
    // devolverle el dinero, porque el documento no guardaba ni un `telegramId`. Es el mismo
    // fallo que se encontro en los campos de cash, y aqui estaba igual de roto.
    //
    // Si esta escritura falla, se devuelve el buy-in antes de propagar el error: un jugador
    // no se queda con el dinero cobrado y sin entrada.
    // ------------------------------------------------------------------
    try {
      await Field.updateOne(
        { _id: field._id },
        {
          $inc: { waiting: 1, buyInsCollected: buyIn },
          $push: {
            registrations: {
              telegramId,
              username,
              buyIn,
              status: 'waiting',
              at: new Date(),
            },
          },
        },
      );
    } catch (err) {
      logger.error(
        `Centroll: se cobro a ${telegramId} pero no se pudo anotar. Se le devuelve.`,
      );
      await User.updateOne({ telegramId }, { $inc: { 'balance.real': buyIn } });
      throw err;
    }

    const queue = queues.get(field.fieldId) ?? [];
    queue.push({ telegramId, username });
    queues.set(field.fieldId, queue);

    // ------------------------------------------------------------------
    // SI EL ASIENTO FALLA, EL DINERO VUELVE
    //
    // El cobro va antes del asiento porque el asiento necesita las fichas. Pero en cuanto se
    // ha cobrado, o se sienta o se devuelve. Antes, un fallo aqui dejaba al jugador sin
    // dinero y sin mesa, y el error solo se veia en el log.
    // ------------------------------------------------------------------
    let seated: boolean;
    try {
      seated = await this.trySeat(field);
    } catch (err) {
      logger.error(
        `Centroll: cobro hecho pero el asiento de ${telegramId} fallo ` +
        `(${err instanceof Error ? err.message : String(err)}). Se le devuelve el buy-in.`,
      );

      const cola = queues.get(field.fieldId) ?? [];
      const i = cola.findIndex((p) => p.telegramId === telegramId);
      if (i !== -1) {
        cola.splice(i, 1);
        queues.set(field.fieldId, cola);
      }

      await Field.updateOne(
        { _id: field._id },
        {
          $inc: { waiting: -1, buyInsCollected: -buyIn },
          $pull: { registrations: { telegramId } },
        },
      );

      await User.updateOne({ telegramId }, { $inc: { 'balance.real': buyIn } });
      throw err;
    }

    logger.info(
      `Centroll ${field.fieldId}: jugador ${telegramId} ` +
      `pagó ${formatUnits(buyIn)} USDT (${seated ? 'sentado' : 'en cola'})`,
    );

    return { fieldId: field.fieldId, queued: !seated };
  },

  /** Abre un centroll, o devuelve el que ya esta abierto. */
  async openField(): Promise<IField> {
    const existing = await Field.findOne({
      kind: 'centroll',
      status: { $in: ['filling', 'running', 'final'] },
    });
    if (existing) return existing;

    const fieldId = `centroll-${Date.now().toString(36)}`;
    const buyIn = usdtToUnits(CENTROLL.buyInUsdt);
    // Las fichas iniciales son la parte del premio de cada jugador. Con
    // premio de 30 USDT sobre 100 jugadores, cada uno entra con 0,3 USDT de
    // fichas: suficiente para jugar unas 150 ciegas antes de quedarse corto.
    const { small, big } = blindsFor(unitsToUsdt(buyIn) * 1.5);

    // ------------------------------------------------------------------
    // TRES ARREGLOS QUE HACIAN QUE ESTO NO FUNCIONARA NUNCA
    //
    // 1. `kind: 'centroll'` no estaba en el enum del esquema. Cada `create()` fallaba con
    //    `ValidationError` y el jugador solo veia "no se pudo". La funcion entera estaba
    //    muerta y nada lo decia.
    //
    // 2. El campo se llamaba `buyIn`. El esquema tiene `buyInUnits` y lo exige (`required`),
    //    asi que aunque el enum hubiera estado bien, esto habria fallado igual: mongoose NO
    //    avisa de las claves que sobran en un `create()`. Es exactamente el fallo que ya esta
    //    documentado en `models/Field.ts` y que dejo `openField` sin funcionar el primer dia.
    //
    // 3. `tierId: 'centroll'`. Ademas de identificar el nivel, es lo que hace que el indice
    //    unico `un_campo_vivo_por_nivel` impida abrir DOS centrolls a la vez. Sin el, dos
    //    registros simultaneos abren dos campos y cada uno cobra su parte: el mismo fallo que
    //    dejo 18 campos abiertos en los campos de cash.
    // ------------------------------------------------------------------
    const documento = {
      fieldId,
      kind: 'centroll',
      tierId: LOCK_CENTROLL,
      status: 'filling',
      buyInUnits: buyIn,
      targetField: CENTROLL.targetField,
      waiting: 0,
      seated: 0,
      playersRemaining: 0,
      paidPositionsLeft: FREEROLL_PAYOUT.length,
      plannedTables: Math.ceil(CENTROLL.targetField / SEATS_PER_TABLE),
      tables: [],
      // Los centrolls tienen buy-in real: no hay `prizeTier`.
    };

    // `small` y `big` no se usan en el documento del campo: las ciegas salen de la mesa
    // (`createTable`). Se dejan calculadas arriba por si el campo las necesitara y no se
    // tocan aqui para no cambiar el comportamiento de las mesas.
    void small;
    void big;

    for (let intento = 1; intento <= 3; intento++) {
      try {
        const field = await Field.create(documento);
        logger.info(`Centroll ${fieldId} abierto (buy-in ${formatUnits(buyIn)} USDT).`);
        return field;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;

        // Otro registro lo abrio primero. No es un error: se entra al que hay.
        const ganador = await Field.findOne({
          kind: 'centroll',
          status: { $in: ['filling', 'running', 'final'] },
        });
        if (ganador) return ganador;
      }
    }

    throw new CentrollError(
      'No se pudo abrir el centroll. Intentalo de nuevo en un momento.',
      'OPEN_FAILED',
    );
  },

  /** Sienta a quien este en cola. */
  async trySeat(field: IField): Promise<boolean> {
    if (field.status !== 'filling') return false;

    const queue = queues.get(field.fieldId) ?? [];
    if (queue.length === 0) return false;

    const buyIn = usdtToUnits(CENTROLL.buyInUsdt);

    // Asegurar mesas.
    const wanted = Math.ceil(queue.length / SEATS_PER_TABLE);
    const live = field.tables.filter(t => !t.mergedInto);
    for (let i = live.length; i < wanted; i++) {
      await this.createTable(field, i + 1);
    }
    await field.save();

    const tables = await Table.find({
      'field.fieldId': field.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    let seatedAny = false;

    for (const table of tables) {
      if (table.seats.length >= table.maxSeats) continue;

      const player = queue.shift();
      if (!player) break;

      const seat: ISeat = {
        index: table.seats.length,
        kind: 'human',
        playerId: String(player.telegramId),
        displayName: player.username || `Jugador ${player.telegramId}`,
        chips: buyIn,
        bet: 0,
        totalBet: 0,
        status: 'active',
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
        handsPlayed: 0,
        handsWon: 0,
        netChips: buyIn,
        joinedAt: new Date(),
      };

      table.seats.push(seat);
      await table.save();

      await Field.updateOne(
        { _id: field._id },
        { $inc: { waiting: -1, seated: 1, playersRemaining: 1 } },
      );

      // La entrada pasa a `seated`, para que una cancelacion sepa quien sigue dentro.
      await Field.updateOne(
        { _id: field._id, 'registrations.telegramId': player.telegramId },
        { $set: { 'registrations.$.status': 'seated' } },
      );

      // ------------------------------------------------------------------
      // LA MESA SE ANOTA UNA VEZ, NO UNA POR JUGADOR
      //
      // Antes este `$push` iba junto al `$inc`, asi que cada jugador que se sentaba anadia
      // OTRA entrada de la misma mesa. Con 7 por mesa, `field.tables` acababa con 7 copias
      // de `t1`. Todo lo que cuenta mesas o promedia asientos sobre esa lista queda mal.
      //
      // El filtro `'tables.tableId': { $ne: ... }` hace que solo la primera vez entre.
      // ------------------------------------------------------------------
      await Field.updateOne(
        { _id: field._id, 'tables.tableId': { $ne: table.tableId } },
        {
          $push: {
            tables: {
              tableId: table.tableId,
              seated: 0,
              eliminated: 0,
              createdAt: new Date(),
            } as FieldTable,
          },
        },
      );

      seatedAny = true;
    }

    queues.set(field.fieldId, queue);

    // Arrancar si se lleno el objetivo. `seatedAny` es booleano, asi que se
    // convierte a numero antes de sumar al contador.
    if (queue.length === 0 && field.seated + (seatedAny ? 1 : 0) >= CENTROLL.targetField) {
      await this.startField(field);
    }

    return seatedAny;
  },

  /** Crea una mesa de 7 para el centroll. */
  async createTable(field: IField, tableNumber: number): Promise<ITable> {
    const buyIn = usdtToUnits(CENTROLL.buyInUsdt);
    const { small, big } = blindsFor(unitsToUsdt(buyIn) * 1.5);

    const tableId = `centroll-${field.fieldId}-t${tableNumber}`;

    const documento = {
      tableId,
      kind: 'centroll',
      status: 'waiting',
      smallBlind: small,
      bigBlind: big,
      buyInUnits: buyIn,
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
    };

    // Upsert, no `create`. Con dos jugadores sentandose a la vez, los dos intentan crear la
    // mesa `t1`; uno gana y el otro revienta con `E11000`. Ese era el jugador que pagaba y
    // se quedaba sin mesa (ver `field.manager.createFieldTable`, donde se midio).
    try {
      return (await Table.findOneAndUpdate(
        { tableId },
        { $setOnInsert: documento },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )) as ITable;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      const yaExiste = await Table.findOne({ tableId });
      if (!yaExiste) throw err;
      return yaExiste;
    }
  },

  /** Arranca el centroll. */
  async startField(field: IField): Promise<boolean> {
    const tables = await Table.find({ 'field.fieldId': field.fieldId });
    const playable = tables.filter(
      t => t.seats.filter(s => s.status === 'active' && s.chips > 0).length >= 2,
    );

    if (playable.length === 0) {
      logger.warn(`Centroll ${field.fieldId}: no arranca, ninguna mesa tiene 2 jugadores`);
      return false;
    }

    field.status = 'running';
    field.startedAt = new Date();
    field.playersRemaining = tables.reduce(
      (n, t) => n + t.seats.filter(s => s.status === 'active' && s.chips > 0).length,
      0,
    );
    await field.save();

    for (const t of tables) {
      t.status = 'running';
      t.field!.fieldStatus = 'running';
      await t.save();
    }

    logger.info(`Centroll ${field.fieldId} arrancado con ${field.playersRemaining} jugadores`);
    return true;
  },

  /**
   * Estado del centroll para la API.
   *
   * El premio se calcula con el multiplicador: 30x el buy-in repartido 50/30/20.
   * Con buy-in de 1 USDT, el campo de 100 cobra 100 USDT y paga 30 USDT de
   * fichas. Es un giveaway del 30% con entrada de pago: el operador gana el 70%
   * en rake menos el rake del 5%: de ahi sale el margen.
   */
  async status() {
    const field = await Field.findOne({
      kind: 'centroll',
      status: { $in: ['filling', 'running', 'final'] },
    });

    if (!field) {
      return {
        open: false,
        buyIn: CENTROLL.buyInUsdt,
        buyInCup: Math.ceil(CENTROLL.buyInUsdt * 120),
        prizeMultiplier: CENTROLL.prizeMultiplier,
        targetField: CENTROLL.targetField,
        maxField: CENTROLL.maxField,
        maxRebuys: CENTROLL.maxRebuys,
      };
    }

    const tables = await Table.find({
      'field.fieldId': field.fieldId,
      status: { $in: ['waiting', 'running'] },
    });
    const queue = queues.get(field.fieldId) ?? [];

    // El bote del campo: lo que puso todo el mundo.
    const pot = field.buyInsCollected;
    // El premio: una fraccion del bote, segun el multiplicador.
    const prize = Math.floor(pot * CENTROLL.prizeMultiplier) / 100;
    const shares = splitPrize(prize, FREEROLL_PAYOUT);

    return {
      open: true,
      fieldId: field.fieldId,
      status: field.status,
      buyIn: CENTROLL.buyInUsdt,
      buyInCup: Math.ceil(CENTROLL.buyInUsdt * 120),
      prizeMultiplier: CENTROLL.prizeMultiplier,
      targetField: field.targetField,
      maxField: CENTROLL.maxField,
      maxRebuys: CENTROLL.maxRebuys,
      registered: field.seated + field.waiting,
      queueLength: queue.length,
      playersRemaining: field.playersRemaining,
      // En USDT para la UI.
      potUsdt: unitsToUsdt(pot),
      prizeUsdt: unitsToUsdt(prize),
      payout: shares.map((amount, i) => ({
        position: i + 1,
        percentage: FREEROLL_PAYOUT[i],
        amountUsdt: unitsToUsdt(amount),
      })),
      tables: tables.map(t => ({
        tableId: t.tableId,
        seated: t.seats.filter(s => s.status === 'active' && s.chips > 0).length,
        maxSeats: t.maxSeats,
      })),
      // El premio va a fichas de promocion: no es dinero retirable.
      prizeWithdrawable: false,
      unlockRatio: `1:${Math.round(1 / UNLOCK_RATES.centroll)}`,
    };
  },

  /** Si un jugador esta sentado en un centroll. */
  async isSeated(telegramId: number): Promise<boolean> {
    return (
      (await Table.countDocuments({
        'field.fieldId': { $exists: true },
        kind: 'centroll',
        'seats.playerId': String(telegramId),
        'seats.status': { $ne: 'out' },
      })) > 0
    );
  },

  /**
   * Devuelve el buy-in si el centroll no llego a arrancar.
   *
   * ------------------------------------------------------------------
   * ANTES SE MIRABA LA COLA EN MEMORIA
   *
   *     const queue = queues.get(field.fieldId) ?? [];
   *     const idx = queue.findIndex(p => p.telegramId === telegramId);
   *     if (idx === -1) return 0;
   *
   * La cola vive en un `Map` del proceso. Tras un reinicio esta vacia, asi que un jugador
   * que habia pagado y estaba esperando **no podia recuperar su dinero nunca**: el bot le
   * decia que no estaba apuntado, y el campo no tenia constancia de el.
   *
   * La verdad es `registrations`, que esta en la base.
   *
   * ------------------------------------------------------------------
   * Y NO SE DEVUELVE DOS VECES
   *
   * Se reclama la entrada con un filtro de estado: solo pasa de `waiting`/`seated` a
   * `refunded` una vez. Si se llama dos veces, la segunda no encuentra nada que reclamar y
   * devuelve 0, en vez de pagar otra vez.
   * ------------------------------------------------------------------
   */
  async refundIfNotStarted(telegramId: number): Promise<number> {
    const field = await Field.findOne({
      kind: 'centroll',
      status: 'filling',
    });
    if (!field) return 0;

    const entrada = (field.registrations ?? []).find(
      (r) =>
        r.telegramId === telegramId &&
        (r.status === 'waiting' || r.status === 'seated'),
    );

    if (!entrada) return 0; // No pago, o ya se le devolvio.

    // 1. Se reclama. Si otro proceso la reclamo antes, no se paga.
    const claim = await Field.updateOne(
      { _id: field._id },
      { $set: { 'registrations.$[r].status': 'refunded' } },
      {
        arrayFilters: [
          { 'r.telegramId': telegramId, 'r.status': { $in: ['waiting', 'seated'] } },
        ],
      },
    );

    if (claim.modifiedCount === 0) return 0;

    // 2. Se saca de la cola en memoria, si estaba (puede no estar tras un reinicio).
    const queue = queues.get(field.fieldId) ?? [];
    const idx = queue.findIndex((p) => p.telegramId === telegramId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      queues.set(field.fieldId, queue);
    }

    // 3. Se suelta el asiento si estaba sentado, para no dejar una plaza ocupada por
    //    alguien a quien ya se le devolvio.
    await Table.updateMany(
      {
        'field.fieldId': field.fieldId,
        seats: { $elemMatch: { playerId: String(telegramId), status: { $ne: 'out' } } },
      },
      { $pull: { seats: { playerId: String(telegramId) } } },
    );

    // 4. Contadores. `waiting` o `seated` segun donde estuviera.
    const inc =
      entrada.status === 'waiting'
        ? { waiting: -1, buyInsCollected: -entrada.buyIn }
        : { seated: -1, playersRemaining: -1, buyInsCollected: -entrada.buyIn };

    await Field.updateOne({ _id: field._id }, { $inc: inc });

    // 5. A la cartera.
    await User.updateOne(
      { telegramId },
      { $inc: { 'balance.real': entrada.buyIn } },
    );

    logger.info(
      `Centroll ${field.fieldId}: a ${telegramId} se le devuelve ` +
      `${formatUnits(entrada.buyIn)} USDT porque no arranco.`,
    );

    return entrada.buyIn;
  },
};
