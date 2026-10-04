import { Table, ITable, ISeat } from '../models/Table';
import { User } from '../models/User';
import { tableManager } from './table.manager';
import {
  TABLE_TIERS,
  TABLE_TIER_LIST,
  FREEROLL_PRIZES,
  FREEROLL_PAYOUT,
  BOT_CONFIG,
  getTier,
  type TableTierId,
} from '../config/product';
import { logger } from '../utils/logger';

export class TableError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Operaciones de jugador sobre las mesas: sentarse, actuar, retirarse.
 *
 * Complementa a TableManager, que gestiona el ciclo automatico de las manos.
 * Aqui viven las acciones explicitas del usuario.
 */
export class SeatingService {
  // ======================================================================
  // Mesas cash
  // ======================================================================

  /**
   * Sienta a un jugador en una mesa cash.
   *
   * REGLA DE SALDO: se consume primero `balance.play` (saldo de promocion) y
   * despues `balance.real`. Asi el saldo de freeroll se gasta primero y el
   * dinero real se preserva para retirarlo.
   */
  async sitDown(params: {
    telegramId: number;
    tableId?: string;
    tierId?: TableTierId;
    buyIn?: number;
  }): Promise<{ tableId: string; seatIndex: number; chips: number; spentFrom: { play: number; real: number } }> {
    const { telegramId } = params;

    const user = await User.findOne({ telegramId });
    if (!user) throw new TableError('Usuario no encontrado', 404);

    const table = await this.resolveTable(params.tableId, params.tierId);

    // No puede estar en dos mesas a la vez
    const otherSeat = await this.findSeatAnywhere(telegramId, table.tableId);
    if (otherSeat) {
      throw new TableError('Ya estas sentado en otra mesa. Sal de ella primero.', 409);
    }

    const buyIn = Math.max(
      table.minBuyIn,
      Math.min(params.buyIn || table.minBuyIn * 2, user.balance.real + user.balance.play),
    );

    const available = user.balance.real + user.balance.play;
    if (available < table.minBuyIn) {
      throw new TableError(
        `Necesitas ${table.minBuyIn} CUP para esta mesa. Tienes ${available}.`,
      );
    }

    const finalBuyIn = Math.min(buyIn, available);

    // Consumo: play primero, luego real
    const fromPlay = Math.min(user.balance.play, finalBuyIn);
    const fromReal = finalBuyIn - fromPlay;

    const seat: ISeat = {
      index: table.seats.length,
      kind: 'human',
      playerId: String(telegramId),
      displayName: user.firstName || user.username || `Jugador${telegramId}`,
      chips: finalBuyIn,
      bet: 0,
      totalBet: 0,
      status: 'active',
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      handsPlayed: 0,
      handsWon: 0,
      netChips: finalBuyIn,
      joinedAt: new Date(),
    };

    table.seats.push(seat);

    await User.updateOne(
      { telegramId },
      {
        $inc: {
          'balance.play': -fromPlay,
          'balance.real': -fromReal,
          'stats.tablesJoined': 1,
        },
        $set: { activeTableId: table.tableId },
      },
    );

    if (table.seats.filter(s => s.kind === 'human').length === 1) {
      table.status = 'waiting';
    }

    await table.save();

    logger.info(
      `Jugador ${telegramId} se sento en ${table.tableId} (${fromPlay} play + ${fromReal} real)`,
    );

    return {
      tableId: table.tableId,
      seatIndex: seat.index,
      chips: finalBuyIn,
      spentFrom: { play: fromPlay, real: fromReal },
    };
  }

