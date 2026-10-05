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

    await Field.updateOne(
      { _id: field._id },
      { $inc: { waiting: 1, buyInsCollected: buyIn } },
    );

    const queue = queues.get(field.fieldId) ?? [];
    queue.push({ telegramId, username });
    queues.set(field.fieldId, queue);

    const seated = await this.trySeat(field);

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

    return Field.create({
      fieldId,
      kind: 'centroll',
      status: 'filling',
      buyIn,
      targetField: CENTROLL.targetField,
      waiting: 0,
      seated: 0,
      playersRemaining: 0,
      paidPositionsLeft: FREEROLL_PAYOUT.length,
      plannedTables: Math.ceil(CENTROLL.targetField / SEATS_PER_TABLE),
      tables: [],
      // Los centrolls tienen buy-in real: no hay `prizeTier`.
    });
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

    return Table.create({
      tableId: `centroll-${field.fieldId}-t${tableNumber}`,
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
    });
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

  /** Devuelve el buy-in si el centroll no llego a arrancar. */
  async refundIfNotStarted(telegramId: number): Promise<number> {
    const field = await Field.findOne({
      kind: 'centroll',
      status: 'filling',
    });
    if (!field) return 0;

    const queue = queues.get(field.fieldId) ?? [];
    const idx = queue.findIndex(p => p.telegramId === telegramId);
    if (idx === -1) return 0;

    queue.splice(idx, 1);
    queues.set(field.fieldId, queue);

    const buyIn = usdtToUnits(CENTROLL.buyInUsdt);
    await User.updateOne({ telegramId }, { $inc: { 'balance.real': buyIn } });
    await Field.updateOne(
      { _id: field._id },
      { $inc: { waiting: -1, buyInsCollected: -buyIn } },
    );

    return buyIn;
  },
};
