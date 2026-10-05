import { Table, ITable, ISeat } from '../models/Table';
import { User } from '../models/User';
import { tableManager } from './table.manager';
import {
  TABLE_TIERS,
  TABLE_TIER_LIST,
  FREEROLL_PRIZES,
  FREEROLL_PAYOUT,
  FREEROLL_TARGET_FIELD,
  BOT_CONFIG,
  SEATS_PER_TABLE,
  CENTROLL,
  UNLOCK_RATES,
  getTier,
  type TableTierId,
} from '../config/product';
import { logger } from '../utils/logger';
import { unlockService } from '../services/unlock.service';
import { formatUnits, usdtToUnits, unitsToUsdt, blindsFor } from '../config/units';
import { splitPrize, fieldPayout, prizeDisclosure } from '../services/payout.service';

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

    // EL BUY-IN NO SE NEGOCIA EN UNA MESA DE CAMPO.
    //
    // Antes `params.buyIn` permitia comprar mas que el minimo y se calculaba un
    // buy-in "mayor" con `minBuyIn * 2`. Eso es de mesa de cash: entras con la
    // cantidad que quieras. En un campo todos pagan lo mismo, porque las fichas
    // son la unidad de supervivencia del campo: si uno entra con el doble, el
    // rake del campo deja de ser comparable entre jugadores y el reparto por
    // posicion deja de significar nada.
    //
    // Asi que el buy-in es exactamente `table.buyInUnits`, sin parametros.
    const finalBuyIn = table.buyInUnits;

    const available = user.balance.real + user.balance.play;
    if (available < finalBuyIn) {
      throw new TableError(
        `Necesitas ${formatUnits(finalBuyIn)} USDT para esta mesa. ` +
        `Tienes ${formatUnits(available)}.`,
      );
    }

    // Consumo: play primero, luego real. Y lo que sale de `play` se desbloquea
    // a retirable segun el ratio: es el mecanismo de Promotional Dollars.
    const split = await unlockService.splitBuyIn(telegramId, finalBuyIn, 'cash');
    const fromPlay = split.fromPlay;
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

    // `splitBuyIn` ya descontó `fromPlay` de `play` y acreditó su unlock a
    // `real`. Aquí solo se descuenta el resto del saldo real. Si se descontara
    // también `play`, se cobraría dos veces la parte de promoción.
    await User.updateOne(
      { telegramId },
      {
        $inc: {
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

    const tier = getTier(tierId || '') || TABLE_TIERS.t1;

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
      // Las ciegas vienen del tier ya calculadas en unidades. No se derivan
      // aqui con `Math.round(buyIn / 100)`: dos mesas del mismo tier podrian
      // acabar con ciegas distintas por el redondeo, y el jugador lo notaria al
      // pasar de una a otra.
      smallBlind: tier.blinds.small,
      bigBlind: tier.blinds.big,
      buyInUnits: tier.buyInUnits,
      // 7 asientos. `tier.fieldSize` es el numero de participantes del campo
      // completo (multi-mesa), no lo que cabe en una mesa.
      maxSeats: SEATS_PER_TABLE,
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

    logger.info(
      `Mesa cash creada: ${tableId} ` +
      `(7-max, campo de ${tier.fieldSize}, buy-in ${tier.buyInUsdt} USDT ` +
      `= ${tier.stackInBigBlinds} BB)`,
    );
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
   * El freeroll no tiene buy-in: es gratuito. El premio del escalon se reparte
   * entre los que quedan vivos, y las fichas iniciales de cada jugador son su
   * parte de ese premio. Al eliminarse pierde esa parte.
   *
   * Lo que el ganador se lleva va a `balance.play` (Promotional Dollars): no se
   * retira directamente, se desbloquea jugando a ratio 1:10. Ver
   * `UNLOCK_RATES`.
   */
  async joinFreeroll(params: {
    telegramId: number;
    prizeTier?: number;
    freerollId?: string;
  }): Promise<{ freerollId: string; position: number; players: number; startChips: number }> {
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

    // El stack inicial es la parte del premio que le toca a cada uno. Se calcula
    // con la MISMA formula que `createFreeroll` usa para las ciegas, o el
    // jugador entraria con fichas que no cubren ni la ciega grande y seria
    // all-in antes de jugar.
    const startChips = Math.max(
      2,
      Math.floor(
        usdtToUnits(tier) /
        ((freeroll.field?.targetField || FREEROLL_TARGET_FIELD) * 0.5),
      ),
    );

    const seat: ISeat = {
      index: freeroll.seats.length,
      kind: 'human',
      playerId: String(telegramId),
      displayName: user.firstName || user.username || `Jugador${telegramId}`,
      chips: startChips,
      bet: 0,
      totalBet: 0,
      status: 'active',
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      handsPlayed: 0,
      handsWon: 0,
      netChips: startChips,
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
      startChips,
    };
  }

  /**
   * Crea un freeroll para el escalon de premio dado.
   *
   * `targetField` es el numero de participantes que deben inscribirse para que
   * el campo arranque. En la practica no es ilimitado: un freeroll de 20 000
   * personas tardaria horas en llegar a mesa final y, sin tope, el mismo jugador
   * podria abrir campos en bucle. El tope protege al operador, no al jugador,
   * asi que hay que anunciarlo en la UI.
   */
  async createFreeroll(prizeTier: number, targetField = FREEROLL_TARGET_FIELD): Promise<ITable> {
    const tier = FREEROLL_PRIZES.includes(prizeTier as any) ? prizeTier : FREEROLL_PRIZES[0];

    const tableId = `freeroll-${tier}-${Date.now().toString(36)}`;

    // Las fichas del freeroll son el PREMIO repartido entre los que quedan
    // vivos. Con 1000 unidades de premio (1 USDT) entre hasta 300 jugadores, cada
    // uno empieza con 3 unidades, que es la ciega pequena del micro.
    //
    // No son un buy-in comprado: el jugador no paga nada, y por eso la
    // "ficha" inicial es la parte del premio que le toca por estar dentro. Al
    // eliminarse, pierde esa parte, y el bote se reparte al final.
    const startChips = Math.max(
      2,
      Math.floor(usdtToUnits(tier) / (targetField * 0.5)),
    );
    const { small, big } = blindsFor(startChips);

    const table = await Table.create({
      tableId,
      kind: 'freeroll',
      prizeTier: tier,
      status: 'waiting',
      smallBlind: small,
      bigBlind: big,
      // 0: el freeroll no se compra.
      buyInUnits: 0,
      // 7-max tambien en freeroll: una mesa de poker es una mesa de poker.
      maxSeats: SEATS_PER_TABLE,
      // Objetivo de inscripcion del campo multi-mesa
      targetField,
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
   *
   * NOTA (pendiente): esto liquida UN freeroll de una mesa, no un campo. Cuando
   * exista el field manager, el freeroll de 7-max con 300 participantes seran
   * 43 mesas: el premio se reparte cuando quede UNA mesa, y el reparto por
   * posicion es sobre el field entero, no sobre los 7 de esa mesa. Este metodo
   * pasara a ser el caso base (mesa unica) y el field manager hara el resto.
   */
  async settleFreeroll(freerollId: string): Promise<{ results: any[] }> {
    const freeroll = await Table.findOne({ tableId: freerollId });
    if (!freeroll) throw new TableError('Freeroll no encontrado', 404);

    if (freeroll.status === 'finished') {
      return { results: [] };
    }

    // Ordenar por fichas restantes
    const ranked = [...freeroll.seats].sort((a, b) => b.chips - a.chips);

    // El bote de un freeroll es el PREMIO DEL ESCALON, no el bote de la ultima
    // mano. El freeroll no cobra rake (RAKE.freerollPercentage = 0), asi que el
    // bote es el premio entero.
    //
    // `prizeTier` esta en unidades internas, como todo lo demas. Usar
    // `hand.pot` aqui seria un error de unidades: es el bote de UNA mano (unas
    // decenas de unidades) y no el premio del campo (miles).
    const pot = usdtToUnits(freeroll.prizeTier ?? 0);

    // El reparto lo calcula `splitPrize`, no `Math.floor` por porcentaje.
    //
    // El reparto ingenuo descuadra: con un bote de 5 CUP y tres posiciones al
    // 50/30/20 daba 2 + 1 + 1 = 4, dejando 1 CUP sin dueño. Con botes grandes
    // los descuadres son de decenas de CUP y al final hay alguien a quien no le
    // cuadra la cuenta. Y en el extremo opuesto, repartir "floor mas resto a
    // partes iguales" puede dar MAS de lo que hay: dinero creado.
    const shares = splitPrize(pot, FREEROLL_PAYOUT);

    const results: any[] = [];

    for (let position = 1; position <= FREEROLL_PAYOUT.length; position++) {
      const seat = ranked[position - 1];
      if (!seat) break;

      const percentage = FREEROLL_PAYOUT[position - 1];
      const prize = shares[position - 1] ?? 0;

      if (prize > 0 && seat.kind === 'human') {
        // AL SALDO DE PROMOCION (P$), NO RETIRABLE.
        //
        // El mecanismo de Promotional Dollars: el saldo de `play` no se retira,
        // se desbloquea jugando a ratio 1:10. Un freeroll es entrada gratis, asi
        // que si el premio fuera retirable seria un dreno directo: repetir
        // freerolls para sacar dinero sin haber depositado nunca.
        //
        // Con el ratio, hay que jugar el 90% de esas fichas para intentar
        // extraer el 10%, y por el camino se pierde casi todo.
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
          maxSeats: t.maxSeats,
          phase: t.hand.phase,
          // El bote del freeroll es el premio del escalon, no el de la ultima
          // mano (ver `settleFreeroll`).
          pot: usdtToUnits(tier),
          tableId: t.tableId,
          status: t.status,
          // Inscritos de todas las mesas de este escalon, no solo de esta.
          fieldRegistered: t.field?.registered ?? players,
          fieldTarget: t.field?.targetField ?? FREEROLL_TARGET_FIELD,
        });
      }
    }

    return FREEROLL_PRIZES.map(prize => {
      const found = byTier.get(prize);
      return {
        prizeTier: prize,
        // Asientos de esta mesa fisica (7).
        maxPlayers: found?.maxSeats ?? SEATS_PER_TABLE,
        // Participantes del campo: es lo que la UI muestra como "inscritos".
        players: found?.fieldRegistered ?? 0,
        fieldTarget: found?.fieldTarget ?? FREEROLL_TARGET_FIELD,
        phase: found?.phase ?? 'waiting',
        // El bote es el premio del escalon, en USDT para la UI.
        pot: unitsToUsdt(usdtToUnits(prize)),
        tableId: found?.tableId,
        payout: FREEROLL_PAYOUT,
        /**
         * El premio va a `balance.play`, que NO se retira: se desbloquea 1 de
         * cada 10 jugando. Ver `UNLOCK_RATES`.
         *
         * Este flag lo lee la UI para no prometer dinero retirable.
         */
        withdrawable: false,
        unlockRatio: `1:${Math.round(1 / UNLOCK_RATES.freeroll)}`,
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
