import { Table, ITable, ISeat, toPublicTable } from '../models/Table';
import { Field } from '../models/Field';
import { unitsToUsdt } from '../config/units';
import { User } from '../models/User';
import { PokerGame } from './game.state';
import { botFactory, BotProfile, decideAction, mulberry32 } from './bot.engine';
import { TABLE_TIERS, TABLE_TIER_LIST, BOT_CONFIG, RAKE, TURN_TIMER, getTier } from '../config/product';
import { logger } from '../utils/logger';

/**
 * Aviso de turno para un jugador humano.
 *
 * Deliberadamente NO lleva el estado de la mesa: el jugador abre la mini app
 * para jugar. El sistema anterior mandaba el bote, las cartas comunitarias y la
 * lista de rivales en cada mensaje, lo que producia un spam ilegible que ademas
 * esaba las cartas de los demas.
 */
export interface TurnNotice {
  telegramId: number;
  chatId?: number;
  tableId: string;
  seatIndex: number;
  /** Calle de la mano: preflop, flop, turn, river... */
  phase: string;
  /** Cuanto tiene que poner para continuar (0 = puede pasar). */
  toCall: number;
  /** Sus fichas. */
  chips: number;
  pot: number;
  /** Sus cartas Hole, en notacion `rank|suit`. */
  cards: { rank: string; suit: string }[];
  /** Vida maxima del aviso: si no responde, el motor juega por el. */
  deadlineMs: number;
}

export type TurnNotifier = (notice: TurnNotice) => void | Promise<void>;

/** Fases en las que hay una decision pendiente de un jugador concreto. */
const ACTION_PHASES = new Set<string>(['preflop', 'flop', 'turn', 'river']);

/**
 * Gestor de mesas.
 *
 * POR QUE ESTO EXISTE
 * -------------------
 * El sistema anterior guardaba las mesas en un `Map` en memoria. Eso rompia de
 * tres maneras a la vez: se perdia en cada reinicio de Render, se dividia si
 * el servicio corria en mas de una instancia, y no permitia auditar nada.
 *
 * Aqui la mesa vive en MongoDB, que es la unica fuente de verdad. El motor de
 * una mano concreta sigue en memoria porque es volatil, pero los saldos, los
 * asientos y el premio siempre estan persistidos. Si el proceso muere a mitad
 * de una mano, al arrancar el gestor devuelve las fichas a los jugadores.
 */
export class TableManager {
  /** Motor de mano en curso por mesa (estado volatil) */
  private engines = new Map<string, { engine: PokerGame; handSeed: number }>();

  /** Temporizadores de turno pendientes */
  private turnTimers = new Map<string, NodeJS.Timeout>();

  private tickHandle: NodeJS.Timeout | null = null;
  private starting = false;

  /**
   * Avisos de turno ya enviados, para no repetir la misma notificacion.
   * La clave identifica un turno concreto: mano + asiento + calle + la marca
   * de tiempo de la ultima accion. Sin esto, el jugador recibiria el mismo
   * "te toca" cada vez que el bucle refrescara la mesa.
   */
  private turnNotified = new Set<string>();

  /**
   * Callback de notificacion. Lo registra `bot.ts` porque el gestor de mesas
   * no debe depender del bot de Telegram: asi el nucleo del juego se puede
   * probar (y migrar a otro transporte) sin tocarlo.
   */
  private notifier: TurnNotifier | null = null;

  setNotifier(fn: TurnNotifier): void {
    this.notifier = fn;
  }

  // ======================================================================
  // Ciclo de vida
  // ======================================================================

  /**
   * Arranque seguro.
   * Primero devuelve las fichas de las manos que quedaron colgadas por un
   * reinicio, y luego empieza el bucle que rellena mesas y hace actuar a los
   * bots. Es idempotente: se puede llamar mas de una vez sin duplicar timers.
   */
  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;

    try {
      const recovered = await this.recoverInterruptedHands();
      logger.info(
        `TableManager iniciado. Manos recuperadas: ${recovered}, ` +
        `mesas activas: ${await Table.countDocuments({ status: { $in: ['waiting', 'running'] } })}`,
      );
    } catch (error) {
      logger.error('Error recuperandose al arrancar:', error);
    }

    if (this.tickHandle) return;

    this.tickHandle = setInterval(() => {
      this.tick().catch((err) => logger.error('Error en tick:', err));
    }, BOT_CONFIG.tickMs);

