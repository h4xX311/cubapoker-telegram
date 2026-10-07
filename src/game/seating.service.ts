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

      // Si la mano ha avanzado y ahora hay apuesta en curso, sigue sin poder salir: abandonarse
      // con fichas en el bote seria robarlo.
      if (actual.hand.phase !== 'idle' && asiento.status === 'active' && asiento.bet > 0) {
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
        await User.updateOne(
          { telegramId },
          { $inc: { 'balance.real': aDevolver } },
        );
      }

      await User.updateOne({ telegramId }, { $set: { activeTableId: null } });

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
