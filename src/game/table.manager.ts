import { Table, ITable, ISeat, toPublicTable } from '../models/Table';
import { Field } from '../models/Field';
import { unitsToUsdt, formatUnits } from '../config/units';
import { User } from '../models/User';
import { PokerGame } from './game.state';
import { botFactory, BotProfile, decideAction, mulberry32 } from './bot.engine';
import { TABLE_TIERS, TABLE_TIER_LIST, BOT_CONFIG, RAKE, TURN_TIMER, getTier } from '../config/product';
import { markShuttingDown, shutdownFieldManager } from './field.manager';
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
   * Se pone durante el apagado ordenado. Un `tick()` que compruebe esta marca no
   * empieza a trabajar, asi que el motor se queda quieto en lugar de competir con
   * el apagado por las escrituras.
   */
  private stopping = false;

  /**
   * Cuantos `tick()` estan corriendo ahora mismo.
   *
   * El contador lo incrementa el propio tick al entrar y lo decrementa en un
   * `finally`, con lo que un tick que lance excepcion tambien cuenta como
   * terminado. Sin el `finally`, un error dejaria el contador alto para siempre y
   * el apagado esperaria al tope de tiempo en cada despliegue.
   */
  private activeTicks = 0;

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
    // Por si el proceso se reinicia dentro del mismo contenedor (Render lo hace
    // en algunos despliegues): sin esto, arrancaria con el motor marcado como
    // parado y cada tick se saldria sin hacer nada.
    this.stopping = false;

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
      // No solapar ticks. Si el anterior sigue corriendo (una mesa lenta, una
      // operacion de Mongo), este se salta en vez de arrancar en paralelo.
      // Dos ticks a la vez sobre la misma mesa reparten el pot dos veces.
      if (this.activeTicks > 0 || this.stopping) return;

      this.activeTicks++;
      this.tick()
        .catch((err) => logger.error('Error en tick:', err))
        .finally(() => {
          this.activeTicks--;
        });
    }, BOT_CONFIG.tickMs);

    // No bloquea la salida del proceso
    this.tickHandle.unref?.();
  }

  /**
   * Quien tiene el turno, resuelto BIEN.
   *
   * ------------------------------------------------------------------
   * EL BUG MAS SILENCIOSO DEL MOTOR
   *
   * `GameState.currentPlayerIndex` es un indice dentro de `state.players`, que es la
   * lista de jugadores QUE ENTRAN EN ESTA MANO. NO es un indice de asiento de la mesa.
   *
   * `startHand` anade solo los asientos activos:
   *
   *   for (const seat of inHand) engine.addPlayer(seat.index.toString(), ...)
   *
   * Asi que si los asientos activos son el 0, 3, 4 y 5, la lista del motor queda
   * [0, 3, 4, 5] y `currentPlayerIndex === 1` significa el asiento 3, no el asiento 1.
   *
   * El codigo hacia `table.seats.find(s => s.index === state.currentPlayerIndex)`, que
   * confunde las dos cosas. Solo coincide cuando los asientos activos son contiguos
   * desde el 0, o sea, al principio de la vida de una mesa. En cuanto alguien se
   * elimina y deja un hueco, la resolucion empieza a dar jugadores equivocados.
   *
   * El sintoma era un congelamiento total del campo: el motor creia que le tocaba a
   * un asiento `out` (ya liquidado) cuando en realidad le tocaba a uno activo, lo
   * pliegaba, y se quedaba esperando a un jugador al que nadie iba a llamar. Mesas
   * con `preflop` y `acting` apuntando a un asiento ya liquidado, sin error ni
   * excepcion ni timeout. Se encontro jugando un campo entero de verdad con el motor
   * (`scripts/test-e2e-engine.js`).
   *
   * Y peor que un bloqueo: un pliego equivocado hace perder fichas a un jugador que
   * no habia plegado. No era solo un congelamiento, era tambien un robo de fichas.
   *
   * Este helper es el UNICO sitio donde se resuelve el asiento del turno. Si vuelve a
   * aparecer un `seats.find(s => s.index === currentPlayerIndex)`, es un bug.
   */
  private resolveActingSeat(table: ITable, engine: PokerGame): ISeat | null {
    const state = engine.getState();
    const player = state.players[state.currentPlayerIndex];
    if (!player) return null;
    return table.seats.find(s => s.index === parseInt(player.id, 10)) ?? null;
  }