  /** Resuelve la mesa destino: por ID, o creando una del tier pedido. */
  private async resolveTable(tableId?: string, tierId?: TableTierId): Promise<ITable> {
    if (tableId) {
      const table = await Table.findOne({ tableId, status: { $in: ['waiting', 'running'] } });
      if (!table) throw new TableError('Mesa no encontrada', 404);
      if (table.kind !== 'cash') throw new TableError('Esa mesa no es de tipo cash');
      if (table.seats.length >= table.maxSeats) {
        throw new TableError('La mesa esta llena');
      }
      return table as ITable;
    }

    const tier = getTier(tierId || '') || TABLE_TIERS.t50;

    // Buscar una mesa del mismo tier con sitio
    const existing = await Table.findOne({
      kind: 'cash',
      tierId: tier.id,
      status: { $in: ['waiting', 'running'] },
      $expr: { $lt: [{ $size: '$seats' }, '$maxSeats'] },
    });

    if (existing) return existing as ITable;

    // Crear mesa nueva para el tier
    return (await this.createCashTable(tier.id)) as ITable;
  }

  /** Crea una mesa cash del tier indicado, con una semilla de bots. */
  async createCashTable(tierId: TableTierId): Promise<ITable> {
    const tier = getTier(tierId);
    if (!tier) throw new TableError('Tier de mesa desconocido');

    const tableId = `cash-${tierId}-${Date.now().toString(36)}`;

    const table = await Table.create({
      tableId,
      kind: 'cash',
      tierId,
      status: 'waiting',
      smallBlind: Math.max(1, Math.round(tier.defaultBuyIn / 200)),
      bigBlind: Math.max(2, Math.round(tier.defaultBuyIn / 100)),
      minBuyIn: tier.minBuyIn,
      guaranteedPrize: tier.guaranteedPrize,
      maxSeats: tier.maxPlayers,
      seats: [],
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

    logger.info(`Mesa cash creada: ${tableId} (${tier.maxPlayers} asientos)`);
    return table;
  }

  /** Retira al jugador de la mesa y le devuelve lo que tiene en ella. */
  async standUp(telegramId: number, tableId: string): Promise<{ returned: number }> {
    const table = await Table.findOne({ tableId });
    if (!table) throw new TableError('Mesa no encontrada', 404);

    const seatIndex = table.seats.findIndex(
      s => s.kind === 'human' && s.playerId === String(telegramId),
    );
    if (seatIndex === -1) throw new TableError('No estas en esa mesa');

    const seat = table.seats[seatIndex];

    // Si hay una mano en curso no se puede abandonar a mitad: eso permitiria
    // robarse el bote. Se marca para sentarse despues.
    const midHand =
      table.hand.phase !== 'idle' &&
      seat.status === 'active' &&
      seat.bet > 0;

    if (midHand) {
      throw new TableError(
        'Hay una mano en curso. Espera a que termine para salir.',
        409,
      );
    }

    const returned = seat.chips + seat.bet;

    table.seats.splice(seatIndex, 1);
    // Reindexar para no dejar huecos
    table.seats.forEach((s, i) => {
      s.index = i;
    });

    if (returned > 0) {
      await User.updateOne(
        { telegramId },
        { $inc: { 'balance.real': returned } },
      );
    }

    await User.updateOne({ telegramId }, { $set: { activeTableId: null } });

    const humansLeft = table.seats.filter(s => s.kind === 'human').length;
    if (humansLeft === 0) {
      table.status = 'waiting';
      table.seats = [];
    }

    await table.save();

    return { returned };
  }

  /**
   * Ejecuta la accion de un humano en la mano en curso.
   * Delega en el motor y persiste el resultado.
   */
  async act(
    telegramId: number,
    tableId: string,
    action: 'fold' | 'check' | 'call' | 'raise' | 'all_in',
    amount?: number,
  ): Promise<{ ok: boolean }> {
    const table = await Table.findOne({ tableId });
    if (!table) throw new TableError('Mesa no encontrada', 404);

    const seat = table.seats.find(
      s => s.kind === 'human' && s.playerId === String(telegramId),
    );
    if (!seat) throw new TableError('No estas en esa mesa', 403);

    if (table.hand.phase === 'idle') {
      throw new TableError('No hay ninguna mano en curso', 409);
    }

    // El turno tiene que ser suyo
    if (table.hand.actingSeat !== seat.index) {
      throw new TableError('No es tu turno', 409);
    }

    const applied = await tableManager.applyHumanAction(table, seat.index, action, amount);
    if (!applied) {
      throw new TableError('Accion no valida en esta situacion');
    }

    return { ok: true };
  }

  private async findSeatAnywhere(telegramId: number, exceptTableId?: string) {
    const query: any = {
      seats: { $elemMatch: { kind: 'human', playerId: String(telegramId) } },
    };
    if (exceptTableId) query.tableId = { $ne: exceptTableId };
    const table = await Table.findOne(query);
    return table ? { tableId: table.tableId } : null;
  }

  // ======================================================================
  // Freerolls
  // ======================================================================

  /**
   * Registra a un jugador en un freeroll.
   *
   * El freeroll no tiene buy-in: es gratuito. Los premios (5-50 CUP) se abonan
   * a `balance.play`, que NO es retirable. Ese es el gancho: invita a entrar y
   * a jugar, pero para sacar dinero hay que depositar.
   */
  async joinFreeroll(params: {
    telegramId: number;
    prizeTier?: number;
    freerollId?: string;
  }): Promise<{ freerollId: string; position: number; players: number }> {
    const { telegramId } = params;

    const user = await User.findOne({ telegramId });
    if (!user) throw new TableError('Usuario no encontrado', 404);

    const tier = params.prizeTier ?? FREEROLL_PRIZES[0];
    if (!FREEROLL_PRIZES.includes(tier as any)) {
      throw new TableError('Escalon de premio no valido');
    }

    // Buscar un freeroll abierto de ese escalon
    let freeroll: ITable | null = params.freerollId
      ? ((await Table.findOne({ tableId: params.freerollId })) as ITable | null)
      : ((await Table.findOne({
          kind: 'freeroll',
          status: { $in: ['waiting', 'running'] },
          prizeTier: tier,
          $expr: { $lt: [{ $size: '$seats' }, '$maxSeats'] },
        })) as ITable | null);

    if (!freeroll) {
      freeroll = await this.createFreeroll(tier);
    }

    const already = freeroll.seats.find(
      s => s.kind === 'human' && s.playerId === String(telegramId),
    );
    if (already) {
      throw new TableError('Ya estas registrado en este freeroll', 409);
    }

    const seat: ISeat = {
      index: freeroll.seats.length,
      kind: 'human',
      playerId: String(telegramId),
      displayName: user.firstName || user.username || `Jugador${telegramId}`,
      chips: 1000, // stack inicial del freeroll
      bet: 0,
      totalBet: 0,
      status: 'active',
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      handsPlayed: 0,
      handsWon: 0,
      netChips: 1000,
      joinedAt: new Date(),
    };

    freeroll.seats.push(seat);

    await User.updateOne(
      { telegramId },
      { $inc: { 'stats.freerollsPlayed': 1 } },
    );

    await freeroll.save();

    return {
      freerollId: freeroll.tableId,
      position: seat.index,
      players: freeroll.seats.length,
    };
  }

  /** Crea un freeroll para el escalon de premio dado. */
  async createFreeroll(prizeTier: number, maxPlayers = 100): Promise<ITable> {
    const tier = FREEROLL_PRIZES.includes(prizeTier as any) ? prizeTier : FREEROLL_PRIZES[0];

    const tableId = `freeroll-${tier}-${Date.now().toString(36)}`;

    const table = await Table.create({
      tableId,
      kind: 'freeroll',
      prizeTier: tier,
      status: 'waiting',
      smallBlind: 5,
      bigBlind: 10,
      minBuyIn: 0,
      // El bote del freeroll es el premio del escalon
      guaranteedPrize: tier,
      maxSeats: maxPlayers,
      seats: [],
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

    logger.info(`Freeroll creado: ${tableId} (premio ${tier} CUP)`);
    return table;
  }

  /**
   * Finaliza un freeroll y reparte el premio.
   *
   * El premio va a `balance.play` (NO retirable). El reparto es
   * 50/30/20 sobre el bote segun la posicion final.
   */
  async settleFreeroll(freerollId: string): Promise<{ results: any[] }> {
    const freeroll = await Table.findOne({ tableId: freerollId });
    if (!freeroll) throw new TableError('Freeroll no encontrado', 404);

    if (freeroll.status === 'finished') {
      return { results: [] };
    }

    // Ordenar por fichas restantes
    const ranked = [...freeroll.seats].sort((a, b) => b.chips - a.chips);
    const pot = freeroll.hand.pot || freeroll.guaranteedPrize;

    const results: any[] = [];

    for (let position = 1; position <= FREEROLL_PAYOUT.length; position++) {
      const seat = ranked[position - 1];
      if (!seat) break;

      const percentage = FREEROLL_PAYOUT[position - 1];
      const prize = Math.floor((pot * percentage) / 100);

      if (prize > 0 && seat.kind === 'human') {
        // SALDO NO RETIRABLE
        await User.updateOne(
          { telegramId: Number(seat.playerId) },
          {
            $inc: {
              'balance.play': prize,
              'stats.totalFreerollWon': prize,
            },
          },
        );

        results.push({
          telegramId: Number(seat.playerId),
          position,
          prize,
          withdrawable: false,
        });
      }
    }

    freeroll.status = 'finished';
    freeroll.stats.prizePaid = results.reduce((sum, r) => sum + r.prize, 0);
    freeroll.seats = [];
    freeroll.hand.phase = 'idle';

    await freeroll.save();

    logger.info(`Freeroll ${freerollId} liquidado: ${freeroll.stats.prizePaid} CUP`);
    return { results };
  }

  /** Lista de freerolls disponibles por escalon. */
  async listFreerolls() {
    const tables = await Table.find({
      kind: 'freeroll',
      status: { $in: ['waiting', 'running'] },
    }).limit(40);

    const byTier = new Map<number, any>();

    for (const t of tables) {
      const tier = t.prizeTier ?? 5;
      const existing = byTier.get(tier);
      const players = t.seats.filter(s => s.kind === 'human').length;

      if (!existing || players > existing.players) {
        byTier.set(tier, {
          prizeTier: tier,
          players,
          maxPlayers: t.maxSeats,
          phase: t.hand.phase,
          pot: t.hand.pot || t.guaranteedPrize,
          tableId: t.tableId,
          status: t.status,
        });
      }
    }

    return FREEROLL_PRIZES.map(prize => {
      const found = byTier.get(prize);
      return {
        prizeTier: prize,
        players: found?.players ?? 0,
        maxPlayers: found?.maxPlayers ?? 100,
        phase: found?.phase ?? 'waiting',
        pot: found?.pot ?? prize,
        tableId: found?.tableId,
        payout: FREEROLL_PAYOUT,
        withdrawable: false,
      };
    });
  }

  // ======================================================================
  // Bootstrap
  // ======================================================================

  /**
   * Crea una mesa de cada tier y un freeroll por escalon.
   * Se ejecuta al arrancar para que el lobby nunca este vacio.
   */
  async seedTables(): Promise<void> {
    for (const tier of TABLE_TIER_LIST) {
      const existing = await Table.findOne({ kind: 'cash', tierId: tier.id, status: 'waiting' });
      if (!existing) {
        await this.createCashTable(tier.id);
      }
    }

    for (const prize of FREEROLL_PRIZES) {
      const existing = await Table.findOne({
        kind: 'freeroll',
        prizeTier: prize,
        status: { $in: ['waiting', 'running'] },
      });
      if (!existing) {
        await this.createFreeroll(prize);
      }
    }

    logger.info('Mesas base verificadas');
  }
}

export const seatingService = new SeatingService();
