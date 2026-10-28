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
  TURN_TIMER,
  UNLOCK_RATES,
  CASH_FORMATS,
  CASH_FORMAT_LIST,
  getTier,
  type TableTierId,
  type CashFormatId,
} from '../config/product';
import { logger } from '../utils/logger';
import { unlockService } from '../services/unlock.service';
import { formatUnits, usdtToUnits, unitsToUsdt, blindsFor } from '../config/units';
import { splitPrize, fieldPayout, prizeDisclosure } from '../services/payout.service';
import { DEFAULT_AVATAR, getAvatar } from '../config/avatars';

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
    formatId?: CashFormatId;
    buyIn?: number;
  }): Promise<{ tableId: string; seatIndex: number; chips: number; spentFrom: { play: number; real: number } }> {
    const { telegramId } = params;

    const user = await User.findOne({ telegramId });
    if (!user) throw new TableError('Usuario no encontrado', 404);

    const table = await this.resolveTable(
      params.tableId,
      params.tierId,
      params.formatId,
    );

    // ------------------------------------------------------------------
    // ENTRAR A UN CAMPO NO SE HACE POR AQUI
    //
    // Este metodo coloca al jugador directamente en una mesa. En un campo eso
    // rompe tres cosas a la vez:
    //
    //  1. El campo no lleva la cuenta. `field.playersRemaining` y
    //     `field.buyInsCollected` no se incrementan, asi que el bote del campo
    //     sale mal y las posiciones pagadas se descuadran.
    //
    //  2. El jugador no pasa por la cola, asi que no hay forma de reasignarlo si
    //     la mesa donde cae se llena antes de tiempo.
    //
    //  3. El field manager no sabe que existe, asi que nunca lo recoge al
    //     eliminarlo ni le asigna posicion.
    //
    // Para jugar un campo hay que usar `fieldManager.register()`. Este metodo
    // se queda solo con las mesas cash sueltas, que no pertenecen a ningun
    // campo.
    if (table.field?.fieldId) {
      throw new TableError(
        'Esa mesa es parte de un campo. Entra por el campo, no por la mesa.',
        409,
      );
    }

    // ------------------------------------------------------------------
    // VARIAS MESAS A LA VEZ
    //
    // Un jugador puede tener varias mesas cash abiertas al mismo tiempo. El
    // stack de cada una vive en su mesa y el monedero solo paga la entrada de
    // cada asiento; no hay estado global que impida jugar dos. Los campos si
    // tienen su propia cola y su propio control de inscripcion.
    //
    // Antes habia aqui un `findSeatAnywhere` que devolvia "ya estas sentado en
    // otra mesa". Eso hacia imposible el multi-tabling y ademas bloqueaba al
    // jugador si le quedaba un asiento viejo en un freeroll.
    // ------------------------------------------------------------------

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
      // Se reasigna dentro del cerrojo, cuando se conocen los huecos reales.
      // `seats.length` no sirve: al salir un asiento intermedio el array se
      // acorta y el siguiente jugador recibiría un índice ya ocupado.
      index: -1,
      kind: 'human',
      playerId: String(telegramId),
      displayName: user.firstName || user.username || `Jugador${telegramId}`,
      avatar: getAvatar(user.avatar)?.id ?? DEFAULT_AVATAR,
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

    // ------------------------------------------------------------------
    // SENTARSE, CON EL CERROJO DEL MOTOR Y RELeyENDO
    //
    // El tick esta repartiendo, contando manos y moviendo fichas en este mismo documento
    // mientras esta peticion HTTP ocurre. Guardar la copia que se leyo al principio es
    // guardar una version obsoleta, y Mongo la descarta: el asiento no se guarda y el
    // jugador cree que esta sentado. En produccion salia como:
    //
    //     VersionError: No matching document found for id "6ac520e3..." version 66
    //
    // Re-leer DENTRO del cerrojo es lo que lo arregla: dentro no hay nadie mas escribiendo, y
    // lo que se guarda es el estado real de la mesa en ese instante. Con el cerrojo fuera, la
    // relectura no valdria de nada, porque el tick podria escribir entre la lectura y el
    // guardado.
    // ------------------------------------------------------------------
    await tableManager.withTableLock(table.tableId, async () => {
      const actual = await Table.findOne({ tableId: table.tableId });
      if (!actual) {
        throw new TableError('La mesa ya no existe.', 404);
      }

      // Se vuelve a comprobar el asiento: dentro del cerrojo el tick no ha escrito, pero otro
      // escritor del servicio (dos peticiones a la vez) si puede haberlo hecho.
      if (actual.seats.some((s) => s.kind === 'human' && s.playerId === String(telegramId))) {
        throw new TableError('Ya estas sentado en esta mesa.', 409);
      }

      // Primer entero libre, no la longitud del array. Es la misma regla que
      // usan los bots (`table.manager.addBotSeat`) y el campo.
      const usados = new Set(actual.seats.map((s) => s.index));
      let indiceLibre = 0;
      while (usados.has(indiceLibre)) indiceLibre++;
      if (indiceLibre >= actual.maxSeats) {
        throw new TableError('La mesa esta llena', 409);
      }
      seat.index = indiceLibre;

      actual.seats.push(seat);

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
          $set: { activeTableId: actual.tableId },
        },
      );

      if (actual.seats.filter((s) => s.kind === 'human').length === 1) {
        actual.status = 'waiting';
      }

      await actual.save();
    });

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
  private async resolveTable(
    tableId?: string,
    tierId?: TableTierId,
    formatId?: CashFormatId,
  ): Promise<ITable> {
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
    const formato = CASH_FORMATS[formatId || '7max'];
    if (!formato) throw new TableError('Formato de mesa desconocido');

    // Buscar una mesa del mismo tier Y formato con sitio. Sin el filtro de
    // formato, entrar por `tierId` podia sentar al jugador en una mesa HU
    // cuando pedia la de 7-max (o al reves), porque las tres comparten tier.
    const existing = await Table.findOne({
      kind: 'cash',
      tierId: tier.id,
      formatId: formato.id,
      status: { $in: ['waiting', 'running'] },
      $expr: { $lt: [{ $size: '$seats' }, '$maxSeats'] },
    });

    if (existing) return existing as ITable;

    // Crear mesa nueva para el tier y formato.
    return (await this.createCashTable(tier.id, formato.id)) as ITable;
  }

  /** Crea una mesa cash del tier y formato indicados, con una semilla de bots. */
  async createCashTable(
    tierId: TableTierId,
    formatId: CashFormatId = '7max',
  ): Promise<ITable> {
    const tier = getTier(tierId);
    if (!tier) throw new TableError('Tier de mesa desconocido');

    const formato = CASH_FORMATS[formatId];
    if (!formato) throw new TableError('Formato de mesa desconocido');

    const tableId =
      `cash-${tierId}-${formato.id}-${Date.now().toString(36)}-` +
      `${Math.random().toString(36).slice(2, 6)}`;

    const table = await Table.create({
      tableId,
      kind: 'cash',
      tierId,
      formatId: formato.id,
      status: 'waiting',
      // Las ciegas vienen del tier ya calculadas en unidades. No se derivan
      // aqui con `Math.round(buyIn / 100)`: dos mesas del mismo tier podrian
      // acabar con ciegas distintas por el redondeo, y el jugador lo notaria al
      // pasar de una a otra.
      smallBlind: tier.blinds.small,
      bigBlind: tier.blinds.big,
      buyInUnits: tier.buyInUnits,
      // El formato decide cuantos asientos tiene la mesa. `tier.fieldSize` es
      // el numero de participantes del campo completo (multi-mesa), no lo que
      // cabe en una mesa.
      maxSeats: formato.maxSeats,
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
      `(${formato.label}, campo de ${tier.fieldSize}, buy-in ${tier.buyInUsdt} USDT ` +
      `= ${tier.stackInBigBlinds} BB)`,
    );
    return table;
  }

  /**
   * Vuelve a comprar entrada en una mesa cash después de quedarse sin fichas.
   *
   * Hay dos casos reales:
   *
   *   1. El asiento sigue en la mesa con 0 fichas (fin de mano, antes del
   *      siguiente ciclo): se recarga ese mismo asiento.
   *   2. El gestor ya retiró el asiento al bustear: se vuelve a sentar en la
   *      misma mesa, cobrando exactamente el buy-in de la mesa.
   *
   * Nunca se permite recargar con fichas vivas: eso sería un top-up a mitad
   * de sesión y rompería la economía de la mesa.
   */
  async rebuy(
    telegramId: number,
    tableId: string,
  ): Promise<{ tableId: string; seatIndex: number; chips: number; rebought: boolean }> {
    const table = await Table.findOne({ tableId });
    if (!table) throw new TableError('Mesa no encontrada', 404);

    if (table.field?.fieldId) {
      throw new TableError(
        'No se puede recomprar en un campo: tu posición depende de hasta dónde llegues.',
        409,
      );
    }
    if (table.kind !== 'cash') {
      throw new TableError('Solo se puede recomprar en una mesa cash', 409);
    }

    const asiento = table.seats.find(
      (s) => s.kind === 'human' && s.playerId === String(telegramId),
    );

    // Caso 2: el asiento ya no existe. `sitDown` reutiliza toda la validación
    // de saldo, cerrojo, hueco y activeTableId.
    if (!asiento) {
      const sentado = await this.sitDown({ telegramId, tableId });
      return { ...sentado, rebought: true };
    }

    if (asiento.chips > 0) {
      throw new TableError(
        'Todavía tienes fichas en la mesa. No puedes recargar ahora.',
        409,
      );
    }
    if (
      table.hand.phase !== 'idle' &&
      table.hand.phase !== 'idle-awaiting'
    ) {
      throw new TableError(
        'Espera a que termine la mano para volver a comprar entrada.',
        409,
      );
    }

    const user = await User.findOne({ telegramId });
    if (!user) throw new TableError('Usuario no encontrado', 404);

    // No se comprueba `activeTableId`: con multi-tabling puede apuntar a otra
    // mesa abierta y eso no impide recargar esta. El asiento y el cerrojo de
    // la mesa son los que mandan.
    const buyIn = table.buyInUnits;
    const disponible = user.balance.real + user.balance.play;
    if (disponible < buyIn) {
      throw new TableError(
        `Necesitas ${formatUnits(buyIn)} USDT para volver a entrar. ` +
        `Tienes ${formatUnits(disponible)}.`,
      );
    }

    let seatIndex = asiento.index;
    let chips = 0;
    let fromPlay = 0;
    let fromReal = 0;

    await tableManager.withTableLock(tableId, async () => {
      const actual = await Table.findOne({ tableId });
      if (!actual) throw new TableError('La mesa ya no existe', 404);

      const actualSeat = actual.seats.find(
        (s) => s.kind === 'human' && s.playerId === String(telegramId),
      );
      if (!actualSeat) {
        throw new TableError(
          'Tu asiento ya no está en la mesa. Vuelve a sentarte.',
          409,
        );
      }
      if (actualSeat.chips > 0) {
        throw new TableError('Ya tienes fichas en la mesa', 409);
      }
      if (
        actual.hand.phase !== 'idle' &&
        actual.hand.phase !== 'idle-awaiting'
      ) {
        throw new TableError('La mano ya empezó. Espera a la siguiente.', 409);
      }

      // El cobro va DENTRO del cerrojo: dos pulsaciones de "recargar" no
      // pueden descontar dos buy-ins para un solo asiento. Si la segunda
      // llega después, ya ve `chips > 0` y no cobra.
      const split = await unlockService.splitBuyIn(telegramId, buyIn, 'cash');
      fromPlay = split.fromPlay;
      fromReal = buyIn - fromPlay;

      actualSeat.chips = buyIn;
      actualSeat.bet = 0;
      actualSeat.totalBet = 0;
      actualSeat.status = 'active';
      actualSeat.netChips += buyIn;
      actualSeat.timeBankMs = TURN_TIMER.timeBankMs;
      seatIndex = actualSeat.index;
      chips = buyIn;

      await User.updateOne(
        { telegramId },
        {
          $inc: { 'balance.real': -fromReal },
          $set: { activeTableId: actual.tableId },
        },
      );

      await actual.save();
    });

    logger.info(
      `Jugador ${telegramId} recompró ${buyIn} unidades en ${tableId} ` +
      `(${fromPlay} play + ${fromReal} real)`,
    );

    return { tableId, seatIndex, chips, rebought: true };
  }

  /**
   * Retira al jugador de una MESA CASH SUELTA y le devuelve lo que tiene.
   *
   * ------------------------------------------------------------------
   * EN UN CAMPO ESTO ESTA PROHIBIDO
   *
   * En un campo Sit'n'Go, levantarse de la mesa y recuperar el buy-in es un
   * dreno trivial: el jugador entra, cobra su parte del premio al ganar y, al
   * salir, recupera las fichas intactas. Puede repetirlo cuantas veces quiera y
   * la plataforma paga cada ronda.
   *
   * Ademas rompe la contabilidad del campo: el field manager lleva la cuenta de
   * `playersRemaining` y de las posiciones pagadas. Un jugador que se va sin
   * pasar por `collectEliminations()` deja su contador desfasado, y el siguiente
   * que sea eliminado recibe una posicion que no le corresponde.
   *
   * La salida de un campo la gestiona `field.manager` cuando el jugador queda
   * eliminado: ahi se le adjudica la posicion correcta y se le devuelve lo que
   * le quede en la mesa.
   */
  async standUp(telegramId: number, tableId: string): Promise<{ returned: number }> {
    const table = await Table.findOne({ tableId });
    if (!table) throw new TableError('Mesa no encontrada', 404);

    // ESTA ES LA COMPROBACION QUE IMPIDE EL DRENO.
    if (table.field?.fieldId) {
      throw new TableError(
        'Esta mesa es parte de un campo: no se puede salir a mitad. ' +
        'Tu posición depende de hasta dónde llegues.',
        409,
      );
    }

    const seatIndex = table.seats.findIndex(
      s => s.kind === 'human' && s.playerId === String(telegramId),
    );
    if (seatIndex === -1) throw new TableError('No estas en esa mesa');

    const seat = table.seats[seatIndex];

    // Si hay una mano en curso no se puede abandonar a mitad, aunque la
    // apuesta viva sea cero (las apuestas ya estan en el bote al cerrar la
    // calle). Quitar el asiento obliga a reindexar la mesa, y el motor en
    // memoria sigue apuntando a los indices viejos: la mano continuaria con
    // los jugadores equivocados. Se espera al cierre de la mano.
    const midHand =
      table.hand.phase !== 'idle' && table.hand.phase !== 'idle-awaiting';

    if (midHand) {
      throw new TableError(
        'Hay una mano en curso. Espera a que termine para salir.',
        409,
      );
    }

    const returned = seat.chips + seat.bet;

    // ------------------------------------------------------------------
    // LEVANTARSE, CON EL CERROJO Y RELeyENDO. Por el mismo motivo que sentarse:
    // el tick escribe este documento a la vez. Guardar una copia vieja descarta el `save` y
    // el jugador se queda con la mesa ocupada y las fichas dentro, sin poder salir y sin
    // saberlo.
    // ------------------------------------------------------------------
    await tableManager.withTableLock(table.tableId, async () => {
      const actual = await Table.findOne({ tableId: table.tableId });
      if (!actual) throw new TableError('La mesa ya no existe.', 404);

      // El indice puede haber cambiado entre la lectura inicial y ahora (el motor reordena
      // asientos al liquidar), asi que se busca por identidad y no por posicion.
      const indiceActual = actual.seats.findIndex(
        (s) => s.kind === 'human' && s.playerId === String(telegramId),
      );
      if (indiceActual === -1) throw new TableError('No estas en esa mesa');

      const asiento = actual.seats[indiceActual];

      // Se revalida con el documento fresco y con la misma regla: ni una mano
      // en curso, ni siquiera con la apuesta viva a cero. Reindexar a mitad
      // descuadra el motor.
      if (
        actual.hand.phase !== 'idle' &&
        actual.hand.phase !== 'idle-awaiting'
      ) {
        throw new TableError(
          'Hay una mano en curso. Espera a que termine para salir.',
          409,
        );
      }

      const aDevolver = asiento.chips + asiento.bet;

      actual.seats.splice(indiceActual, 1);
      // Reindexar para no dejar huecos
      actual.seats.forEach((s, i) => {
        s.index = i;
      });

      if (aDevolver > 0) {
        // El saldo ANTES de devolver, porque es la base de la proporcion: de lo que tiene,
        // cuanto es premio. Se lee aqui y no dentro de la Actualizacion para que quede claro
        // que es una operacion de lectura normal, no una expresion de Mongo.
        const antesDeDevolver = await User.findOne({ telegramId });
        const saldoAntes = antesDeDevolver?.balance?.real ?? 0;
        const marcadoAntes = antesDeDevolver?.balance?.realFromPrizes ?? 0;

        // Lo que sale de la parte marcada. Nunca mas de lo que hay marcado, aunque la mesa
        // estuviera corrupta y devolviera mas de lo que el jugador tenia.
        const premioQueSale = Math.min(
          marcadoAntes,
          Math.round((marcadoAntes * aDevolver) / Math.max(1, saldoAntes)),
        );

        await User.updateOne(
          { telegramId },
          {
          $inc: {
            'balance.real': aDevolver,
            // La parte marcada como premio baja en la MISMA proporcion.
            //
            // Sin esto, a los pocos ciclos `realFromPrizes` acabaria marcando dinero que el
            // jugador ya no tiene, y acabaria por ser MAYOR que el saldo. El informe de
            // "que es premio y que es deposito" es justo para lo que existe el campo, asi que
            // un campo que miente es peor que no tenerlo.
            //
            // Proporcion: de `realFromPrizes` sobre `real` (antes de devolver). Si el
            // jugador devuelve todo, no le queda nada de premio; si devuelve la mitad, la
            // mitad. Nunca baja de cero.
            'balance.realFromPrizes': -premioQueSale,
          },
        },
        );
      }

      // Puede quedar otra mesa abierta. `activeTableId` es solo una pista para
      // reconectar; la fuente de verdad son los asientos. Se apunta a la
      // primera mesa que siga ocupada para no dejar el campo en null.
      const otraMesa = await Table.findOne({
        tableId: { $ne: actual.tableId },
        seats: {
          $elemMatch: {
            kind: 'human',
            playerId: String(telegramId),
            status: { $ne: 'out' },
          },
        },
      })
        .select('tableId')
        .lean();
      await User.updateOne(
        { telegramId },
        { $set: { activeTableId: otraMesa?.tableId ?? null } },
      );

      const quedanHumanos = actual.seats.filter((s) => s.kind === 'human').length;
      if (quedanHumanos === 0) {
        actual.status = 'waiting';
        actual.seats = [];
      }

      await actual.save();
    });

    return { returned };
  }

  /**
   * Usa el banco de tiempo del turno actual.
   *
   * No mueve fichas ni cartas: alarga el plazo del turno. Se hace con el mismo
   * cerrojo que las acciones para que el tick no cierre la mano justo mientras
   * el jugador pide tiempo. El banco es por mano y se reinicia en `startHand`.
   */
  async useTimeBank(
    telegramId: number,
    tableId: string,
  ): Promise<{ timeBankMs: number; turnEndsAt: string }> {
    return tableManager.withTableLock(tableId, async () => {
      const table = await Table.findOne({ tableId });
      if (!table) throw new TableError('Mesa no encontrada', 404);

      const seat = table.seats.find(
        (s) => s.kind === 'human' && s.playerId === String(telegramId),
      );
      if (!seat) throw new TableError('No estas en esa mesa', 403);

      const fases = ['preflop', 'flop', 'turn', 'river'];
      if (!fases.includes(table.hand.phase)) {
        throw new TableError('No hay una mano en curso', 409);
      }
      if (table.hand.actingSeat !== seat.index) {
        throw new TableError('No es tu turno', 409);
      }

      const disponible = Math.max(
        0,
        seat.timeBankMs ?? TURN_TIMER.timeBankMs,
      );
      if (disponible <= 0) {
        throw new TableError('Ya usaste tu banco de tiempo en esta mano', 409);
      }

      const ahora = Date.now();
      const inicio = table.hand.lastActionAt
        ? new Date(table.hand.lastActionAt).getTime()
        : ahora;
      const restante = Math.max(
        0,
        inicio + TURN_TIMER.humanMs - ahora,
      );
      const extension = Math.min(disponible, TURN_TIMER.timeBankMs);
      const nuevoVencimiento = ahora + restante + extension;

      // `lastActionAt` sigue siendo la base del reloj. Se retrocede lo
      // suficiente para que el vencimiento sea el nuevo, aunque quede en el
      // futuro inmediato: `checkTurnTimeout` mide el transcurso desde ahí.
      table.hand.lastActionAt = new Date(nuevoVencimiento - TURN_TIMER.humanMs);
      seat.timeBankMs = Math.max(0, disponible - extension);
      await table.save();

      return {
        timeBankMs: seat.timeBankMs,
        turnEndsAt: new Date(nuevoVencimiento).toISOString(),
      };
    });
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
    // ------------------------------------------------------------------
    // ESTA CONSULTA NO FILTRABA POR ESTADO DE ASIENTO
    //
    // Buscaba cualquier mesa con un asiento humano a tu nombre, y daba igual como estuviera
    // ese asiento. O sea que una plaza YA LIBERDADA contaba como "sigues sentado".
    //
    // Eso rompia tres cosas a la vez, todas con el mismo mensaje:
    //
    //   - `stand` devolvia las fichas correctamente, pero acto seguido `sit` respondia
    //     "Ya estas sentado en otra mesa". El jugador se levanta y no puede volver a
    //     sentarse: no hay forma de jugar dos manos seguidas.
    //   - Plazas viejas en mesas antiguas (freerolls, campos de semanas atras) te
    //     bloqueaban el acceso a CUALQUIER mesa nueva para siempre. Por eso el recorrido
    //     acababa en freeroll-1, freeroll-3 y freeroll-200 en vez de en una mesa de poker.
    //   - `GET /game/my-table` SI filtraba por estado, y por eso decia que no estabas
    //     sentado mientras este decia que si. Dos respostas contradictorias para la misma
    //     pregunta, con dos criterios distintos.
    //
    // El criterio correcto es el mismo en los tres sitios: un asiento te ocupa mientras no
    // este libre ni liquidado.
    //
    //   'empty'      plaza libre, no ocupas nada
    //   'out'        liquidado, ya no juegas ahi
    //   'active'     jugando: te ocupa
    //   'eliminated' eliminado en un campo: te ocupa, porque el campo todavia te debe una
    //                posicion y las fichas estan en el bote
    //
    // Que el asiento contenga tu `playerId` no dice si te corresponde: dice que te
    // estuvo correspondiendo en algun momento.
    //
    // Los estados son los de `SeatStatus` (`src/models/Table.ts`): `active`, `folded`,
    // `all_in`, `sitting_out`, `eliminated` y `out`. Ojo al `sitting_out`, con guion bajo.
    // Todos menos `out` te ocupan:
    //
    //   active / folded / all_in / sitting_out  estas jugando ahi
    //   eliminated                              estas eliminado, pero el campo te debe una
    //                                            posicion y tus fichas estan en el bote
    //   out                                     ya no ocupas nada
    // ------------------------------------------------------------------
    const OCUPADO = ['active', 'folded', 'all_in', 'sitting_out', 'eliminated'];

    const query: any = {
      seats: {
        $elemMatch: {
          kind: 'human',
          playerId: String(telegramId),
          status: { $in: OCUPADO },
        },
      },
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

    const usados = new Set(freeroll.seats.map((s) => s.index));
    let indiceLibre = 0;
    while (usados.has(indiceLibre)) indiceLibre++;
    if (indiceLibre >= freeroll.maxSeats) {
      throw new TableError('El freeroll ya esta lleno', 409);
    }

    const seat: ISeat = {
      index: indiceLibre,
      kind: 'human',
      playerId: String(telegramId),
      displayName: user.firstName || user.username || `Jugador${telegramId}`,
      avatar: getAvatar(user.avatar)?.id ?? DEFAULT_AVATAR,
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
   * Crea una mesa de cada tier de cash.
   * Se ejecuta al arrancar para que el lobby nunca este vacio.
   *
   * ------------------------------------------------------------------
   * LOS FREEROLLS YA NO SE SIEMBRAN AQUI
   *
   * Antes se creaba una mesa de freeroll por cada escalon de premio (1, 3, 10, 25, 50 y 200
   * CUP). Ese producto ya no existe: el freeroll es ahora un CAMPO horario multi-mesa que
   * gestiona `freeroll.service.ts`, con su propio reloj y su propio premio en USDT.
   *
   * Si se siguieran sembrando, el servidor arrancaria seis mesas `freeroll-1`, `freeroll-3`...
   * que nadie puede listar ni usar, y el log diria "premio 1 CUP" en un producto que ya solo
   * habla USDT. Ruido que confunde justo cuando se mira un despliegue.
   * ------------------------------------------------------------------
   */
  async seedTables(): Promise<void> {
    // Una mesa por cada sala (tier) y cada formato que el motor puede jugar.
    // Asi el lobby nunca ensena una sala vacia y el jugador puede elegir
    // 7-max, 6-max o Heads-Up sin esperar a que se cree la mesa.
    for (const tier of TABLE_TIER_LIST) {
      for (const formato of CASH_FORMAT_LIST) {
        // Las mesas antiguas no tienen `formatId`; se consideran 7-max para no
        // duplicarlas en cada arranque.
        const filtroFormato =
          formato.id === '7max'
            ? { $or: [{ formatId: '7max' }, { formatId: { $exists: false } }] }
            : { formatId: formato.id };

        const existing = await Table.findOne({
          kind: 'cash',
          tierId: tier.id,
          status: { $in: ['waiting', 'running'] },
          ...filtroFormato,
        });

        if (!existing) {
          await this.createCashTable(tier.id, formato.id);
        }
      }
    }

    logger.info('Mesas base verificadas (7-max, 6-max y Heads-Up por sala)');
  }
}

export const seatingService = new SeatingService();