/** Detiene los timers. Sincrono: se llama en varios sitios, incluidos tests. */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
  }

  /**
   * Detiene el motor y espera a que termine lo que ya estaba en vuelo.
   *
   * ------------------------------------------------------------------
   * POR QUE NO BASTA CON `stop()`
   *
   * `stop()` limpia los timers, pero un `tick()` que ya estaba corriendo sigue
   * escribiendo en Mongo. Si el proceso muere en ese instante, la escritura
   * queda a medias: una mesa con las fichas de los jugadores sin el pot, o un
   * campo al que se le ha descontado un contador sin adjudicar la posicion.
   *
   * Eso es exactamente el estado que `recoverInterruptedHands()` existe para
   * limpiar, pero limpiarlo cuesta un reinicio y una revision manual. Es mejor no
   * dejarlo.
   *
   * Por eso `stop()` sigue siendo sincrono (se llama en varios sitios, incluidos
   * tests) y este metodo es el que se usa al apagar el proceso: marca
   * `stopping` para que ningun tick nuevo empiece, espera a los que estan en
   * curso, y despues limpia.
   *
   * @param timeoutMs  techo de espera. Pasado el plazo se sale igual: es mejor un
   *                   reinicio con estado a medias que no terminar nunca.
   */
  async shutdown(timeoutMs = 6000): Promise<void> {
    // Marca de parada: `tick()` lo comprueba y no hace nada si esta puesto. Sin
    // esto, un tick que terminase ahora mismo volveria a programar el siguiente.
    this.stopping = true;

    const deadline = Date.now() + timeoutMs;

    // Espera a los ticks en vuelo. Se sondea en vez de usar un contador porque un
     // tick puede anadir otros (un merge de campo llama a otro), y un contador
    // se quedaria en cero antes de que terminen.
    while (this.activeTicks > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.activeTicks > 0) {
      logger.warn(
        `Apagado: ${this.activeTicks} tick(s) sin terminar tras ${timeoutMs}ms. ` +
        'Se para igualmente. Puede haber escrituras a medias.',
      );
    }

    this.stop();

    const paused = await Table.countDocuments({ status: 'paused' });
    const running = await Table.countDocuments({
      status: { $in: ['waiting', 'running'] },
    });

    if (running > 0) {
      logger.info(
        `Apagado ordenado: ${running} mesa(s) sin liquidar. ` +
        (paused > 0
          ? `${paused} de campo ya pausadas: requieren decision del operador.`
          : 'Se reintentara al arrancar de nuevo.'),
      );
    }
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

    // ------------------------------------------------------------------
    // UNA MESA DE CAMPO YA ARRANCADA NO RECIBE MAS BOTS
    //
    // Antes no habia ninguna comprobacion, y el campo no terminaba nunca.
    //
    // Cuando un bot caia, `finishHand` lo quita de la mesa y en el siguiente ciclo
    // `needBots` volvia a ser cierto, asi que entraba un bot NUEVO con las fichas
    // enteras. Los humanos solo tenian que ganar contra un rival recien nacido, y
    // como siempre ganaban, ninguno se eliminaba jams. El campo se quedava con
    // once vivos para siempre y ningun campo podia terminar.
    //
    // Se comprobo jugando un campo entero: 4 000 rondas, once vivos constantes,
    // tres eliminados y ni uno ms. Con 300 jugadores, 43 mesas, esto es un producto
    // que no acaba nunca y bloquea el dinero de todos en el campo.
    //
    // El bots siguen rellenando huecos mientras el campo se ESTA LLENANDO, que es
    // justo cuando hacen falta. Una vez que arranca, la plantilla esta cerrada:
    // los que no entraron no entran, y los que entraron no se van hasta que ganan
    // oUntil que se les elimina.
    const esCampoArrancado =
      this.isFieldTable(table) &&
      (table.field?.fieldStatus === 'running' || table.field?.fieldStatus === 'final');

    const desiredBots = Math.min(
      BOT_CONFIG.maxBotsPerTable,
      Math.floor(humans * BOT_CONFIG.botRatio) + (humans === 0 ? 4 : 2),
    );

    const needBots =
      !esCampoArrancado &&
      occupied < maxSeats &&
      bots < Math.min(desiredBots, maxSeats - occupied);

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
    //
    // ------------------------------------------------------------------
    // CUANDO HAY CON QUE JUGAR Y LA MANO NO ARRANCA
    //
    // Es el fallo silencioso de este proyecto. Todo lo demas funciona: el motor esta
    // bien, el rake se cobra, las posiciones se adjudican. Y aun asi la mesa se queda
    // sin jugar, con los jugadores sentados y sus fichas quietas, sin que nada en el log
    // lo senale.
    //
    // Se vio con 3 jugadores vivos y 11 921 fichas en la mesa final de un campo, tres
    // mil rondas sin que se moviera una sola ficha. El test lo decia ("motor=NO") pero
    // el log de produccion no decia nada, y sin este aviso no habria forma de saber
    // por donde mirar.
    //
    // El aviso lleva los tres numeros que Contestan la pregunta: si es la fase, no hay
    // por que mirar; si son los jugadores, no hay con que jugar.
    // ------------------------------------------------------------------
    if (table.hand.phase === 'idle' || table.hand.phase === 'idle-awaiting') {
      // Solo arranca una mano si hay al menos un humano y 2 jugadores
      const activeHumans = table.seats.filter(
        s => s.kind === 'human' && s.status === 'active' && s.chips > 0,
      ).length;
      const activeTotal = table.seats.filter(
        s => s.status === 'active' && s.chips > 0,
      ).length;

      if (activeHumans >= 1 && activeTotal >= 2) {
        await this.startHand(table);

        // Se comprueba DESPUES de intentarlo, porque `startHand` puede volver sin hacer
        // nada: si el motor no arranca, tira el motor que acaba de crear y no lanza
        // nada. Es exactamente el caso que hay que ver, asi que se pregunta a la mesa
        // y no a una excepcion.
        if (!this.engines.has(table.tableId)) {
          logger.error(
            `Mesa ${table.tableId}: NO ARRANCA LA MANO con ${activeTotal} jugadores ` +
            `activos (${activeHumans} humanos) y ${table.maxSeats} asientos. ` +
            `Fase "${table.hand.phase}", estado "${table.status}". ` +
            'Los jugadores siguen sentados y el campo no avanza. Hay que mirar ' +
            'startHand: si startGame devuelve false, el motor se crea y se tira.',
          );
        }
      }
    }

    // --- Turnos vencidos ---
    if (table.hand.phase !== 'idle') {
      await this.checkTurnTimeout(table);
    }
  }

  /** Anade un asiento de bot con buy-in coherente con la mesa. */
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

    // ------------------------------------------------------------------
    // `status` DE LOS ASIENTOS VUELVE A `active` ANTES DE ESTA COMPROBACION
    //
    // `finishHand` deja los asientos en el estado en que acabaron la mano:
    // `folded`, `called`, `betting`... Que son estados TERMINALES de una mano, no
    // del jugador. Sin volver a ponerlos en `active`, la comprobacion de
    // `activeSeats` ve menos de dos jugadores activos y no arranca NUNCA una
    // segunda mano.
    //
    // El efecto en el campo era que cada mesa jugaba exactamente una mano y se
    // congelaba: nadie se eliminaba, nadie ganaba, el campo no terminaba nunca. Con
    // 300 jugadores y 43 mesas el producto se quedaba colgado para siempre.
    //
    // No se puede ver leyendo: el motor funciona, el rake se cobra, las
    // eliminaciones se adjudican. Solo falta el paso de una mano a la siguiente. Lo
    // encontro el test end-to-end del motor (`scripts/test-e2e-engine.js`).
    //
    // El reset principal esta en `finishHand`, que es donde la mano se cierra y
    // donde el estado tiene que quedar coherente para cualquier cosa que lea la
    // mesa entre manos. Aqui se repite por si una mesa llegara aqui con estados
    // sueltos (por ejemplo, tras un reinicio a medias).
    //
    // `eliminated` y `out` NO se tocan: son estados ya resueltos. El field manager
    // depende de `eliminated` para adjudicar la posicion del jugador, y `out` es
    // con el que se marca a los liquidados para no volver a contarlos.
    for (const seat of table.seats) {
      seat.bet = 0;
      seat.totalBet = 0;
      seat.lastAction = undefined;

      // EL ORDEN IMPORTA: out SE RESPETA SIEMPRE.
      if (seat.status === 'out') continue;
      if (seat.chips <= 0) seat.status = 'eliminated';
      else if (seat.status !== 'eliminated') seat.status = 'active';
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

      // ------------------------------------------------------------------
      // SE BUSCA POR `index`, NO POR POSICION EN EL ARRAY. ESTO NO ES UN DETALLE.
      //
      // Antes era `table.seats[seatIndex]`, o sea, "el asiento que ocupa la
      // posicion `seatIndex` del array". Funciona SOLO mientras `seats[i].index === i`
      // para todo `i`, es decir, mientras no se haya liberado ningun asiento.
      //
      // En cuanto `finishHand` quita un asiento `out`, el array se desplaza y
      // `seats[3]` ya no es el asiento 3. Entonces el motor escribia las fichas y el
      // estado de un jugador SOBRE OTRO, que es a la vez:
      //
      //   - Un robo de fichas: el jugador A perdia lo que tenia y se lo ponia a B.
      //   - Una resurreccion de estados: `seat.status` se reescribia a
      //     `active`/`folded` sobre asientos que estaban `eliminated` u `out`, asi
      //     que los eliminados volvian a la mesa y sus puestos nunca se liberaban.
      //
      // El efecto observado era el campo entero atascado: mesas que no se terminaban
      // nunca, con eliminados que reaparecian y los sitios ocupados.
      //
      // `find` sobre `index` es el unico acceso correcto. Con 7 asientos por mesa el
      // coste es irrelevante, y con las mesas de un campo tampoco lo es.
      const seat = table.seats.find(s => s.index === seatIndex);
      if (!seat) continue;

      // Un asiento ya liquidado (`out`) no se resucita. Es terminal: el field manager
      // ya le adjudico la posicion y cobro sus fichas del bote. Volverlo a poner en
      // `active` lo devuelve a la mesa con cero fichas y hace que el motor espere un
      // turno suyo para siempre.
      if (seat.status === 'out') continue;

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

    const seat = this.resolveActingSeat(table, engine);

    if (!seat) return;

    // ------------------------------------------------------------------
    // UN ASIENTO `out` NO JUEGA
    //
    // El field manager marca `out` al asiento de un jugador que ya tiene posicion
    // adjudicada, y lo hace aunque la mano este en curso, porque esperar a que la
    // mano terminase no sirve: una mesa esta casi siempre jugando, y el asiento
    // ocupaba plaza para siempre, con lo que las merges no ocurrian nunca.
    //
    // El problema es que el motor ya tiene a ese jugador en la mano y le toca. Si no
    // se hace nada, la mesa se queda esperando a alguien a quien nadie va a jugar:
    // `currentPlayerIndex` apunta al asiento, `out` significa "ya liquidado", y no
    // hay ninguna accion pendiente. La mesa espera para siempre, sin error en ningun
    // log ni excepcion ni timeout.
    //
    // Se vio con dos mesas congeladas en `preflop` con `acting=3` y el asiento 3 en
    // `out`.
    //
    // AQUI NO SE RESCHEDULEA, Y ES LO IMPORTANTE. Si tras plegar se volviera a llamar
    // a `scheduleTurn`, y el asiento siguiente tambien estuviera `out`, se encadenan
    // llamadas. Y si el `fold` lo rechaza (jugador ya folded, o con cero fichas), el
    // `currentPlayerIndex` no cambia y la recursion no termina: `RangeError: Maximum
    // call stack size exceeded`. Ya paso.
    //
    // Se pliega y se devuelve. El turno lo Scheride el siguiente ciclo, en
    // `checkTurnTimeout`, que tiene el mismo guard y no se llama a si mismo. Asi el
    // avance es por ticks y no por pila.
    //
    // Tampoco se guarda aqui, por el mismo motivo de antes: `save()` desde un
    // `scheduleTurn` sincrono y encadenado dispara `ParallelSaveError`. El estado se
    // persiste en `processTable` y en `checkTurnTimeout`.
    // ------------------------------------------------------------------
    if (seat.status === 'out') {
      engine.performAction(seat.index.toString(), 'fold');
      this.syncEngineToTable(table, engine);
      table.hand.lastActionAt = new Date();

      logger.info(
        `Mesa ${table.tableId}: el asiento ${seat.index} ya estaba liquidado ` +
        '(out). Se pliega para no bloquear la mano.',
      );
      return;
    }

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
    const seat = this.resolveActingSeat(table, engine);

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

    // ------------------------------------------------------------------
    // SI EL MOTOR RECHAZA LA ACCION, HAY QUE RECUPERAR LA MANO
    //
    // Antes se llamaba a `performAction` y se ignoraba lo que devolviera. Y el motor
    // puede rechazar: si la IA decide subir y no hay subida legal (porque el minimo del
    // motor es mayor que las fichas del bot, o porque la subida ya no cubre el minimo de
    // re-subida), `performAction` devuelve false, el bot NO actúa, y `scheduleTurn` le
    // vuelve a programar con el turno sigue siendo suyo.
    //
    // El bot vuelve a decidir lo mismo, el motor vuelve a rechazar, y la mesa se queda
    // congelada CON LA MANO EN CURSO. Sin error, sin aviso, sin nada en el log. Y como
    // `checkTurnTimeout` sale temprano para los que no son humanos, no hay ni un
    // temporizador que la saque de ahi.
    //
    // Se ha visto: una mano que se paraba en la mano 19, con un bot de 51 fichas
    //经典的 `accion rechazada: raise` que la IA proposed y el motor no acepto.
    //
    // Por eso no basta con mirar el resultado: si ninguna accion legal funciona, hay
    // que decirlo con nivel ERROR y planes para que la mesa no se quede colgada.
    // ------------------------------------------------------------------
    const aplicadas = engine.performAction(
      seat.index.toString(),
      decision.action,
      decision.amount,
    );

    if (!aplicadas) {
      // Se prueban las alternativas de mayor a menor. Todas son legales siempre:
      // `all_in` no tiene limite, `check` cuando no hay que igualar, `fold` siempre.
      // Con esto el bot juega SIEMPRE, y la diferencia entre "ha jugado como el quiere"
      // y "ha jugado por no quedarse parado" esSecondary, no es un problema.
      const alternativas: Array<['all_in' | 'call' | 'check' | 'fold', number | undefined]> = [
        ['all_in', undefined],
        ['check', undefined],
        ['call', undefined],
        ['fold', undefined],
      ];

      let recuperada = false;
      for (const [accion, importe] of alternativas) {
        if (engine.performAction(seat.index.toString(), accion, importe)) {
          logger.warn(
            `Mesa ${table.tableId}: el bot del asiento ${seat.index} decidio ` +
            `${decision.action}${decision.amount ? ' de ' + decision.amount : ''} y el ` +
            `motor la rechazo. Ha jugado ${accion} en su lugar.`,
          );
          recuperada = true;
          break;
        }
      }

      if (!recuperada) {
        // No hay ninguna accion que el motor acepte. La mesa no puede seguir con este
        // bot dentro, asi que se cierra la mano: el bote lo reparte el motor y el
        // asiento vuelve a la reserva en el siguiente ciclo.
        logger.error(
          `Mesa ${table.tableId}: el bot del asiento ${seat.index} no puede jugar de ` +
          'ninguna manera (fichas ' + botPlayer.chips + ', deber ' +
          `${state.currentBet}, pot ${state.pot}). Se cierra la mano para no dejar la ` +
          'mesa colgada con un turno que no avanza.',
        );
        this.syncEngineToTable(table, engine);
        await this.finishHand(table, engine);
        return;
      }
    }

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

    const seat = this.resolveActingSeat(table, engine);
    if (!seat) return;

    // ------------------------------------------------------------------
    // UN ASIENTO `out` SE PLIEGA AQUI, Y DA IGUAL QUE SEA HUMANO O BOT
    //
    // El chequeo va ANTES del de `kind` a proposito. `scheduleTurn` pliega el `out`
    // pero no vuelve a encadenarse, asi que el turno se retoma en el siguiente ciclo,
    // que es aqui. Si el chequeo de `out` estuviera despues del de `kind`, un bot
    // liquidado se escaparia y la mesa volveria a quedarse esperando a un jugador que
    // no va a jugar.
    //
    // Aqui si se guarda la mesa, porque este metodo es async y no se encadena a si
    // mismo.
    // ------------------------------------------------------------------
    if (seat.status === 'out') {
      engine.performAction(seat.index.toString(), 'fold');
      this.syncEngineToTable(table, engine);
      table.hand.lastActionAt = new Date();
      await table.save();
      this.scheduleTurn(table);
      return;
    }

    if (seat.kind !== 'human') return;

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
    //
    // `out` SE RESPETA, Y AQUI ERA DONDE SE ROMPIA.
    //
    // Este bucle corre ANTES de la rama de campo, y no tenia en cuenta `out`. Un
    // asiento marcado `out` por el field manager (posicion ya adjudicada) con cero
    // fichas volvia a `eliminated` aqui. Inmediatamente despues, la rama de campo
    // filtraba los `out` y no encontraba ninguno, porque todos llevaban ya el estado
    // `eliminated`: el asiento no se liberaba nunca.
    //
    // El ciclo se veia en los logs, tick a tick: el campo marcaba `out`, la mano
    // siguiente lo devolvia a `eliminated`, el campo lo volvia a marcar... para
    // siempre. El asiento ocupaba plaza, `seatsFree` daba 0, las merges no ocurrian
    // y el campo no llegaba nunca a la mesa final.
    for (const seat of table.seats) {
      if (seat.status === 'out') continue;
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
    // LOS ASIENTOS VUELVEN A `active`
    //
    // Este es EL sitio donde tiene que pasar, y antes no pasaba en ningun otro.
    // `folded`, `called` y `betting` son estados TERMINALES de una mano, no del
    // jugador: significan "lo que hizo en ESTA mano". Al cerrar la mano hay que
    // devolverlos a `active` para que la siguiente pueda empezar.
    //
    // Sin esto, `startHand` ve menos de dos jugadores activos y no arranca nunca
    // una segunda mano. Cada mesa jugaba exactamente una mano y se congelaba para
    // siempre: nadie se eliminaba, nadie ganaba, el campo no terminaba. Es el bug
    // mas grave que quedaba, y no se ve leyendo el codigo porque el motor, el rake
    // y las posiciones funcionan bien por separado. Lo encontro el test
    // end-to-end del motor (`scripts/test-e2e-engine.js`).
    //
    // Se hace aqui y no solo en `startHand` porque el estado de la mesa tiene que
    // ser coherente tambien entre manos: el panel del operador y las rutas leen
    // los asientos, y ver a un jugador con `folded` fuera de una mano lo hace
    // parecer eliminado sin serlo.
    //
    // `eliminated` y `out` se respetan: son estados resueltos. El field manager
    // necesita `eliminated` para adjudicar la posicion, y `out` marca a los ya
    // liquidados para no contarlos dos veces.
    for (const seat of table.seats) {
      seat.bet = 0;
      if (seat.chips <= 0) {
        seat.status = 'eliminated';
      } else if (seat.status !== 'eliminated' && seat.status !== 'out') {
        seat.status = 'active';
      }
    }

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
      // ------------------------------------------------------------------
      // ORDEN: PRIMERO SE LIBERAN LOS `out`, DESPUES SE MARCA `eliminated`
      //
      // Este orden estaba invertido y hacia que NUNCA se liberara un asiento. El
      // bucle que marca `eliminated` a los que se quedan sin fichas (que es lo
      // correcto para un humano que acaba de perder) incluía tambien a los que ya
      // estaban `out`, y los convertia de nuevo en `eliminated`. Inmediatamente
      // despues, el filtro que quita los `out` no encontraba ninguno: todos llevaban
      // ya el estado `eliminated`.
      //
      // Resultado: los asientos de los eliminados ocupaban plaza para siempre,
      // `checkMerges` calculaba `seatsFree = maxSeats - seats.length` con esas plazas
      // ocupadas, daba 0, ninguna mesa se fusionaba con otra y el campo no llegaba
      // nunca a la mesa final. Con 300 jugadores, el producto no terminaba un solo
      // campo.
      //
      // Se vio jugando un campo entero de verdad: 6 vivos, 8 eliminados, 4 000 manos
      // por mesa y dos mesas que no se juntaban nunca.
      // ------------------------------------------------------------------
      const antesOut = table.seats.length;

      // ------------------------------------------------------------------
      // SUS FICHAS VAN AL BOTE DEL CAMPO, NO CON EL ASIENTO
      //
      // `collectEliminations` deja a proposito las fichas del eliminado en el asiento
      // (su comentario lo dice: si las pone a cero alli, desaparecen de la contabilidad y
      // el campo devuelve menos de lo que cobro). Quitar el asiento sin pasarlas antes a
      // `deadChips` las borra.
      //
      // Medido jugando un campo entero: 2 155 unidades de 14 000, el 15 % del bote. El
      // campo se liquidaba igual, los premios se pagaban y nadie se enteraba de nada.
      //
      // El campo manager tiene el mismo caso en `liberarAsientosLiquidados`. Los dos
      // sitios sueltan asientos, y los dos tienen que hacer esto: si uno se olvida, las
      // fichas se pierden igual.
      // ------------------------------------------------------------------
      let fichasAlBote = 0;
      for (const seat of table.seats) {
        if (seat.status !== 'out') continue;
        fichasAlBote += Math.max(0, seat.chips) + Math.max(0, seat.bet);
      }

      if (fichasAlBote > 0 && table.field?.fieldId) {
        await Field.updateOne(
          { fieldId: table.field.fieldId },
          { $inc: { deadChips: fichasAlBote } },
        );
      }

      table.seats = table.seats.filter(s => s.status !== 'out');
      const liberados = antesOut - table.seats.length;

      // Bots eliminados fuera. Los humanos se quedan con su estado para que el field
      // manager recoja la eliminacion y le asigne posicion.
      table.seats = table.seats.filter(
        s => s.status !== 'eliminated' || s.kind === 'human',
      );

      // Un humano sin fichas queda `eliminated`: es una posicion en el campo. Aqui ya
      // no puede aparecer un `out`, se acaba de filtrar, asi que no hay riesgo de
      // resucitar a un jugador ya liquidado.
      for (const seat of table.seats) {
        if (seat.kind === 'human' && seat.chips <= 0 && seat.status !== 'eliminated') {
          seat.status = 'eliminated';
        }
      }

      // ------------------------------------------------------------------
      // POR QUE SE LIBERA AQUI Y NO EN EL FIELD MANAGER
      //
      // Porque este es el unico sitio donde no hay ninguna mano en curso, y por dos
      // razones mas:
      //
      //   - Quitar asientos con el motor en memoria descuadra los indices. El motor
      //     identifica a los jugadores por indice de asiento; si el asiento 3
      //     desaparece, el que era el 4 pasa a ser el 3.
      //   - Guardar la mesa entera desde el field manager pisaba `hand`, que es de
      //     este gestor. Ver el comentario del mismo asunto en `collectEliminations`.
      //
      // Las fichas de estos asientos ya son cero y su valor esta en
      // `Field.deadChips`, que el field manager anoto al marcar `out`. Aqui no se toca
      // el dinero: solo se libera el sitio.
      // ------------------------------------------------------------------
      if (liberados > 0) {
        logger.info(
          `Mesa ${table.tableId}: ${liberados} asiento(s) liberados de eliminados ` +
          `ya liquidados${fichasAlBote > 0
            ? `, y sus ${formatUnits(fichasAlBote)} USDT de fichas al bote del campo`
            : ''}. Quedan ${table.seats.length} de ${table.maxSeats}.`,
        );
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

      //Sigue pudiendo comprar entrada para la siguiente mano? El umbral es el
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

/**
 * Para TODO el motor de forma ordenada: campos y mesas.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA FUERA DE LA CLASE
 *
 * `bot.ts` no debe conocer `TableManager` ni `FieldManager` para apagar el
 * servicio. Si el apagado viviera dentro de la clase, habria que importar el
 * gestor aqui y el del campo, y entre los dos imports se forma un ciclo: el
 * gestor de mesas llama al campo (para las merges) y el campo llama al gestor de
 * mesas (para leer las mesas). Un ciclo en estos ficheros se traduce en
 * `undefined` en tiempo de ejecucion, que es la peor clase de bug.
 *
 * Aqui, en cambio, se importan los dos objetos ya construidos. Es el mismo patron
 * que usan `bot.ts` y las rutas, y no crea ciclo ninguno.
 *
 * EL ORDEN IMPORTA: primero el campo, despues las mesas. Al reves, un tick de mesa
 * podria pedir una merge a un campo que ya esta parado, y esa merge se quedaria a
 * medias: unos jugadores eliminados sin posicion adjudicada.
 */
export const shutdownEngine = async (timeoutMs = 6000): Promise<void> => {
  // Primero se marca la parada. A partir de este momento ningun tick de campo
  // empieza, ni siquiera los que ya estaban esperando en la cola del temporizador.
  markShuttingDown();

  // Primero el campo, despues las mesas. Al reves, un tick de mesa podria pedir
  // una merge a un campo que ya esta parado, y esa merge se quedaria a medias:
  // unos jugadores eliminados sin posicion adjudicada.
  await shutdownFieldManager();
  await tableManager.shutdown(timeoutMs);
};
