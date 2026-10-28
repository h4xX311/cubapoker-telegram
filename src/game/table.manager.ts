import {
  Table,
  ITable,
  ISeat,
  AllInReveal,
  HandHistoryEntry,
  toPublicTable,
} from '../models/Table';
import { Field } from '../models/Field';
import { unitsToUsdt, formatUnits } from '../config/units';
import { User } from '../models/User';
import { PokerGame, GameState } from './game.state';
import { calculateEquity } from './hand.equity';
import { evaluateHand } from './hand.evaluator';
import { blindLevelFor } from './blind.levels';
import { botFactory, BotProfile, decideAction, mulberry32 } from './bot.engine';
import { botAvatarFor } from '../config/avatars';
import {
  TABLE_TIERS,
  TABLE_TIER_LIST,
  BOT_CONFIG,
  RAKE,
  TURN_TIMER,
  getTier,
  rakeCapFor,
  botsForTable,
} from '../config/product';
import { markShuttingDown, shutdownFieldManager } from './field.manager';
import { rakebackService } from '../services/rakeback.service';
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
  /**
   * Instante exacto en que vence el turno, en ISO 8601. Es el mismo dato que
   * `turnEndsAt` en `getPlayerView`; viaja también en el aviso para que el
   * cliente pueda pintar la cuenta atrás sin pedir la mesa otra vez.
   */
  deadlineAt: string;
}

export type TurnNotifier = (notice: TurnNotice) => void | Promise<void>;

/** Fases en las que hay una decision pendiente de un jugador concreto. */
const ACTION_PHASES = new Set<string>(['preflop', 'flop', 'turn', 'river']);

/**
 * Cuántas manos se conservan para el historial de la mesa.
 *
 * 30 es suficiente para revisar la sesión sin que una mesa cash que vive
 * varios días acumule documentos enormes. La entrada más reciente va primero.
 */
const HAND_HISTORY_LIMIT = 30;

/**
 * Pausa entre manos. La mesa queda en `idle` con el resultado visible antes de
 * repartir la siguiente. En un all-in se alarga para que se puedan ver las
 * calles y los porcentajes; el cliente reproduce ese mismo replay.
 *
 * Se puede bajar por entorno en pruebas de integracion, que conducen las manos
 * a mano y no deben esperar doce segundos por cada all-in.
 */