    // No bloquea la salida del proceso
    this.tickHandle.unref?.();
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
  }

  /**
   * Devuelve las fichas de las manos interrumpidas.
   * Una mesa en `running` sin motor en memoria es una mesa que el proceso
   * anterior dejo a medias. Los jugadores deben recuperar su dinero.
   */
  private async recoverInterruptedHands(): Promise<number> {
    const stale = await Table.find({
      status: 'running',
      tableId: { $nin: Array.from(this.engines.keys()) },
    });

    for (const table of stale) {
      await this.refundTable(table);
    }

    return stale.length;
  }

  /**
   * Devuelve el buy-in a cada jugador humano de la mesa y la marca como
   * waiting. Es la red de seguridad: preferimos devolver fichas antes que
   * arriesgar a que un jugador pierda saldo por un reinicio.
   *
   * EXCEPCION: las mesas de un campo NO se reembolsan. Su dinero ya no esta en
   * la cartera del jugador sino bloqueado en el campo, y el campo es lo que
   * decide las posiciones. Reembolsar las fichas de una mesa seria devolverle
   * el dinero al jugador y ademas dejarlo jugando en una mesa de un campo que
   * ya no sabe que existe: cobraria el buy-in dos veces.
   *
   * Ante un reinicio con un campo en juego lo correcto es SUSPENDER el campo y
   * que el operador decida si se cancela (con devolucion) o se continua. Por
   * eso la mesa se para en `paused`, que no se procesa en el tick: se queda
   * congelada hasta que alguien la mire.
   */
  private async refundTable(table: ITable): Promise<void> {
    if (this.isFieldTable(table)) {
      table.status = 'paused';
      await table.save();
      logger.warn(
        `Mesa de campo ${table.tableId} pausada tras reinicio. NO se reembolsa: ` +
        `el dinero es del campo. Requiere decision del operador.`,
      );
      return;
    }

    let refunded = 0;

    for (const seat of table.seats) {
      if (seat.kind !== 'human') continue;
      const totalBack = seat.chips + seat.bet;
      if (totalBack <= 0) continue;

      // Regla del producto: en mesa cash, lo que esta en la mesa es saldo real.
      // El saldo de promocion se consumio al comprar la entrada, asi que lo que
      // queda en la mesa al devolver se devuelve a `real`.
      await User.updateOne(
        { telegramId: Number(seat.playerId) },
        { $inc: { 'balance.real': totalBack } },
      );
      refunded++;
    }

    table.seats = [];
    table.status = 'waiting';
    table.hand = {
      handNumber: table.hand.handNumber,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      actingSeat: -1,
      dealerSeat: 0,
    } as any;
    await table.save();

    logger.warn(
      `Mesa ${table.tableId} recuperada tras reinicio. ${refunded} jugadores reembolsados.`,
    );
  }

  // ======================================================================
  // Bucle principal
  // ======================================================================

  private async tick(): Promise<void> {
    const tables = await Table.find({
      status: { $in: ['waiting', 'running'] },
      kind: 'cash',
    }).limit(50);

    for (const table of tables) {
      try {
        await this.processTable(table);
      } catch (error) {
        logger.error(`Error procesando mesa ${table.tableId}:`, error);
      }
    }

    // Los campos se coordinan aparte de las mesas: eliminaciones, merges y
    // liquidacion son del campo entero, no de una mesa. Se hace DESPUES de
    // procesar las mesas, para que las eliminaciones de este ciclo ya esten
    // escritas en la mesa cuando el campo las recoja.
    if (this.fieldCoordinator) {
      try {
        await this.fieldCoordinator();
      } catch (error) {
        logger.error('Error en el ciclo de campos:', error);
      }
    }
  }

  /**
   * El field manager se inyecta desde `bot.ts`.
   *
   * Es una referencia inversa a proposito: el gestor de mesas no importa al
   * gestor de campos, y asi se puede probar uno sin el otro.
   */
  private fieldCoordinator: (() => Promise<void>) | null = null;

  setFieldCoordinator(fn: () => Promise<void>): void {
    this.fieldCoordinator = fn;
  }

  /**
   * Decide que hacer con una mesa en cada ciclo:
   *  - si faltan jugadores y hay sitio, rellena con bots
   *  - si hay mano en curso, comprueba turnos vencidos
   *  - si la mesa esta llena, arranca o continua la mano
   */
  private async processTable(table: ITable): Promise<void> {
    if (table.kind !== 'cash') return;

    const tier = getTier(table.tierId || '');
    const maxSeats = table.maxSeats;

    // --- Rellenar con bots ---
    const humans = table.seats.filter(s => s.kind === 'human').length;
    const bots = table.seats.filter(s => s.kind === 'bot').length;
    const occupied = table.seats.length;

    // Objetivo: mantener una proporcion de bots hasta un tope
    const desiredBots = Math.min(
      BOT_CONFIG.maxBotsPerTable,
      Math.floor(humans * BOT_CONFIG.botRatio) + (humans === 0 ? 4 : 2),
    );

    const needBots =
      occupied < maxSeats && bots < Math.min(desiredBots, maxSeats - occupied);

    if (needBots) {
      const toAdd = Math.min(2, maxSeats - occupied); // gradual, no de golpe
      // El bot entra con el mismo buy-in que la mesa, en unidades internas. Si
      // el bot tuviera mas fichas que los humanos, ganaria por stack depth y no
      // por juego, y el rake de la mesa se distorsionaria hacia el operador
      // pasando por el bot.
      // En un freeroll el buy-in es 0 (no se compra nada): las fichas iniciales
      // son la parte del premio de cada jugador, y el bot entra con la misma
      // parte. Calcularlo ahi, con `targetField`, es lo mismo que hace
      // `seating.service.joinFreeroll`.
      const botChips =
        table.buyInUnits > 0
          ? table.buyInUnits
          : table.smallBlind * 2;
      for (let i = 0; i < toAdd; i++) {
        this.addBotSeat(table, botChips);
      }
      await table.save();
    }

    // --- Avanzar el juego ---
    if (table.hand.phase === 'idle' || table.hand.phase === 'idle-awaiting') {
      // Solo arranca una mano si hay al menos un humano y 2 jugadores
      const activeHumans = table.seats.filter(
        s => s.kind === 'human' && s.status === 'active' && s.chips > 0,
      ).length;

      if (activeHumans >= 1 && table.seats.filter(s => s.status === 'active' && s.chips > 0).length >= 2) {
        await this.startHand(table);
      }
    }

    // --- Turnos vencidos ---
    if (table.hand.phase !== 'idle') {
      await this.checkTurnTimeout(table);
    }
  }

  /** Añade un asiento de bot con buy-in coherente con la mesa. */
  private addBotSeat(table: ITable, buyIn: number): ISeat {
    const profile: BotProfile = botFactory.create();
    const seat: ISeat = {
      index: table.seats.length,
      kind: 'bot',
      playerId: profile.id,
      displayName: profile.name,
      chips: buyIn,
      bet: 0,
      totalBet: 0,
      status: 'active',
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      botProfile: {
        style: profile.style,
        winRate: profile.winRate,
        raiseFreq: profile.raiseFreq,
        foldFreq: profile.foldFreq,
        aggression: profile.aggression,
      },
      handsPlayed: 0,
      handsWon: 0,
      netChips: 0,
      joinedAt: new Date(),
    };

    table.seats.push(seat);
    return seat;
  }

  // ======================================================================
  // Ciclo de una mano
  // ======================================================================

  private async startHand(table: ITable): Promise<void> {
    const activeSeats = table.seats.filter(s => s.status === 'active' && s.chips > 0);
    if (activeSeats.length < 2) return;

    // Limpiar estado de la mano anterior
    for (const seat of table.seats) {
      seat.bet = 0;
      seat.totalBet = 0;
      seat.lastAction = undefined;
      if (seat.chips <= 0) seat.status = 'eliminated';
    }

    // Motor en memoria. `maxSeats` se pasa como tope del motor: sin el, el
    // motor limitaba a 6 jugadores y una mesa de 500 nunca arrancaba.
    const handSeed = Date.now() % 1000000;
    const engine = new PokerGame(
      table.tableId,
      table.smallBlind,
      table.bigBlind,
      table.maxSeats,
    );

    // 7-max: entran todos los activos, sin tandas ni rotaciones. La confusion
    // anterior venia de tratar "campo de 500 participantes" como "500 personas
    // en una mesa"; los campos se coordinan en el field manager (multi-mesa),
    // no aqui.
    const inHand = activeSeats;

    for (const seat of inHand) {
      engine.addPlayer(seat.index.toString(), seat.displayName, seat.chips);
    }

    // Rotacion del boton. `dealerSeat` esta persistido en la mesa para que el
    // boton sobreviva entre manos. En cada mano nueva avanza al siguiente
    // asiento ocupado en sentido horario; si el asiento previo quedo vacio o
    // eliminado, salta al siguiente con fichas. Sin este avance el boton se
    // queda clavado en un asiento, lo que da ventaja permanente a quien lo
    // ocupe y es directamente incorrecto en poker.
    const previousDealer = table.hand.dealerSeat ?? 0;
    const activeIndexes = new Set(inHand.map(s => s.index));

    let dealerSeat = previousDealer;
    for (let hop = 0; hop < table.maxSeats; hop++) {
      dealerSeat = (previousDealer + 1 + hop) % table.maxSeats;
      if (activeIndexes.has(dealerSeat)) break;
    }
    if (!activeIndexes.has(dealerSeat)) {
      dealerSeat = inHand[0].index;
    }
    table.hand.dealerSeat = dealerSeat;

    // `startGame` ordena a los jugadores en el orden en que se le anaden, asi
    // que el indice de posicion del motor no coincide con el numero de
    // asiento. Se busca la posicion del dealer entre los que entran en la mano.
    const dealerPosition = Math.max(
      0,
      inHand.findIndex(s => s.index === dealerSeat),
    );

    if (!engine.startGame(dealerPosition)) {
      logger.error(
        `Mesa ${table.tableId}: la mano no arranca. ` +
        `${inHand.length} jugadores en mano, ${dealerSeat} como boton.`,
      );
      return;
    }

    this.engines.set(table.tableId, { engine, handSeed });

    // Sincronizar estado del motor a la mesa
    table.hand.handNumber += 1;
    table.status = 'running';
    table.hand.phase = 'preflop';
    table.hand.startedAt = new Date();
    table.hand.lastActionAt = new Date();
    table.stats.handsPlayed += 1;

    this.syncEngineToTable(table, engine);

    for (const seat of table.seats) {
      if (engine.getState().players.find(p => p.id === seat.index.toString())) {
        seat.handsPlayed += 1;
      }
    }

    await table.save();
    this.scheduleTurn(table);
  }

  /**
   * Copia el estado volatil del motor a la mesa persistida.
   * La mesa es la fuente de verdad; el motor solo calcula.
   */
  private syncEngineToTable(table: ITable, engine: PokerGame): void {
    const state = engine.getState();

    table.hand.pot = state.pot;
    table.hand.currentBet = state.currentBet;
    table.hand.actingSeat = state.currentPlayerIndex;
    table.hand.dealerSeat = state.dealerIndex;
    table.hand.communityCards = state.communityCards.map(
      c => `${c.rank}|${c.suit}`,
    );
    table.hand.phase = state.phase;

    for (const player of state.players) {
      // El motor identifica al jugador por el string del indice de asiento
      // (lo registramos asi al dar de alta en el motor), no por posicion.
      const seatIndex = parseInt(player.id, 10);
      if (Number.isNaN(seatIndex)) continue;

      const seat = table.seats[seatIndex];
      if (!seat) continue;
      seat.chips = player.chips;
      seat.bet = player.bet;
      seat.totalBet = player.totalBet;
      seat.status = player.folded
        ? 'folded'
        : player.allIn
        ? 'all_in'
        : 'active';
      seat.lastAction = player.lastAction;
      seat.isDealer = player.isDealer;
      seat.isSmallBlind = player.isSmallBlind;
      seat.isBigBlind = player.isBigBlind;
    }
  }

  /**
   * Programa el siguiente turno.
   * Si es un bot, se programa con una demora humana (para que no actue
   * instantaneamente). Si es humano, se espera su decision via API.
   */
  private scheduleTurn(table: ITable): void {
    const existing = this.turnTimers.get(table.tableId);
    if (existing) {
      clearTimeout(existing);
      this.turnTimers.delete(table.tableId);
    }

    const engineState = this.engines.get(table.tableId);
    if (!engineState) return;

    const { engine } = engineState;
    const state = engine.getState();

    if (state.phase === 'finished' || state.phase === 'showdown') {
      this.finishHand(table, engine).catch((e) => logger.error(e));
      return;
    }

    // Solo hay un "turno real" en las calles de apuesta. En `waiting` (y en
    // `idle`) el `currentPlayerIndex` del motor es un valor por defecto, sin
    // significancia: actuar sobre el haria que un bot juegue solo y que se
    // mande un aviso de turno fantasma al humano del asiento 0.
    if (!ACTION_PHASES.has(state.phase)) return;

    const actingIndex = state.currentPlayerIndex;
    const seat = table.seats.find(s => s.index === actingIndex);

    if (!seat) return;

    if (seat.kind === 'bot') {
      const delay =
        BOT_CONFIG.minThinkMs +
        Math.random() * (BOT_CONFIG.maxThinkMs - BOT_CONFIG.minThinkMs);

      const timer = setTimeout(() => {
        this.playBotTurn(table).catch((e) => logger.error('Error bot turn:', e));
      }, delay);
      timer.unref?.();
      this.turnTimers.set(table.tableId, timer);
      return;
    }

    // Si es humano no se programa nada: el turno se resuelve cuando llama a la
    // API, o por timeout cuando el tick lo detecta. Si solo esta esperando
    // (no le toca), no se avisa a nadie.
    this.notifyHumanTurn(table, seat);
  }

  /**
   * Envia el aviso de turno al jugador humano que tiene la palabra.
   * Se deduplica por turno: un mismo asiento en la misma calle con la misma
   * marca de tiempo solo recibe un aviso.
   */
  private notifyHumanTurn(table: ITable, seat: ISeat): void {
    if (!this.notifier) return;

    const entry = this.engines.get(table.tableId);
    if (!entry) return;

    const state = entry.engine.getState();
    const player = state.players.find(p => p.id === seat.index.toString());
    if (!player) return;

    // Un jugador que ya abando, esta all-in o se quedo sin fichas ya no tiene
    // decision pendiente. Avisarle seria pedirle algo que no puede hacer.
    if (player.folded || player.allIn || player.chips <= 0) return;

    const stamp = table.hand.lastActionAt
      ? new Date(table.hand.lastActionAt).getTime()
      : 0;
    const key = `${table.tableId}:${table.hand.handNumber}:${seat.index}:${state.phase}:${stamp}`;

    if (this.turnNotified.has(key)) return;
    this.turnNotified.add(key);

    // Poda: el conjunto crece con cada turno de cada mesa. Sin esto, un
    // servidor con vida larga acabaria comiendose la memoria.
    if (this.turnNotified.size > 2000) {
      this.turnNotified = new Set(Array.from(this.turnNotified).slice(-1000));
    }

    const notice: TurnNotice = {
      telegramId: Number(seat.playerId),
      tableId: table.tableId,
      seatIndex: seat.index,
      phase: state.phase,
      toCall: Math.max(0, state.currentBet - player.bet),
      chips: player.chips,
      pot: state.pot,
      cards: player.cards.map(c => ({ rank: c.rank, suit: c.suit })),
      deadlineMs: TURN_TIMER.humanMs,
    };

    Promise.resolve(this.notifier(notice)).catch((e) =>
      logger.error('Error enviando aviso de turno:', e),
    );
  }

  /** Hace actuar al bot del turno actual. */
  private async playBotTurn(table: ITable): Promise<void> {
    const entry = this.engines.get(table.tableId);
    if (!entry) return;

    const { engine } = entry;
    const state = engine.getState();
    const seat = table.seats.find(s => s.index === state.currentPlayerIndex);

    if (!seat || seat.kind !== 'bot') {
      this.scheduleTurn(table);
      return;
    }

    const playerState = engine.getPlayerState(seat.index.toString());
    if (!playerState) {
      this.scheduleTurn(table);
      return;
    }

    // Cartas del bot desde el motor
    const botPlayer = state.players.find(p => p.id === seat.index.toString());
    if (!botPlayer) return;

    const community = state.communityCards;
    const hand = botPlayer.cards;

    const profile: BotProfile = {
      id: seat.playerId,
      name: seat.displayName,
      style: (seat.botProfile?.style as any) || 'calling',
      winRate: seat.botProfile?.winRate ?? 0.45,
      raiseFreq: seat.botProfile?.raiseFreq ?? 0.2,
      foldFreq: seat.botProfile?.foldFreq ?? 0.3,
      aggression: seat.botProfile?.aggression ?? 0.3,
    };

    const activePlayers = state.players.filter(p => !p.folded).length;

    const decision = decideAction({
      hand,
      community,
      potSize: state.pot,
      toCall: Math.max(0, state.currentBet - botPlayer.bet),
      chips: botPlayer.chips,
      profile,
      position: seat.index,
      playersLeft: activePlayers,
    });

    engine.performAction(seat.index.toString(), decision.action, decision.amount);

    this.syncEngineToTable(table, engine);
    table.hand.lastActionAt = new Date();
    await table.save();

    this.scheduleTurn(table);
  }

  /**
   * Detecta turnos vencidos de humanos y hace actuar al bot en su lugar.
   * Evita que una mesa quede congelada porque alguien cerro la app.
   */
  private async checkTurnTimeout(table: ITable): Promise<void> {
    const entry = this.engines.get(table.tableId);
    if (!entry) return;

    const { engine } = entry;
    const state = engine.getState();

    if (state.phase === 'finished') {
      await this.finishHand(table, engine);
      return;
    }

    const lastAction = table.hand.lastActionAt
      ? new Date(table.hand.lastActionAt).getTime()
      : 0;
    const elapsed = Date.now() - lastAction;

    const seat = table.seats.find(s => s.index === state.currentPlayerIndex);
    if (!seat || seat.kind !== 'human') return;

    if (elapsed < TURN_TIMER.humanMs) return;

    // Tiempo agotado: pasar (check si no debe, fold si debe)
    const toCall = Math.max(0, state.currentBet - (seat.bet || 0));
    if (toCall === 0) {
      engine.performAction(seat.index.toString(), 'check');
    } else {
      engine.performAction(seat.index.toString(), 'fold');
    }

    logger.info(
      `Turno expirado en mesa ${table.tableId}, asiento ${seat.index}. acted=auto`,
    );

    this.syncEngineToTable(table, engine);
    table.hand.lastActionAt = new Date();
    await table.save();
    this.scheduleTurn(table);
  }

  /** Cierra la mano: reparte el bote, cobra rake y limpia para la siguiente. */
  private async finishHand(table: ITable, engine: PokerGame): Promise<void> {
    const state = engine.getState();

    // Limpiar timer
    const timer = this.turnTimers.get(table.tableId);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(table.tableId);
    }

    // --- Rake ---
    let rake = 0;
    if (table.kind === 'cash' && state.pot >= RAKE.minPot) {
      rake = Math.min(
        Math.floor((state.pot * RAKE.cashPercentage) / 100),
        RAKE.cashMax,
      );
      table.stats.rakeCollected += rake;

      // El rake de las mesas de un campo se acumula ahi. Lo necesita el field
      // manager para calcular el bote neto del campo: si no, creeria que el
      // bote es el bruto y pagaria de mas.
      if (this.isFieldTable(table) && table.field?.fieldId) {
        await Field.updateOne(
          { fieldId: table.field.fieldId },
          { $inc: { rakeCollected: rake } },
        );
      }
    }

    const netPot = state.pot - rake;

    // --- Reparto ---
    const winners = state.winners || [];
    const shareEach = winners.length > 0 ? Math.floor(netPot / winners.length) : 0;

    for (const winner of winners) {
      const seatIndex = parseInt(winner.playerId, 10);
      const seat = table.seats.find(s => s.index === seatIndex);
      if (!seat) continue;

      seat.chips += shareEach;
      seat.handsWon += 1;
      seat.netChips += shareEach;
      // Sincronizar con el saldo real del usuario
      if (seat.kind === 'human') {
        await this.settleHumanSeat(table, seat, shareEach);
      }
    }

    // Quitar jugadores que se quedaron sin fichas.
    // El buy-in ya se desconto del wallet al sentarse, asi que perderlo en la
    // mesa no requiere otro descuento: simplemente se marca eliminado.
    for (const seat of table.seats) {
      if (seat.chips <= 0 && seat.status !== 'eliminated') {
        seat.status = 'eliminated';
      }
    }

    // --- Reiniciar el ciclo ---
    this.engines.delete(table.tableId);
    table.hand.phase = 'idle';
    table.hand.pot = 0;
    table.hand.currentBet = 0;
    table.hand.communityCards = [];
    table.hand.actingSeat = -1;
    table.hand.lastActionAt = undefined;

    // Barajar dealer
    this.rotateDealer(table);

    // ------------------------------------------------------------------
    // CAMPO vs MESA CASH
    // ------------------------------------------------------------------
    // Abajo hay dos caminos distintos y la diferencia no es cosmetica.
    //
    // MESA CASH (sin `field`): al cerrar la mano, las fichas vuelven al
    // monedero y el jugador vuelve a comprar si le alcanza. Se entra y se sale
    // cuando uno quiere. Es una mesa de cash normal.
    //
    // MESA DE CAMPO (con `field.fieldId`): las fichas NO vuelven al monedero.
    // El buy-in se cobro una vez al registrarse y queda bloqueado hasta que el
    // jugador es eliminado o gana el campo. Si devolvieran el saldo cada mano,
    // un "campo de 500" serian 500 partidas sueltas de una mesa de 7: no habria
    // ni eliminaciones, ni posiciones, ni mesa final.
    //
    // Quien decide cuando se devuelve el dinero es `field.manager.ts`, que
    // conoce las posiciones. Aqui solo se marca al jugador como eliminado y se
    // le deja el resto de fichas para que el campo lo liquide.

    if (this.isFieldTable(table)) {
      // Los bots eliminados se van. Los humanos se quedan con su estado para
      // que el field manager recoja la eliminacion y le asigne posicion.
      table.seats = table.seats.filter(
        s => s.status !== 'eliminated' || s.kind === 'human',
      );

      // Un humano sin fichas queda `eliminated`: es una posicion en el campo.
      for (const seat of table.seats) {
        if (seat.kind === 'human' && seat.chips <= 0 && seat.status !== 'eliminated') {
          seat.status = 'eliminated';
        }
      }

      await table.save();
      return;
    }

    // --- Mesa cash: el flujo de siempre ---
    // Los bots eliminados se van; los humanos se conservan para decidir
    table.seats = table.seats.filter(
      s => s.status !== 'eliminated' || s.kind === 'human',
    );

    // Evaluar humanos: si ya no alcanzan el buy-in minimo, se retiran y se les
    // devuelve lo que queda en la mesa (que en cash es saldo real).
    const stillPlaying: ISeat[] = [];
    for (const seat of table.seats) {
      if (seat.kind !== 'human') {
        stillPlaying.push(seat);
        continue;
      }

      if (seat.chips > 0) {
        await User.updateOne(
          { telegramId: Number(seat.playerId) },
          { $inc: { 'balance.real': seat.chips } },
        );
        seat.chips = 0;
      }

      // ¿Sigue pudiendo comprar entrada para la siguiente mano? El umbral es el
      // buy-in de la mesa. Si no alcanza, se retira y se le queda lo que tenia.
      //
      // Esto es de MESA CASH suelta. En un campo (rama de arriba) el jugador no
      // vuelve a comprar: su_stack vive hasta que lo eliminan.
      const user = await User.findOne({ telegramId: Number(seat.playerId) });
      const available = user ? user.balance.real + user.balance.play : 0;
      if (available >= table.buyInUnits) {
        seat.status = 'active';
        stillPlaying.push(seat);
      }
    }
    table.seats = stillPlaying;

    // Si no quedan humanos, la mesa se vacia y vuelve a esperar
    const humansLeft = table.seats.filter(s => s.kind === 'human').length;
    if (humansLeft === 0) {
      table.status = 'waiting';
      table.seats = [];
    }

    await table.save();
  }

  /**
   * Si la mesa pertenece a un campo multi-mesa.
   *
   * El criterio es `field.fieldId` Y que el campo este vivo. Una mesa de un
   * campo ya liquidado tiene que volver al comportamiento cash: si se quedaba
   * en modo torneo, las fichas de sus jugadores se quedarian bloqueadas para
   * siempre.
   */
  isFieldTable(table: ITable): boolean {
    return Boolean(table.field?.fieldId);
  }

  /**
   * Sincroniza el saldo de un humano tras ganar.
   * El dinero que gana en la mesa es retirable (viene de mesas cash con buy-in
   * de saldo real), salvo que la mesa sea freeroll.
   *
   * EXCEPCION DEL CAMPO: en una mesa de campo NO se abona aqui. Las fichas se
   * quedan en el asiento (suben a `seat.chips`) y el `field.manager` las
   * liquida al final. Si se abonaran al monedero en cada mano, el jugador
   * tendria su dinero en la cartera mientras sigue sentado, y podria
   * reiniciarse el servicio y perder el saldo de la mesa sin que nadie lo
   * supiera.
   */
  private async settleHumanSeat(
    table: ITable,
    seat: ISeat,
    amount: number,
  ): Promise<void> {
    if (this.isFieldTable(table)) return;

    const field = table.kind === 'freeroll' ? 'balance.play' : 'balance.real';
    await User.updateOne(
      { telegramId: Number(seat.playerId) },
      { $inc: { [field]: amount } },
    );
  }

  private rotateDealer(table: ITable): void {
    if (table.seats.length === 0) {
      table.hand.dealerSeat = 0;
      return;
    }
    table.hand.dealerSeat = (table.hand.dealerSeat + 1) % table.seats.length;
  }

  /**
   * Aplica una accion de un jugador humano.
   *
   * Es el unico punto por el que la Mini App modifica el estado de una mano,
   * junto con el bot. Centralizarlo aqui garantiza que humano y bot siguen
   * exactamente el mismo camino: validar, ejecutar en el motor, sincronizar,
   * persistir y programar el siguiente turno.
   */
  async applyHumanAction(
    table: ITable,
    seatIndex: number,
    action: 'fold' | 'check' | 'call' | 'raise' | 'all_in',
    amount?: number,
  ): Promise<boolean> {
    const entry = this.engines.get(table.tableId);
    if (!entry) return false;

    const { engine } = entry;

    const applied = engine.performAction(seatIndex.toString(), action, amount);
    if (!applied) return false;

    this.syncEngineToTable(table, engine);
    table.hand.lastActionAt = new Date();
    await table.save();

    // Si la mano termino, liquidar
    const state = engine.getState();
    if (state.phase === 'finished' || state.phase === 'showdown') {
      await this.finishHand(table, engine);
    } else {
      this.scheduleTurn(table);
    }

    return true;
  }

  // ======================================================================
  // API publica
  // ======================================================================

  /** Lista de mesas disponibles para el lobby. */
  async listTables(): Promise<any[]> {
    const tables = await Table.find({
      status: { $in: ['waiting', 'running'] },
    })
      .sort({ kind: 1, tierId: 1 })
      .limit(60);

    return tables.map(t => ({
      tableId: t.tableId,
      kind: t.kind,
      tierId: t.tierId,
      prizeTier: t.prizeTier,
      status: t.status,
      // Todo en USDT para la UI. Internamente son unidades (ver config/units).
      smallBlind: unitsToUsdt(t.smallBlind),
      bigBlind: unitsToUsdt(t.bigBlind),
      buyIn: unitsToUsdt(t.buyInUnits),
      maxSeats: t.maxSeats,
      occupied: t.seats.length,
      humans: t.seats.filter(s => s.kind === 'human').length,
      bots: t.seats.filter(s => s.kind === 'bot').length,
      pot: t.hand.pot,
      phase: t.hand.phase,
      handNumber: t.hand.handNumber,
      rakeCollected: t.stats.rakeCollected,
      prizePaid: t.stats.prizePaid,
    }));
  }

  /** Vista publica de una mesa para un jugador concreto. */
  async getPublicTable(tableId: string, viewerTelegramId?: number) {
    const table = await Table.findOne({ tableId });
    if (!table) return null;

    const viewerSeat =
      viewerTelegramId !== undefined
        ? table.seats.find(s => s.kind === 'human' && s.playerId === String(viewerTelegramId))?.index
        : undefined;

    return toPublicTable(table, viewerSeat);
  }

  /** Vista de la mesa incluyendo las cartas propias del jugador. */
  async getPlayerView(tableId: string, telegramId: number) {
    const table = await Table.findOne({ tableId });
    if (!table) return null;

    const seat = table.seats.find(
      s => s.kind === 'human' && s.playerId === String(telegramId),
    );
    if (!seat) return null;

    const entry = this.engines.get(tableId);
    const view = toPublicTable(table, seat.index) as any;

    if (entry) {
      const playerState = entry.engine.getPlayerState(seat.index.toString());
      if (playerState?.myCards) {
        view.myCards = playerState.myCards.map((c: any) => ({
          rank: c.rank,
          suit: c.suit,
        }));
      }
      view.isMyTurn = entry.engine.getState().currentPlayerIndex === seat.index;
    } else {
      view.myCards = [];
      view.isMyTurn = false;
    }

    view.turnEndsAt = table.hand.lastActionAt
      ? new Date(
          new Date(table.hand.lastActionAt).getTime() + TURN_TIMER.humanMs,
        ).toISOString()
      : null;

    return view;
  }

  /** Verifica que el jugador tiene saldo suficiente para sentarse. */
  async canAfford(telegramId: number, minBuyIn: number): Promise<{
    ok: boolean;
    reason?: string;
    real?: number;
    play?: number;
  }> {
    const user = await User.findOne({ telegramId });
    if (!user) return { ok: false, reason: 'Usuario no encontrado' };

    const total = user.balance.real + user.balance.play;
    if (total < minBuyIn) {
      return {
        ok: false,
        reason: `Necesitas ${minBuyIn} CUP para esta mesa. Tienes ${total}.`,
        real: user.balance.real,
        play: user.balance.play,
      };
    }

    return { ok: true, real: user.balance.real, play: user.balance.play };
  }
}

export const tableManager = new TableManager();