const HAND_PAUSE_MS = Math.max(0, Number(process.env.HAND_PAUSE_MS ?? 6_000));
const ALLIN_HAND_PAUSE_MS = Math.max(
  HAND_PAUSE_MS,
  Number(process.env.ALLIN_HAND_PAUSE_MS ?? 12_000),
);

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
    // ------------------------------------------------------------------
    // QUE CONSIDERA "MANO A MEDIAS"
    //
    // Lo que decide es si la MESA TIENE UNA MANO EN CURSO, no el estado de la mesa. Son
    // dos cosas distintas y confundirlas deja mesas congeladas para siempre.
    //
    // Antes solo se buscaban las mesas en `running`. Pero una mesa puede tener
    // `status: 'waiting'` y `hand.phase: 'preflop'` a la vez: que se quedara en `waiting`
    // con la mano a medias pasa cuando el proceso se reinicia con la mano empezada, o
    // cuando `finishHand` devuelve el estado a `waiting` sin limpiar la fase.
    //
    // Y esa combinacion era un callejon sin salida: `recoverInterruptedHands` no la
    // miraba (buscaba `running`), y el tick tampoco, porque solo procesa mesas que tienen
    // motor. El resultado era una mesa CONGELADA: `hand.phase` clavado, bote sin repartir,
    // sin cartas para nadie y sin turno para el humano. Si te sentabas ahi, no podias
    // jugar nunca. No habia forma de desbloquearla desde el juego: ni aksiu, ni esperar.
    //
    // Lo que se busca ahora es exactamente lo que rompe: una mano viva sin motor que la
    // conduzca. Que la mesa diga `waiting`, `running` o `paused` da igual, porque la
    // verdad es la fase de la mano.
    // ------------------------------------------------------------------
    const EN_REPOSO = ['idle', 'idle-awaiting'];

    const stale = await Table.find({
      $and: [
        { 'hand.phase': { $nin: EN_REPOSO } },
        { tableId: { $nin: Array.from(this.engines.keys()) } },
      ],
    });

    for (const table of stale) {
      logger.warn(
        `Mesa ${table.tableId} con mano a medias sin motor ` +
          `(status=${table.status}, fase=${table.hand.phase}, bote=${table.hand.pot}). ` +
          'Se recupera al arrancar.',
      );
      await this.refundTable(table);
    }

    // ------------------------------------------------------------------
    // Y AL REVES: MESAS CON MOTOR PERO EN REPOSO
    //
    // El caso simetrico. Si una mesa dice `waiting` pero su `hand.phase` sigue siendo
    // `preflop`, el documento y la realidad no coinciden. Sin limpiarlo, `startHand` ve una
    // mesa "en reposo" y la relanza, pero el `pot` y las apuestas del documento viejo se
    // quedan mezclados con la mano nueva.
    // ------------------------------------------------------------------
    const sucias = await Table.find({
      status: 'waiting',
      'hand.phase': { $in: EN_REPOSO },
    });

    for (const mesa of sucias) {
      // Solo si ademas no hay nadie con fichas pendientes en la mano.
      const apostado = (mesa.seats ?? []).some(
        (s) => (s.bet ?? 0) > 0 || (s.chips ?? 0) < 0,
      );
      if (apostado) continue;

      mesa.hand.phase = 'idle';
      mesa.hand.pot = 0;
      mesa.hand.currentBet = 0;
      await mesa.save();
      logger.info(
        `Mesa ${mesa.tableId}: fase ${'resetada'} a idle por estar en reposo sin motor.`,
      );
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

  // ------------------------------------------------------------------
  // CERROJO DE ESCRITURA POR MESA
  //
  // Una promesa por mesa. Cada operacion espera a la anterior de ESA mesa, y no espera a
  // las de las demas: un campo de 300 son 43 mesas y todas trabajan a la vez.
  //
  // Es lo que evita el `VersionError` que mataba la mesa al sentarse. Ver el comentario
  // largo de este bloque: dos escrituras concurrentes sobre el mismo documento compiten
  // por la version, y una de las dos revienta.
  // ------------------------------------------------------------------
  private tableLocks = new Map<string, Promise<unknown>>();

  /**
   * Cuantas veces ha pasado un conflicto de version.
   *
   * Esta para el log de arranque: si sale distinto de 0, hay una via de escritura que no
   * pasa por el cerrojo, y las mesas que han muerto asi no se recuperan solas.
   */
  private versionConflicts = 0;

  /**
 * Serializa las escrituras de UNA mesa.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA FUERA DE ESTA CLASE Y POR QUE ES PUBLICA
 *
 * `seating.service` (sentarse, levantarse) escribe el MISMO documento de mesa que el motor.
 * Antes el cerrojo era privado de esta clase, asi que el motor se serializaba consigo mismo y
 * el servicio escribia por fuera: dos escritores sobre el mismo documento sin exclusion
 * mutua.
 *
 * El sintoma en produccion era esto, con la partida en marcha:
 *
 *     VersionError: No matching document found for id "6ac520e3..." version 66
 *       modifiedPaths "seats, seats.3, seats.3.handsWon, seats.4, hand, hand.phase,
 *       hand.communityCards, hand.actingSeat, seats.4.chips"
 *
 * Que se ven los caminos de escritura de AMBOS lados: `seats` y `hand`. El tick estaba
 * repartiendo y contando manos mientras la peticion HTTP sentaba a un jugador sobre una copia
 * antigua. Mongo resuelve la version y **descarta una de las dos escrituras**: o el asiento no
 * se guardaba, o la mano perdia un estado. Con fichas de por medio, cualquiera de las dos
 * opciones es un fallo de dinero.
 *
 * Y no es un fallo raro: aparece en cuanto alguien se sienta mientras la mesa esta jugando,
 * que es justo lo que hace todo el mundo.
 *
 * Ahora es publica porque `seating.service` la necesita, y ese modulo ya importa esta clase
 * (no hay ciclo).
 */
async withTableLock<T>(tableId: string, fn: () => Promise<T>): Promise<T> {
    const anterior = this.tableLocks.get(tableId) ?? Promise.resolve();

    // La cola avanza aunque esta operacion falle: si no, un error deja el cerrojo
    // envenenado y las siguientes operaciones de esa mesa cuelgan para siempre.
    const siguiente = anterior.then(fn, fn);

    this.tableLocks.set(
      tableId,
      siguiente.catch(() => undefined),
    );

    try {
      return await siguiente;
    } finally {
      // Si esta era la ultima, se borra la entrada y no crece el mapa para siempre.
      if (this.tableLocks.get(tableId) === siguiente) {
        this.tableLocks.delete(tableId);
      }
    }
  }

  private async tick(): Promise<void> {
    // Antes esta consulta filtraba `kind: 'cash'`. Los freerolls y centrolls
    // viven en mesas `kind: 'freeroll'` / `'centroll'`, asi que el gestor
    // NUNCA las procesaba: se sentaban los jugadores, se repartia el campo y
    // la mesa se quedaba en `idle` para siempre. El jugador veia su asiento y
    // su stack, pero no llegaba ni una carta. Aqui entran las tres clases de
    // mesa; `processTable` decide despues que corresponde a cada una.
    const tables = await Table.find({
      status: { $in: ['waiting', 'running'] },
      kind: { $in: ['cash', 'freeroll', 'centroll', 'tournament'] },
    }).limit(80);

    for (const table of tables) {
      // Con cerrojo: si el bot esta guardando esta mesa, el ciclo espera en vez de
      // competir por la version.
      try {
        await this.withTableLock(table.tableId, () => this.processTable(table));
      } catch (error) {
        // ------------------------------------------------------------------
        // UN VersionError NO ES UN ERROR CUALQUIERA
        //
        // Significa que dos escrituras compitieron por la version del documento. Con el
        // cerrojo no deberia pasar, y si pasa es que se ha colado una cuarta via de
        // escritura que no esta cerrada.
        //
        // Antes se registraba igual que cualquier otro error y se pasaba al siguiente. Eso
        // hacia que la mesa quedara MUERTA en silencio: el error estaba en el log, pero
        // nadie miraba, y el usuario se encontraba con su buy-in cobrado y una mesa que no
        // se movia.
        //
        // Ahora se cuenta y se dice cuantas mesas han muerto por esto. Si el numero sube,
        // hay una via de escritura sin cerrar.
        // ------------------------------------------------------------------
        if ((error as any)?.name === 'VersionError') {
          this.versionConflicts += 1;
          logger.error(
            `CONFLICTO DE VERSION en ${table.tableId} (ejemplo #${this.versionConflicts}). ` +
            'Dos escrituras compitieron por el documento. La mesa se queda parada. ' +
            'Si esto se repite, hay una via de escritura sin pasar por el cerrojo.',
          );
        } else {
          logger.error(`Error procesando mesa ${table.tableId}:`, error);
        }
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
    // Las mesas de campo tambien necesitan que este ciclo les reparta manos y
    // haga actuar a los bots. El filtro por clase se hace arriba, en `tick`.
    const maxSeats = table.maxSeats;

    // --- Rellenar con bots ---
    const humans = table.seats.filter(s => s.kind === 'human').length;
    const bots = table.seats.filter(s => s.kind === 'bot').length;
    const occupied = table.seats.length;

    // Nunca llena la mesa: el ultimo asiento queda para un humano. En una HU
    // de 2 asientos esto es la diferencia entre una sala accesible y una sala
    // que el lobby muestra llena de bots y en la que nadie puede sentarse.
    //
    // Solo las ring tables cash se rellenan solas. En un campo (cash, freeroll
    // o centroll) los bots los pone el gestor del campo al arrancar, en el
    // numero justo para poder jugar. Si este ciclo los añadiera antes, un
    // jugador que se inscribiera temprano veria la mesa llena de bots horas
    // antes de la hora, y el campo arrancaria con una plantilla que nadie
    // registro. Ademas, esos bots no son parte del bote del campo.
    const esRingCash = table.kind === 'cash' && !this.isFieldTable(table);
    const desiredBots = botsForTable(maxSeats, humans);

    const needBots =
      esRingCash &&
      occupied < maxSeats &&
      bots < Math.min(desiredBots, maxSeats - occupied);

    if (needBots) {
      // Gradual y sin pasarse del objetivo: si `toAdd` solo mirara los huecos,
      // una HU añadiría dos bots de golpe y volvería a llenar la mesa.
      const toAdd = Math.max(
        0,
        Math.min(2, maxSeats - occupied, desiredBots - bots),
      );
      // El bot entra con el mismo buy-in que la mesa, en unidades internas. Si
      // el bot tuviera mas fichas que los humanos, ganaria por stack depth y no
      // por juego, y el rake de la mesa se distorsionaria hacia el operador
      // pasando por el bot.
      // En un freeroll el buy-in es 0 (no se compra nada): las fichas iniciales
      // son la parte del premio de cada jugador, y el bot entra con la misma
      // parte. Calcularlo ahi, con `targetField`, es lo mismo que hace
      // `seating.service.joinFreeroll`.
      const botChips =
        table.startChips ??
        (table.buyInUnits > 0 ? table.buyInUnits : table.smallBlind * 2);
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
    // UNA MANO A MEDIAS SIN NADIE QUE LA JUEGUE: SE ABANDONA
    //
    // El caso real: el ultimo humano se levanta en mitad de una mano. Su asiento queda
    // `out`, la mesa se queda con 4 bots y `phase: 'preflop'` con el bote dentro.
    //
    // Y ahi se queda PARA SIEMPRE, porque las dos condiciones que mueven la mesa son
    // incompatibles: `startHand` solo arranca con un humano (no hay), y una mano en curso no
    // se cierra sola si no queda nadie a quien tocar el turno. O sea: ni reparten ni recogen.
    // 35 unidades de bote y las apuestas de los bots, bloqueadas, indefinidamente.
    //
    // Es la version en mesa cash del campo que nunca terminaba, y tiene el mismofinal: dinero
    // que no se mueve. Un jugador que levanta la cabeza ve una mesa parada y no tiene por que
    // saber que sus fichas (las de la mesa, no las suyas) estan ahi dentro.
    //
    // Que se abandone es lo unico razonable: sin humano no hay partida. Lo aportado
    // por el humano que se fue queda para la casa, como su apuesta al retirarse; los
    // bots no tienen dinero propio. La mesa se vacia y vuelve al lobby.
    // ------------------------------------------------------------------------
    if (table.hand.phase !== 'idle' && table.hand.phase !== 'idle-awaiting') {
      const humanosVivos = table.seats.filter(
        (s) => s.kind === 'human' && s.status !== 'out',
      ).length;

      // Las mesas de campo NO se abandonan: alli el dinero es del campo y las posiciones las
      // decide el gestor de campos. Se pausa, que es otra cosa (ver `refundTable`).
      const esDeCampo = this.isFieldTable(table);

      if (humanosVivos === 0 && !esDeCampo) {
        logger.warn(
          `Mesa ${table.tableId}: mano a medias (${table.hand.phase}) sin ningun humano ` +
          `sentado. Se abandona; el bote (${table.hand.pot}) queda para la casa y la mesa ` +
          'se vacia.',
        );
        await this.abandonHand(table);
      }
    }

    if (table.hand.phase === 'idle' || table.hand.phase === 'idle-awaiting') {
      // ------------------------------------------------------------------
      // UN HUMANO SIN FICHAS NO DEBE QUEDARSE SENTADO
      //
      // Un humano con `chips === 0` es un busted: no puede jugar, no puede ganar y no puede
      // perder. Y como el asiento sigue `active`, la mesa ve 5 jugadores pero `activeHumans`
      // es 0, asi que la mano NO arranca nunca: el humano no juega (no tiene) y la mesa no
      // reparte (no hay quien pague). El juego se queda en `idle` para siempre con bots
      // esperando a un humano que no va a actuar nunca.
      //
      // El caso real: un jugador perdio la pila en la mesa de practice y se quedo sentado con
      // 0 fichas. Veia la mesa con sus bots, sin cartas y sin bote, sin ningun aviso. La
      // partida no estaba rota: el motor esperaba a que tuviera fichas, y no habia forma de
      // saberlo.
      //
      // Aqui se le saca de la mesa y se le devuelve lo que le corresponda (0), liberando el
      // asiento. Es lo que haria el jugador al pulsar "salir", pero sin que tenga que
      // pulsarlo, y sin dejar la mesa bloqueada mientras tanto.
      // ------------------------------------------------------------------
      // En un campo, un humano sin fichas es una ELIMINACION, no un busted
      // de cash: la posicion y el dinero los decide `field.manager`. Si este
      // ciclo le quitara el asiento antes de que el campo lo recoja, se
      // perderia su posicion y las fichas que le quedaran en el bote.
      const esDeCampoParaBust = this.isFieldTable(table);
      const humansSinFichas = esDeCampoParaBust
        ? []
        : table.seats.filter(
            s => s.kind === 'human' && s.status === 'active' && s.chips <= 0,
          );

      for (const seat of humansSinFichas) {
        logger.warn(
          `Mesa ${table.tableId}: el humano ${seat.displayName} (asiento ${seat.index}) ` +
          'se queda sin fichas. Se le saca de la mesa y se le devuelve su saldo (0).',
        );
        await this.sitOutBustedHuman(table, seat);
      }

      // Pausa entre manos: el resultado acaba de guardarse y la siguiente
      // mano no debe taparlo. En all-in el `nextHandAt` es mas lejano.
      const esperaHasta = table.hand.nextHandAt
        ? new Date(table.hand.nextHandAt).getTime()
        : 0;
      if (esperaHasta > Date.now()) return;

      const activeHumans2 = table.seats.filter(
        s => s.kind === 'human' && s.status === 'active' && s.chips > 0,
      ).length;
      const activeTotal2 = table.seats.filter(
        s => s.status === 'active' && s.chips > 0,
      ).length;

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

  /**
   * Abandona una mano en la que no queda ningun humano: cierra la mano sin ganador,
   * limpia apuestas y vacia la mesa.
   *
   * Sin humano no hay partida ni showdown posible. Lo aportado por el humano que se
   * fue queda para la casa, igual que su apuesta al retirarse. Los bots no tienen
   * dinero propio, asi que devolverles el bote solo inflaria una mesa que se va a
   * vaciar. La mesa vuelve a `waiting` para que el lobby no la muestre ocupada.
   */
  private async abandonHand(table: ITable): Promise<void> {
    // El motor de la mano se tira: sin humanos no hay mano que terminar, y dejarlo puesto
    // haria que el siguiente arranque de mano se encontrara un motor con estado viejo.
    this.engines.delete(table.tableId);

    const bote = Math.max(0, table.hand.pot ?? 0);

    // El bote NO se devuelve a los bots. Lo aportado por el humano que se fue
    // queda para la casa, igual que su apuesta al retirarse: en cash, abandonar
    // una mano no es cobrar la parte que ya pusiste. Los bots tampoco son
    // jugadores con dinero propio. Lo que no se puede hacer es dejar el bote
    // dentro de una mesa que se va a vaciar y decir en el log que se devolvio.
    for (const seat of table.seats) {
      seat.bet = 0;
      seat.totalBet = 0;
    }

    table.hand.phase = 'idle';
    table.hand.pot = 0;
    table.hand.currentBet = 0;
    table.hand.lastActionAt = null;

    // Sin humanos, la mesa vuelve al lobby y se vacia. Antes se quedaba
    // `running` con bots sentados y una mano `idle`: ocupaba un slot, no
    // arrancaba nunca y el siguiente humano podia acabar sentado en una mesa
    // fantasma.
    const humanosVivos = table.seats.filter(
      s => s.kind === 'human' && s.status !== 'out',
    ).length;

    if (humanosVivos === 0) {
      table.status = 'waiting';
      table.seats = [];
    }

    await table.save();

    logger.info(
      `Mesa ${table.tableId}: mano abandonada sin humanos. ` +
      `${bote} unidades del bote quedan para la casa; la mesa vuelve a esperar.`,
    );
  }

  /**
   * Saca de la mesa a un humano que se ha quedado sin fichas.
   *
   * Un `chips === 0` es un busted en una mesa cash: no puede jugar. Si se deja sentado con
   * `status: 'active'`, la mesa cuenta un jugador mas pero `activeHumans` es 0, y la mano
   * no arranca nunca. El jugador ve una mesa parada, sin error, sin aviso.
   *
   * Se le devuelve lo que le toque al saldo real (que es 0, porque esta sin fichas) y se
   * libera el asiento. Es el mismo efecto que el jugador pulsando "salir", pero ocurre solo
   * y la mesa no se queda bloqueada.
   */
  private async sitOutBustedHuman(table: ITable, seat: ISeat): Promise<void> {
    const telegramId = Number(seat.playerId);
    // Lo que le corresponde al saldo. Aqui es 0 (esta sin fichas), pero se calcula igual por
    // si en el futuro un busted conserva algo.
    const returned = Math.max(0, seat.chips + (seat.bet ?? 0));

    if (Number.isFinite(telegramId) && returned > 0) {
      // Camino normal de devolucion, el mismo que usa `standUp` en `seating.service`.
      await User.updateOne(
        { telegramId },
        { $inc: { 'balance.real': returned } },
      );
      await User.updateOne({ telegramId }, { $set: { activeTableId: null } });
    } else if (Number.isFinite(telegramId)) {
      await User.updateOne({ telegramId }, { $set: { activeTableId: null } });
    }

    // Asiento liberado: `out` no cuenta como jugador en la mesa ni en `activeHumans`.
    seat.status = 'out';
    seat.chips = 0;
    seat.bet = 0;
    seat.totalBet = 0;

    await table.save();
  }

  /** Anade un asiento de bot con buy-in coherente con la mesa. */
  private addBotSeat(table: ITable, buyIn: number): ISeat {
    // El nombre solo tiene que ser unico DENTRO de la mesa. Pasamos los que ya
    // estan sentados para no repetir rival en la misma pantalla.
    const nombresEnMesa = new Set(table.seats.map((s) => s.displayName));
    const profile: BotProfile = botFactory.create(undefined, nombresEnMesa);

    // ------------------------------------------------------------------
    // EL INDICE TIENE QUE SER UN HUECO LIBRE, NO `seats.length`
    //
    // El motor identifica a cada jugador por el string de su indice. Con
    // `index: table.seats.length`, en cuanto se libera un asiento `out` el array se acorta
    // y el siguiente bot recibe un indice que YA esta ocupado. El motor escribe entonces las
    // fichas de un jugador sobre otro (ver el comentario de `syncEngineToTable`).
    //
    // Se busca el primer entero libre, que es lo mismo que hace `field.manager` al sentar a
    // un humano.
    // ------------------------------------------------------------------
    const usados = new Set(table.seats.map((s) => s.index));
    let indiceLibre = 0;
    while (usados.has(indiceLibre)) indiceLibre++;

    const seat: ISeat = {
      index: indiceLibre,
      kind: 'bot',
      playerId: profile.id,
      displayName: profile.name,
      avatar: botAvatarFor(profile.name),
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

  /**
   * Rellena una mesa con bots hasta que haya `minimo` asientos ACTIVOS.
   *
   * ------------------------------------------------------------------
   * PARA QUE HACE FALTA, SI YA HAY UN RELLENO AUTOMATICO
   *
   * El relleno del `tick` es gradual: mete dos bots por vuelta y solo mientras el campo se
   * esta llenando. Eso esta bien para un campo de 300 que tarda minutos en juntar gente.
   *
   * Un freeroll arranca a una hora fija, y puede llegar con UN solo humano. En ese momento
   * `startField` exige dos asientos activos por mesa. Si se confia en que el `tick` ya habra
   * puesto los bots, el arranque falla o se retrasa un ciclo, y el jugador ve un torneo que
   * empieza tarde sin saber por que.
   *
   * Aqui se ponen los que falten en el acto y se devuelve cuantos se anyadieron, para que el
   * planificador pueda registrar el numero en el log.
   * ------------------------------------------------------------------
   */
  async asegurarMinimoAsientos(tableId: string, minimo: number): Promise<number> {
    const table = await Table.findOne({ tableId });
    if (!table) return 0;

    const activos = () =>
      table.seats.filter((s) => s.status === 'active' && s.chips > 0).length;

    const max = table.maxSeats || 7;
    let anyadidos = 0;

    while (activos() < minimo && table.seats.length < max) {
      const fichas =
        table.startChips ??
        (table.buyInUnits > 0 ? table.buyInUnits : table.smallBlind * 2);
      this.addBotSeat(table, fichas);
      anyadidos++;
    }

    if (anyadidos > 0) await table.save();
    return anyadidos;
  }

  // ======================================================================
  // Ciclo de una mano
  // ======================================================================

  /**
   * Aplica el nivel de ciegas del reloj a una mesa de campo.
   *
   * Se llama justo antes de crear el motor, nunca a mitad de mano: cambiar las
   * ciegas con el bote y las apuestas vivas descuadra la mano. La mesa cash no
   * entra aquí: sus ciegas son fijas.
   */
  private applyBlindLevel(table: ITable): void {
    if (!this.isFieldTable(table)) return;

    const baseSmall = Math.max(1, table.blindBaseSmall ?? table.smallBlind);
    const baseBig = Math.max(baseSmall, table.blindBaseBig ?? table.bigBlind);
    const inicio = table.blindLevelStartedAt
      ?? table.createdAt
      ?? new Date();

    const nivel = blindLevelFor(baseSmall, baseBig, inicio);
    const cambio =
      nivel.level !== (table.blindLevel ?? 0) ||
      nivel.small !== table.smallBlind ||
      nivel.big !== table.bigBlind;

    table.blindBaseSmall = baseSmall;
    table.blindBaseBig = baseBig;
    table.blindLevel = nivel.level;
    table.smallBlind = nivel.small;
    table.bigBlind = nivel.big;

    if (cambio) {
      logger.info(
        `Mesa ${table.tableId}: nivel de ciegas ${nivel.level} ` +
        `(${nivel.small}/${nivel.big}).`,
      );
    }
  }

  private async startHand(table: ITable): Promise<void> {
    const activeSeats = table.seats.filter(s => s.status === 'active' && s.chips > 0);
    if (activeSeats.length < 2) return;

    // La pausa ya cumplio su funcion: la mano nueva puede empezar.
    table.hand.nextHandAt = undefined;

    // Las ciegas se actualizan entre manos. Si el nivel cambió mientras la
    // mesa estaba esperando, la mano nueva ya nace con las ciegas nuevas.
    this.applyBlindLevel(table);

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
      // El banco de tiempo es por mano. Sin este reinicio, una mano larga
      // dejaría a un humano sin banco para el resto de la sesión.
      if (seat.kind === 'human') {
        seat.timeBankMs = TURN_TIMER.timeBankMs;
      }

      // EL ORDEN IMPORTA: out SE RESPETA SIEMPRE.
      if (seat.status === 'out') continue;
      if (seat.chips <= 0) seat.status = 'eliminated';
      else if (seat.status !== 'eliminated') seat.status = 'active';
    }


    // Motor en memoria. `maxSeats` se pasa como tope del motor: sin el, el
    // motor limitaba a 6 jugadores y una mesa de 500 nunca arrancaba.
    const handSeed = Date.now() % 1000000;

    // El rake se configura al crear el motor, no al cerrar la mano. Así el
    // bote bruto sigue existiendo cuando hay que cobrarlo; antes `endGame`
    // ponía `state.pot = 0` y `finishHand` calculaba un rake de cero.
    const esRing = !this.isFieldTable(table);
    const rakeConfig = table.kind === 'cash'
      ? {
          percentage: RAKE.cashPercentage,
          cap: esRing
            ? rakeCapFor(table.tierId, activeSeats.length)
            : RAKE.cashMax,
          minPot: RAKE.minPot,
          requireFlopOr3Bet: esRing,
        }
      : undefined;

    const engine = new PokerGame(
      table.tableId,
      table.smallBlind,
      table.bigBlind,
      table.maxSeats,
      rakeConfig,
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

    // ------------------------------------------------------------------
    // `currentPlayerIndex` NO ES UN INDICE DE ASIENTO
    //
    // Es la posicion dentro de `state.players`, que es la lista de los que
    // entraron en ESTA mano. En una mesa con huecos (el asiento 1 se libero, por
    // ejemplo) la lista es [0, 2, 3] y `currentPlayerIndex = 1` significa el
    // asiento 2, no el 1.
    //
    // Guardarlo en crudo hacia que `hand.actingSeat` apuntase a otro jugador:
    // la API rechazaba la accion del humano con "No es tu turno" y la mesa se
    // quedaba esperando a un asiento que no tenia el turno. Se traduce aqui, en
    // el unico punto que escribe el estado publico.
    // ------------------------------------------------------------------
    const actingPlayer =
      ACTION_PHASES.has(state.phase) ? state.players[state.currentPlayerIndex] : undefined;
    const actingSeat = actingPlayer ? parseInt(actingPlayer.id, 10) : -1;
    table.hand.actingSeat = Number.isNaN(actingSeat) ? -1 : actingSeat;

    // Lo mismo con el boton. `dealerIndex` tambien es una posicion dentro de
    // `state.players`, no el numero de asiento que se guarda en la mesa y que
    // usa `startHand` para rotar. Sin esta traduccion el boton saltaba asientos
    // o se quedaba clavado en cuanto habia un hueco.
    const dealerPlayer = state.players[state.dealerIndex];
    const dealerSeat = dealerPlayer ? parseInt(dealerPlayer.id, 10) : -1;
    table.hand.dealerSeat = Number.isNaN(dealerSeat) ? -1 : dealerSeat;
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
      const baseDelay =
        BOT_CONFIG.minThinkMs +
        Math.random() * (BOT_CONFIG.maxThinkMs - BOT_CONFIG.minThinkMs);

      // Un pequeno porcentaje de las decisiones se toma su tiempo, como un
      // jugador que duda con una mano dificil. Un retardo uniforme en cada
      // accion es una firma de maquina; los humanos no juegan con metronomo.
      // Los tests ponen maxThinkMs a 0 y siguen jugando en el acto.
      const delay =
        BOT_CONFIG.maxThinkMs > 1000 && Math.random() < 0.06
          ? baseDelay + 1200 + Math.random() * 2400
          : baseDelay;

      // ------------------------------------------------------------------
      // EL TURNO DEL BOT TAMBIEN VA CON CERROJO
      //
      // Este es el otro lado del VersionError: este \`setTimeout\` dispara por su cuenta,
      // sin mirar lo que este haciendo el ciclo del gestor. Sin cerrarlo, el bot guarda la
      // mesa mientras \`processTable\` la guarda tambien, y uno de los dos revienta.
      //
      // Se envuelve la LLAMADA, no el metodo, para que el cerrojo cubra tambien el tiempo
      // que el bot tarda en decidir. Decidir fuera del cerrojo dejaria una ventana entre
      // "ha decidido" y "va a guardar" por la que se cuela el ciclo.
      // ------------------------------------------------------------------
      const tableId = table.tableId;
      const manoDelTimer = table.hand.handNumber;
      const timer = setTimeout(() => {
        // RELEER DENTRO DEL CERROJO, NO USAR LA COPIA DEL `setTimeout`.
        //
        // El temporizador captura el documento que habia cuando se programo. Si
        // mientras tanto el jugador se levanta, se sienta otro o el tick guarda
        // la mesa, esa copia queda con una version vieja. El cerrojo evita que
        // las escrituras se pisen, pero no arregla la copia: al guardar salta
        // `VersionError` y el turno del bot se pierde.
        //
        // Se revalida tambien la mano. Un timer de la mano anterior no debe
        // actuar sobre una mano nueva que ya empezo.
        this.withTableLock(tableId, async () => {
          const actual = await Table.findOne({ tableId });
          if (!actual) return;
          if (actual.hand.handNumber !== manoDelTimer) return;
          await this.playBotTurn(actual);
        }).catch((e) => logger.error('Error bot turn:', e));
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

    // El aviso y la vista usan el mismo punto de partida. Si `lastActionAt`
    // todavía no existe (mesa restaurada a medias), se toma ahora: es mejor
    // dar un turno completo que uno ya vencido.
    const inicioTurno = table.hand.lastActionAt
      ? new Date(table.hand.lastActionAt).getTime()
      : Date.now();
    const deadlineAt = new Date(inicioTurno + TURN_TIMER.humanMs).toISOString();

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
      deadlineAt,
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
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      bigBlind: state.bigBlind,
      dealerIndex: state.dealerIndex,
      currentPlayerIndex: state.currentPlayerIndex,
      tablePlayers: state.players.length,
      isSmallBlind: botPlayer.isSmallBlind,
      isBigBlind: botPlayer.isBigBlind,
      preflopRaises: state.preflopRaises ?? 0,
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

  /**
   * Prepara el replay de un all-in.
   *
   * No cambia el resultado: la mano ya esta pagada por el motor. Solo calcula
   * una fotografia de equidad por calle para que la interfaz pueda ensenar las
   * cartas y los porcentajes con una pausa, en vez de saltar directamente al
   * ganador. El board y las cartas salen del showdown, asi que nunca se
   * revela la mano de alguien que se retiro.
   */
  private buildAllInReveal(
    state: GameState,
    seatDe: (engineId: string) => ISeat | undefined,
    handNumber: number,
  ): AllInReveal | undefined {
    if (
      !state.allInStreet ||
      !state.showdown ||
      state.showdown.length < 2 ||
      state.communityCards.length < 5
    ) {
      return undefined;
    }

    const calles = ['preflop', 'flop', 'turn', 'river'] as const;
    const cartasPorCalle = { preflop: 0, flop: 3, turn: 4, river: 5 } as const;
    const startStreet = (
      ['preflop', 'flop', 'turn', 'river'].includes(state.allInStreet)
        ? state.allInStreet
        : 'preflop'
    ) as AllInReveal['startStreet'];

    const board = state.communityCards;
    const conocidos = state.showdown.map((s) => ({
      id: s.playerId,
      cards: s.cards,
    }));

    const equity = new Map<string, AllInReveal['players'][number]['equity']>();
    const nombres = new Map<string, AllInReveal['players'][number]['handName']>();

    for (const calle of calles) {
      const n = cartasPorCalle[calle];
      const boardParcial = board.slice(0, n);
      const resultados = calculateEquity(
        conocidos,
        boardParcial,
        1_200,
        handNumber * 17 + n * 101,
      );
      const porJugador = new Map(resultados.map((r) => [r.playerId, r.equity]));

      for (const s of state.showdown) {
        const previas = equity.get(s.playerId) ?? {
          preflop: 0,
          flop: 0,
          turn: 0,
          river: 0,
        };
        previas[calle] = porJugador.get(s.playerId) ?? 0;
        equity.set(s.playerId, previas);

        const nombresPrevios = nombres.get(s.playerId) ?? {
          preflop: '',
          flop: '',
          turn: '',
          river: '',
        };
        nombresPrevios[calle] = evaluateHand([...s.cards, ...boardParcial]).name;
        nombres.set(s.playerId, nombresPrevios);
      }
    }

    // En el river no se estima: se usa la mano real. Asi el ganador muestra
    // 100 % (o el reparto exacto de un empate) y los demas 0 %, sin decimales
    // de una simulacion que ya no hace falta.
    const valoresFinales = state.showdown.map((s) => ({
      id: s.playerId,
      valor: s.hand?.value ?? evaluateHand([...s.cards, ...board]).value,
    }));
    const maximo = Math.max(...valoresFinales.map((v) => v.valor));
    const ganadores = new Set(
      valoresFinales.filter((v) => v.valor === maximo).map((v) => v.id),
    );
    const pctGanador = 100 / Math.max(1, ganadores.size);
    for (const s of state.showdown) {
      const e = equity.get(s.playerId);
      if (e) e.river = ganadores.has(s.playerId) ? Math.round(pctGanador) : 0;
      const n = nombres.get(s.playerId);
      if (n) n.river = s.hand?.name ?? evaluateHand([...s.cards, ...board]).name;
    }

    return {
      startStreet,
      board: board.map((c) => `${c.rank}|${c.suit}`),
      players: state.showdown.map((s) => {
        const seat = seatDe(s.playerId);
        return {
          seatIndex: seat?.index ?? Number(s.playerId),
          displayName: seat?.displayName ?? 'Jugador',
          cards: s.cards.map((c) => `${c.rank}|${c.suit}`),
          equity: equity.get(s.playerId) ?? {
            preflop: 0,
            flop: 0,
            turn: 0,
            river: 0,
          },
          handName: nombres.get(s.playerId) ?? {
            preflop: '',
            flop: '',
            turn: '',
            river: '',
          },
        };
      }),
    };
  }

  /** Cierra la mano: reparte el bote, cobra rake y limpia para la siguiente. */
  private async finishHand(table: ITable, engine: PokerGame): Promise<void> {
    // Cerrojo de liquidación: `applyHumanAction`, el turno del bot y el tick
    // pueden coincidir al ver la mano terminada. Sin esto, el rake y las
    // estadísticas se cobrarían dos veces. El motor se saca del mapa en el
    // primer intento; el segundo no encuentra nada y se va.
    if (!this.engines.has(table.tableId)) return;
    this.engines.delete(table.tableId);

    const state = engine.getState();

    // Limpiar timer
    const timer = this.turnTimers.get(table.tableId);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(table.tableId);
    }

    // El motor ya evaluó, pagó los botes laterales y descontó el rake. Aquí
    // solo se refleja en la mesa y se contabiliza. NO se vuelve a pagar a los
    // ganadores: hacerlo era un doble abono invisible, porque el motor ya había
    // sumado el bote a `player.chips`.
    this.syncEngineToTable(table, engine);

    const rake = Math.max(0, Math.floor(state.rake ?? 0));
    if (rake > 0) {
      table.stats.rakeCollected += rake;

      // El rake de las mesas de un campo se acumula ahí. Lo necesita el field
      // manager para calcular el bote neto del campo: si no, creería que el
      // bote es el bruto y pagaría de más.
      if (this.isFieldTable(table) && table.field?.fieldId) {
        await Field.updateOne(
          { fieldId: table.field.fieldId },
          { $inc: { rakeCollected: rake } },
        );
      }

      // El rake por jugador se anota aquí, mientras `seat.totalBet` todavía
      // tiene lo que cada uno aportó a la mano. Después del reparto se reinicia
      // y el rakeback saldría siempre cero.
      await rakebackService.recordTableRake(table, rake);
    }

    // --- Estadísticas de la sesión --------------------------------------
    const payouts = new Map(
      (state.payouts ?? []).map(p => [p.playerId, p.amount]),
    );
    const winnerIds = new Set((state.winners ?? []).map(w => w.playerId));

    for (const seat of table.seats) {
      const id = String(seat.index);
      const won = payouts.get(id) ?? 0;
      if (winnerIds.has(id)) seat.handsWon += 1;
      // Neto real de la mano: lo que cobró menos lo que puso. Antes solo se
      // sumaban las ganancias y el balance de sesión mentía.
      seat.netChips += won - (seat.totalBet ?? 0);
    }

    // --- Resultado de la mano para la UI --------------------------------
    // Se guarda antes de limpiar el estado. La mesa puede volver a `idle` en
    // milisegundos; sin esto el jugador nunca ve quién ganó ni con qué mano.
    const seatDe = (engineId: string): ISeat | undefined =>
      table.seats.find(s => String(s.index) === engineId);
    const fmt = (c: any): string => `${c.rank}|${c.suit}`;
    const allIn = this.buildAllInReveal(
      state,
      seatDe,
      table.hand.handNumber,
    );

    table.hand.lastResult = {
      handNumber: table.hand.handNumber,
      endedAt: new Date().toISOString(),
      pot: state.potGross ?? 0,
      potUsdt: unitsToUsdt(state.potGross ?? 0),
      rake,
      rakeUsdt: unitsToUsdt(rake),
      board: (state.communityCards ?? []).map(fmt),
      winners: (state.winners ?? []).map(w => {
        const seat = seatDe(w.playerId);
        return {
          seatIndex: seat?.index ?? Number(w.playerId),
          displayName: seat?.displayName ?? 'Jugador',
          amount: w.amount,
          amountUsdt: unitsToUsdt(w.amount),
          handName: w.hand?.name ?? '',
          cards: (w.hand?.bestCards ?? []).map(fmt),
        };
      }),
      showdown: (state.showdown ?? []).map(s => {
        const seat = seatDe(s.playerId);
        return {
          seatIndex: seat?.index ?? Number(s.playerId),
          displayName: seat?.displayName ?? 'Jugador',
          cards: s.cards.map(fmt),
          handName: s.hand?.name ?? '',
        };
      }),
      endedByFold: (state.showdown ?? []).length === 0,
      unit: table.kind === 'cash' && !this.isFieldTable(table) ? 'USDT' : 'PTS',
      allIn,
    };

    // La siguiente mano no empieza de inmediato. El resultado, las cartas del
    // showdown y el replay de porcentajes necesitan unos segundos en pantalla;
    // un all-in necesita mas porque se reproducen las calles una a una.
    table.hand.nextHandAt = new Date(
      Date.now() + (allIn ? ALLIN_HAND_PAUSE_MS : HAND_PAUSE_MS),
    );

    // ------------------------------------------------------------------
    // HISTORIAL DE LA MANO
    //
    // `lastResult` es el escaparate de la mano recién cerrada. El historial
    // necesita una cosa más: las cartas privadas de cada participante, para
    // que cada jugador pueda revisar sus propias manos después. Se guardan
    // aquí y `toPublicTable()` las recorta por espectador; nunca se envían
    // las de un rival que no llegó al showdown.
    // ------------------------------------------------------------------
    const resultado = table.hand.lastResult!;
    const entradaHistorial: HandHistoryEntry = {
      handNumber: resultado.handNumber,
      endedAt: resultado.endedAt,
      pot: resultado.pot,
      rake: resultado.rake,
      board: resultado.board,
      unit: resultado.unit,
      endedByFold: resultado.endedByFold,
      players: state.players.map((p) => {
        const seat = seatDe(p.id);
        return {
          seatIndex: seat?.index ?? Number(p.id),
          displayName: seat?.displayName ?? 'Jugador',
          cards: (p.cards ?? []).map(fmt),
          folded: Boolean(p.folded),
        };
      }),
      winners: resultado.winners.map((w) => ({
        seatIndex: w.seatIndex,
        displayName: w.displayName,
        amount: w.amount,
        handName: w.handName,
        cards: w.cards,
      })),
      showdown: resultado.showdown.map((s) => ({
        seatIndex: s.seatIndex,
        displayName: s.displayName,
        cards: s.cards,
        handName: s.handName,
      })),
    };

    table.handHistory = [
      entradaHistorial,
      ...(table.handHistory ?? []),
    ].slice(0, HAND_HISTORY_LIMIT);

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
    table.hand.phase = 'idle';
    table.hand.pot = 0;
    table.hand.currentBet = 0;
    table.hand.communityCards = [];
    table.hand.actingSeat = -1;
    table.hand.lastActionAt = undefined;

    // El boton NO se rota aqui. `startHand` ya lo hace al principio de cada
    // mano, saltando huecos y asientos eliminados. Rotarlo tambien al cerrar
    // la mano lo movia DOS veces por vuelta: el boton se saltaba un jugador en
    // cada mano y repartia las ciegas mal.

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
    // MESA CASH (sin `field`): el stack vive en la mesa mientras el jugador
    // sigue sentado. Se compra una vez al sentarse y se cobra una vez al
    // levantarse. Antes se abonaba el stack al monedero al final de CADA mano y
    // se dejaba el asiento a cero: el jugador solo podía jugar una mano, y si
    // hubiera ganado se le habría pagado dos veces (una al ganar y otra al
    // "cerrar" la mano).
    //
    // MESA DE CAMPO (con `field.fieldId`): las fichas tampoco vuelven al
    // monedero. El buy-in se cobró una vez al registrarse y queda bloqueado
    // hasta que el jugador es eliminado o gana el campo. Quien decide cuándo se
    // devuelve el dinero es `field.manager.ts`, que conoce las posiciones.

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

    // --- Mesa cash -------------------------------------------------------
    // El stack se queda en la mesa. Solo se retiran los que se quedaron a cero:
    // un humano sin fichas no puede jugar la siguiente mano y, si se dejara
    // sentado, bloquearía el arranque. Su buy-in ya se perdió; no hay nada que
    // abonarle (devolver 0 no es una operación de dinero).
    const humanosSinFichas: number[] = [];
    table.seats = table.seats.filter(seat => {
      if (seat.status === 'out') return false;
      if (seat.chips <= 0) {
        if (seat.kind === 'human') {
          const telegramId = Number(seat.playerId);
          if (Number.isFinite(telegramId)) humanosSinFichas.push(telegramId);
        }
        return false;
      }
      seat.status = 'active';
      return true;
    });

    for (const telegramId of humanosSinFichas) {
      await User.updateOne(
        { telegramId },
        { $set: { activeTableId: null } },
      );
    }

    // Si no quedan humanos, la mesa se vacía y vuelve a esperar. Los bots no
    // sostienen una mesa cash: sin un humano no hay partida que cobrar.
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
   * Aplica una accion de un jugador humano.
   *
   * Es el unico punto por el que la Mini App modifica el estado de una mano,
   * junto con el bot. Centralizarlo aqui garantiza que humano y bot siguen
   * exactamente el mismo camino: validar, ejecutar en el motor, sincronizar,
   * persistir y programar el siguiente turno.
   */
  async applyHumanAction(
    mesa: ITable,
    seatIndex: number,
    action: 'fold' | 'check' | 'call' | 'raise' | 'all_in',
    amount?: number,
  ): Promise<boolean> {
    // Tercer punto de entrada, y el que mas duele cuando falla: es la accion del jugador
    // de verdad, y si se pierde, el usuario ve que no le pasa nada y no sabe por que.
    return this.withTableLock(mesa.tableId, async () => {
      // RELEER DENTRO DEL CERROJO. La mesa que llega desde la ruta se leyo
      // antes de esperar el turno; si un bot guardo mientras tanto, esa copia
      // tiene una version vieja y `save()` lanzaria `VersionError`. La accion
      // del humano se perderia justo cuando mas importa.
      const table = await Table.findOne({ tableId: mesa.tableId });
      if (!table) return false;

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
    });
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

    return tables.map(t => {
      const esCashRing = t.kind === 'cash' && !t.field?.fieldId;
      return {
        tableId: t.tableId,
        kind: t.kind,
        tierId: t.tierId,
        formatId: t.formatId ?? '7max',
        prizeTier: t.prizeTier,
        status: t.status,
        mode: esCashRing ? 'USDT' : 'PTS',
        // Ciegas y buy-in en USDT para la UI del lobby. Internamente son
        // unidades (ver config/units). En torneos el cliente usa `mode` para
        // pintar puntos y no dólares.
        smallBlind: unitsToUsdt(t.smallBlind),
        bigBlind: unitsToUsdt(t.bigBlind),
        buyIn: unitsToUsdt(t.buyInUnits),
        maxSeats: t.maxSeats,
        // Sin desglose humano/bot: el lobby público solo necesita saber si hay
        // sitio. Los bots no se anuncian en ninguna pantalla.
        occupied: t.seats.length,
        pot: t.hand.pot,
        potUsdt: unitsToUsdt(t.hand.pot),
        phase: t.hand.phase,
        handNumber: t.hand.handNumber,
        rakeCollected: t.stats.rakeCollected,
        prizePaid: t.stats.prizePaid,
      };
    });
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

  /**
   * Mesas abiertas de un jugador para el selector multi-mesa.
   *
   * Un jugador puede estar sentado en varias mesas cash a la vez. La app
   * necesita una lista pequena con lo justo para pintar una pestana: cuanto
   * tiene en esa mesa, si le toca y cuanto le queda. No se envia ninguna carta
   * ni ningun dato de los rivales.
   */
  async listMyTables(telegramId: number): Promise<any[]> {
    const tables = await Table.find({
      seats: {
        $elemMatch: {
          kind: 'human',
          playerId: String(telegramId),
          status: { $ne: 'out' },
        },
      },
    })
      .sort({ updatedAt: -1 })
      .limit(12);

    return tables.map((table) => {
      const seat = table.seats.find(
        (s) => s.kind === 'human' && s.playerId === String(telegramId),
      );
      if (!seat) return null;

      const esCashRing = table.kind === 'cash' && !table.field?.fieldId;
      const modo: 'USDT' | 'PTS' = esCashRing ? 'USDT' : 'PTS';
      const enMano = ACTION_PHASES.has(table.hand.phase);
      const esMiTurno = enMano && table.hand.actingSeat === seat.index;
      const inicioTurno = table.hand.lastActionAt
        ? new Date(table.hand.lastActionAt).getTime()
        : 0;

      return {
        tableId: table.tableId,
        kind: table.kind,
        tierId: table.tierId,
        formatId: table.formatId ?? '7max',
        label:
          table.kind === 'cash'
            ? getTier(table.tierId)?.label ?? 'Cash'
            : table.kind === 'freeroll'
            ? 'Freeroll'
            : table.kind === 'tournament'
            ? 'Torneo'
            : 'Centroll',
        field: table.field
          ? {
              fieldId: table.field.fieldId,
              tableNumber: table.field.tableNumber,
              targetField: table.field.targetField,
              registered: table.field.registered,
            }
          : undefined,
        status: table.status,
        mode: modo,
        phase: table.hand.phase,
        handNumber: table.hand.handNumber,
        seatIndex: seat.index,
        chips: seat.chips,
        displayChips: modo === 'USDT' ? unitsToUsdt(seat.chips) : seat.chips,
        buyInUsdt: unitsToUsdt(table.buyInUnits),
        smallBlindUsdt: unitsToUsdt(table.smallBlind),
        bigBlindUsdt: unitsToUsdt(table.bigBlind),
        pot: table.hand.pot,
        displayPot:
          modo === 'USDT' ? unitsToUsdt(table.hand.pot) : table.hand.pot,
        blindLevel: table.blindLevel ?? 0,
        isMyTurn: esMiTurno,
        turnEndsAt:
          esMiTurno && inicioTurno > 0
            ? new Date(inicioTurno + TURN_TIMER.humanMs).toISOString()
            : null,
        turnStartedAt:
          esMiTurno && inicioTurno > 0
            ? new Date(inicioTurno).toISOString()
            : null,
        nextHandAt: table.hand.nextHandAt
          ? new Date(table.hand.nextHandAt).toISOString()
          : null,
      };
    }).filter(Boolean);
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
      const engineState = entry.engine.getState();
      const enTurno = ['preflop', 'flop', 'turn', 'river'].includes(engineState.phase)
        && engineState.currentPlayerIndex === seat.index;

      view.isMyTurn = enTurno;
      view.myHand = playerState?.myHand ?? null;
      view.myChips = playerState?.myChips ?? seat.chips;
      view.myBet = playerState?.myBet ?? seat.bet;
      view.myTimeBankMs = Math.max(0, seat.timeBankMs ?? TURN_TIMER.timeBankMs);
      view.toCall = playerState?.toCall ?? 0;
      view.minRaise = playerState?.minRaise ?? engineState.minRaise;
      view.canCheck = playerState?.canCheck ?? false;
      view.canRaise = playerState?.canRaise ?? false;
    } else {
      view.myCards = [];
      view.isMyTurn = false;
      view.myChips = seat.chips;
      view.myBet = 0;
      view.myTimeBankMs = Math.max(0, seat.timeBankMs ?? 0);
      view.toCall = 0;
      view.minRaise = table.bigBlind;
      view.canCheck = false;
      view.canRaise = false;
    }

    // El reloj del turno viaja para TODOS los que miran la mesa, no solo para
    // el que tiene que actuar. El aro del avatar del rival tambien baja; si
    // solo se enviara a `isMyTurn`, la interfaz no podria mostrar el tiempo de
    // decision de los demas. Los bots no tienen reloj humano: no se envia.
    const asientoEnTurno = table.seats[table.hand.actingSeat];
    const turnoHumano =
      asientoEnTurno?.kind === 'human' &&
      ['preflop', 'flop', 'turn', 'river'].includes(table.hand.phase) &&
      !!table.hand.lastActionAt;
    const inicioTurnoMs = turnoHumano
      ? new Date(table.hand.lastActionAt!).getTime()
      : 0;

    view.turnStartedAt = inicioTurnoMs
      ? new Date(inicioTurnoMs).toISOString()
      : null;
    view.turnEndsAt = inicioTurnoMs
      ? new Date(inicioTurnoMs + TURN_TIMER.humanMs).toISOString()
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
        reason:
          `Necesitas ${unitsToUsdt(minBuyIn)} USDT para esta mesa. ` +
          `Tienes ${unitsToUsdt(total)} USDT.`,
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
