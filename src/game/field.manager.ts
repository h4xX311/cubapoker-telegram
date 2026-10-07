import { Field, IField, FieldTable } from '../models/Field';
import { Table, ITable, ISeat } from '../models/Table';
import { User } from '../models/User';
import { splitPrize, rakeOfField } from '../services/payout.service';
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

    // ------------------------------------------------------------------
    // (a) ESTA EN LA COLA
    //
    // La cola esta en memoria, asi que solo existe si el proceso no se ha reiniciado desde
    // que el jugador se apunto. Y aun asi es el caso raro: `trySeat` sienta en cuanto
    // hay sitio, y las mesas se crean segun hacen falta.
    // ------------------------------------------------------------------
    const queue = queues.get(fieldId) ?? [];
    const idx = queue.findIndex(p => p.telegramId === telegramId);
    const estabaEnCola = idx !== -1;

    if (estabaEnCola) {
      queue.splice(idx, 1);
      queues.set(fieldId, queue);
    }

    // ------------------------------------------------------------------
    // (b) ESTA SENTADO EN UNA MESA
    //
    // Este es el caso NORMAL, y el que no estaba. Antes no se miraba, con lo que el
    // asiento se quedaba en la mesa: el buy-in se devolvia pero el jugador seguia
    // sentado, y al intentar registrarse de nuevo `register` le decia "Ya estas jugando
    // en un campo" sin dejarle hacer nada. Atascado, con el dinero ya devuelto.
    //
    // El `$pull` lleva el `field.fieldId`, asi que si por un bug de fusion estuviera
    // en dos mesas, sale de las dos.
    // ------------------------------------------------------------------
    const soltado = await Table.updateMany(
      {
        'field.fieldId': fieldId,
        seats: { $elemMatch: { playerId: String(telegramId), status: { $ne: 'out' } } },
      },
      { $pull: { seats: { playerId: String(telegramId) } } },
    );

    // (c) NI EN LA COLA NI SENTADO
    if (!estabaEnCola && soltado.modifiedCount === 0) {
      throw new FieldError(
        'No estas apuntado a este campo. Puede que el campo ya haya empezado.',
        'NOT_IN_FIELD',
      );
    }

    // ------------------------------------------------------------------
    // LOS CONTADORES, Y POR QUE NO SE RESTAN A CIEGAS
    //
    // Antes se restaba `waiting: -1` siempre. Si el jugador estaba SENTADO, el waiting no
    // se habia incremento, asi que restarlo lo dejaba en negativo: el campo se quedaba
    // Informando de un jugador esperando que no existia.
    //
    // Y `buyInsCollected` se ajusta en los dos casos, que es lo que hace que el bote del
    // campo cuadre con el dinero que hay en las carteras.
    // ------------------------------------------------------------------
    if (estabaEnCola) {
      await Field.updateOne(
        { _id: field._id },
        { $inc: { waiting: -1, buyInsCollected: -field.buyInUnits } },
      );
      field.waiting = Math.max(0, field.waiting - 1);
    } else {
      await Field.updateOne(
        { _id: field._id },
        { $inc: { seated: -1, playersRemaining: -1, buyInsCollected: -field.buyInUnits } },
      );
      field.seated = Math.max(0, field.seated - 1);
      field.playersRemaining = Math.max(0, field.playersRemaining - 1);
    }
    field.buyInsCollected = Math.max(0, field.buyInsCollected - field.buyInUnits);

    // Lo que no llego a jugar esta integro: se devuelve entero.
    await this.refund(telegramId, field.buyInUnits);

    if (soltado.modifiedCount > 0) {
      logger.info(
        `Campo ${fieldId}: el jugador ${telegramId} ha salido del campo antes de ` +
        `empezar. Se le devuelve ${field.buyInUnits} unidades.`,
      );
    }

    return { refunded: field.buyInUnits };
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

    // ------------------------------------------------------------------
    // CUANTAS MESAS HACEN FALTA
    //
    // NO se puede calcular con `queue.length`. La cola se vacia a medida que se
    // sienta a la gente, asi que despues del primer registro `queue.length` es 0,
    // el segundo es 1, el tercero 2... Con 7 por mesa, `tablesForField` nunca pasa
    // de 1 y TODO el campo se amontona en una sola mesa con 300 asientos.
    //
    // Eso es exactamente lo que hacia este codigo: `openField` era correcto, el
    // cobro del buy-in era exacto, y aun asi los 300 jugadores acababan jugando
    // juntos en una mesa "de 7". No se puede ver leyendo; lo Teach el test
    // end-to-end (ver `scripts/test-e2e-field.js`).
    //
    // Lo que hace falta son mesas para TODOS los inscritos, no solo para los que
    // esperan: los sentados ya ocupan las suyas.
    const registered = field.seated + field.waiting;
    const wantedTables = tablesForField(Math.max(registered, queue.length, 2));

    // ------------------------------------------------------------------
    // LAS MESAS SE CUENTAN EN LA BASE DE DATOS, NO EN `field.tables`
    //
    // Antes se contaba sobre `field.tables`, que es una COPIA desnormalizada dentro
    // del documento del campo. Esa copia se mantiene con `$push` condicionado, y por
    // tanto puede quedarse corta: si el push de una mesa no se aplica (porque la
    // entrada ya estaba, o porque la actualizacion no llego a tiempo), `field.tables`
    // dice que hay menos mesas de las que hay, el bucle de creacion cree que le
    // faltan mesas y vuelve a crear la numero 1... con `seats: []`.
    //
    // Eso BORRA a los jugadores que ya estaban sentados en ella. El contador del campo
    // no baja (solo baja al adjudicarse una eliminacion), asi que queda un jugador de
    // mas para siempre y el campo nunca cuadra.
    //
    // Se vio jugando un campo entero: 14 jugadores registrados, 14 incrementos de
    // `playersRemaining`, y 13 asientos en las mesas. Sin ninguna posicion adjudicada
    // de por medio, o sea, el jugador se perdia al SENTAR, no al eliminar.
    //
    // La verdad son los documentos de `Table`. Es una consulta mas por ciclo, y evita
    // que una copia decide cuantos jugadores hay.
    // ------------------------------------------------------------------
    const liveTables = await Table.find({
      'field.fieldId': field.fieldId,
      'field.mergedInto': { $exists: false },
    });

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
      // UNA MESA LLENA NO ACEPTA A NADIE MAS.
      //
      // Sin esta comprobacion, `nextSeatable` seguia devolviendo un jugador
      // valido para una mesa que ya tenia los 7 asientos, y todos se amontonaban
      // en la primera. El motor reparte 300 jugadores sobre lo que cree que son
      // 7 asientos, y el reparto del pot sale mal.
      //
      // Se comprueba el numero real de asientos y no `maxSeats` a secas, porque
      // `maxSeats` es lo que la mesa DEBERIA tener y `seats.length` es lo que
      // tiene: si alguien metio un asiento de mas, aqui se corta igual.
      const capacity = Math.min(table.maxSeats || SEATS_PER_TABLE, SEATS_PER_TABLE);

      // Se llena la mesa EN BUCLE, no con un jugador por llamada.
      //
      // Con un solo asiento por invocacion, `trySeat` tendria que llamarse 300
      // veces para llenar 43 mesas. Como se llama una vez por registro y otra por
      // tick, el campo tardaria muchisimo en completarse y, peor, arrancaria con
      // las mesas a medio llenar.
      while (table.seats.length < capacity) {
        const queueIdx = nextSeatable(queue, field.buyInUnits, table.buyInUnits);
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

        // Los contadores del campo suben UNA VEZ, sin condicion: este jugador se
        // ha sentado, lo diga o no la lista de tablas.
        await Field.updateOne(
          { _id: field._id },
          { $inc: { waiting: -1, seated: 1, playersRemaining: 1 } },
        );

        // ------------------------------------------------------------------
        // EL OBJETO EN MEMORIA SE ACTUALIZA TAMBIEN
        //
        // Un `$inc` de Mongo escribe en la base de datos y no toca el objeto que lo
        // tiene en memoria. Y ese objeto es el que lee `countSeated`, que es justo lo que
        // decide si el campo arranca. Sin esta linea, `field.seated` se quedaba en 0 para
        // siempre, `countSeated` devolvia 0, y un campo con 8 de 8 sentados no arrancaba
        // nunca. Verificado: 260 vueltas y seguia en "filling".
        // ------------------------------------------------------------------
        field.waiting = Math.max(0, field.waiting - 1);
        field.seated += 1;
        field.playersRemaining += 1;

        // Y la entrada de la mesa en field.tables solo se anade si no estaba.
        //
        // Antes se hacia $push en CADA asiento y luego dedupeFieldTables lo
        // arreglaba: 300 pushes y 300 limpiezas para acabar con 43 entradas. Y era
        // una condicion de carrera: si dos asientos de la misma mesa compiten, el
        // dedupe puede correr antes de que exista el segundo push, dejando la
        // entrada duplicada para siempre.
        //
        // El filtro $ne hace que solo una de las dos inserciones se aplique,
        // porque Mongo evalua el filtro y escribe en una sola operacion.
        await Field.updateOne(
          { _id: field._id, 'tables.tableId': { $ne: table.tableId } },
          {
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

        queue.splice(queueIdx, 1);
        queues.set(field.fieldId, queue);
        seatedAny = true;
      }
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
      buyInUnits: field.buyInUnits,
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
  /**
   * Suelta los asientos ya liquidados y mete SUS FICHAS en el bote del campo.
   *
   * ------------------------------------------------------------------
   * POR QUE NO SE PUEDE SOLTAR UN ASIENTO SIN HACER ESTO
   *
   * `collectEliminations` deja a proposito las fichas del eliminado en su asiento, con
   * un comentario que lo explica: si las pone a cero alli, desaparecen de la
   * contabilidad y el campo devuelve menos de lo que cobro.
   *
   * El problema es que luego el asiento se marca `out` y se suelta del array, y las
   * fichas se van con el. Para cuando le toca a `settleField` de barrer el bote, ya no
   * estan en ningun sitio.
   *
   * Sevio jugando un campo entero: 2 155 unidades de 14 000, el 15 % del bote. Ocho
   * eliminados, unos 270 cada uno. El campo se liquidaba igual y los premios se pagaban,
   * asi que nadie se enteraba: el dinero se perdia sin dejar rastro.
   *
   * ------------------------------------------------------------------
   * POR QUE `deadChips`
   *
   * Porque es el bote del campo, y ya hay un sitio que lo recoge: `settleField`. Las
   * fichas de un eliminado son tan del campo como las que hay en la mesa, y aqui solo
   * hay que moverlas de sitio: del asiento al bote.
   *
   * Es el mismo patron que ya usa `closeEmptyTable`, y ademas las dos cosas van en la
   * misma operacion logica, asi que no puede quedar una sin la otra.
   *
   * @param table  la mesa, YA RELEIDA de la base. Se usa su array tal cual esta.
   * @returns  cuantas fichas han pasado al bote
   */
  async liberarAsientosLiquidados(field: IField, table: ITable): Promise<number> {
    const quedan = table.seats.filter((s) => s.status !== 'out');
    const liberados = table.seats.length - quedan.length;
    if (liberados === 0) return 0;

    // Lo que hay en los asientos que se van. Tambien `bet`, por el mismo motivo que
    // `closeEmptyTable`: son fichas en la mesa, no en la cartera de nadie.
    let alBote = 0;
    for (const s of table.seats) {
      if (s.status !== 'out') continue;
      alBote += Math.max(0, s.chips) + Math.max(0, s.bet);
    }

    // ------------------------------------------------------------------
    // LAS FICHAS PRIMERO, Y SOLO SI LA MESA ESTA EN REPOSO
    //
    // El orden importa: si la mesa ha entrado en una mano desde que la leimos, no se
    // toca. Perder un asiento de sobra se arregla en el siguiente ciclo; soltar un
    // asiento con la mano en curso descuadra los indices del motor.
    // ------------------------------------------------------------------
    if (alBote > 0) {
      await Field.updateOne({ _id: field._id }, { $inc: { deadChips: alBote } });
      // El objeto en memoria tambien, o el campo sigue diciendo que no tiene esas
      // fichas y las cuenta otra vez cuando se lee su estado.
      field.deadChips = (field.deadChips || 0) + alBote;
    }

    // ------------------------------------------------------------------
    // UN `$set` DIRIGIDO A `seats`, NUNCA UN `save()`
    //
    // `table.save()` escribiria el documento entero, y `hand` es de `TableManager`: su
    // fase, el bote, las cartas y a quien le toca. La copia que tenemos aqui lleva la
    // `hand` de cuando se leyo, asi que guardarla entera pisa la mano viva con una
    // foto vieja.
    //
    // Se vio exactamente: un campo con 3 jugadores vivos y fichas se quedo congelado en
    // `fase=idle` y SIN MOTOR EN MEMORIA. La mesa no arrancaba otra mano, nadie jugaba y
    // el campo no terminaba nunca. Este aviso estaba ya escrito en el sitio original,
    // describing un bug anterior. No volver a escribirlo aqui.
    //
    // El filtro de `hand.phase` en la consulta es la segunda mitad de la proteccion: si
    // la mesa no esta en reposo, `modifiedCount` sera 0 y no habra pasado nada.
    // ------------------------------------------------------------------
    const resLiberar = await Table.updateOne(
      {
        _id: table._id,
        'hand.phase': { $in: ['idle', 'idle-awaiting'] },
      },
      { $set: { seats: quedan } },
    );

    if (resLiberar.modifiedCount === 0) {
      // La mesa esta jugando. Las fichas ya estan en `deadChips`, que es lo importante:
      // el dinero esta a salvo aunque el asiento se quede una ronda mas.
      logger.warn(
        `Campo ${field.fieldId}: ${table.tableId} tiene ${liberados} asiento(s) ` +
        `liquidados pero la mesa no esta en reposo, asi que no se sueltan todavia. ` +
        `Sus ${formatUnits(alBote)} USDT ya estan en el bote del campo; el asiento se ` +
        'suelta en el proximo ciclo. Se sueltan en cuanto la mano termina.',
      );
      return alBote;
    }

    // La copia en memoria se actualiza para que quien llame vea lo mismo que la base.
    table.seats = quedan;

    if (alBote > 0) {
      logger.info(
        `Campo ${field.fieldId}: ${table.tableId} suelta ${liberados} asiento(s) ` +
        `liquidados y ${formatUnits(alBote)} USDT de sus fichas pasan al bote del campo.`,
      );
    }

    return alBote;
  },

  /**
   * El primer indice de asiento que NO esta ocupado.
   *
   * ------------------------------------------------------------------
   * POR QUE NO VALE `seats.length`
   *
   * Porque los indices de una mesa de campo tienen huecos. Cuando un eliminado pasa a
   * `out`, `finishHand` lo quita del array, y los demas conservan el indice que
   * tenían. Una mesa de 7 sin el asiento 2 queda con los indices [0, 1, 3, 4, 5, 6]:
   * `seats.length` dice 6, pero el 6 ya está ocupado. Si el siguiente jugador recibe
   * ese indice, se queda con dos asientos en el mismo sitio.
   *
   * Y el indice de asiento es el IDENTIFICADOR DEL JUGADOR dentro del motor: se pasa
   * como id en `performAction` y se busca por el en `resolveActingSeat` y en
   * `syncEngineToTable`. Con dos asientos en el mismo indice:
   *
   *   - el motor registra DOS jugadores con el mismo id, y `performAction` actua
   *     siempre sobre el primero, asi que el segundo no juega nunca;
   *   - `syncEngineToTable` escribe las fichas sobre el primero, y las del segundo
   *     asiento no se escriben jamas.
   *
   * Ese asiento queda huerfano: `isSeated` lo ve ocupado porque mira por `playerId`,
   * asi que nadie lo vuelve a sentar, pero el motor no lo juega, no se elimina y no
   * cobra posicion. El campo se queda con un jugador invisible.
   *
   * ------------------------------------------------------------------
   * POR QUE NO SE RENUMERA LA MESA ENTERA
   *
   * Porque los indices ya escritos `no se pueden cambiar`: `field.results` guarda la
   * mesa y el indice de cada eliminado, y un resultado que apunta al asiento 3 cuando
   * ese 3 era otro jugador es peor que un hueco. Un hueco no molesta: al motor los
   * indices le son opacos, y solo importa que no se repitan.
   *
   * La unica regla es la de no repetir. Este metodo la cumple siempre.
   */
  primerIndiceLibre(seats: Array<{ index?: number }>): number {
    const ocupados = new Set<number>();
    for (const s of seats) {
      const i = Number(s.index);
      if (Number.isInteger(i) && i >= 0) ocupados.add(i);
    }
    let candidato = 0;
    while (ocupados.has(candidato)) candidato++;
    return candidato;
  },

  /**
   * Reparte los indices de una mesa y avisa si alguno se repite.
   *
   * No repara: avisar es lo que hace falta, porque un indice repetido significa que
   * hay dos jugadores con la misma identidad en el motor y hay que saber por que ha
   * pasado. Reparar en silencio dejaria al campo descuadrado sin que nadie se entere.
   */
  assertIndicesUnicos(tableId: string, seats: Array<{ index?: number }>): void {
    const vistos = new Map<number, number>();
    for (const s of seats) {
      const i = Number(s.index);
      if (!Number.isInteger(i)) continue;
      vistos.set(i, (vistos.get(i) ?? 0) + 1);
    }
    const repetidos = [...vistos.entries()].filter(([, n]) => n > 1);
    if (repetidos.length === 0) return;
    const detalle = repetidos
      .map(([i, n]) => i + ' (' + n + ' veces)')
      .join(', ');
    logger.error(
      'Mesa ' + tableId + ': ' + repetidos.length +
      ' indice(s) de asiento repetido(s): ' + detalle +
      '. Dos jugadores con el mismo indice son el mismo jugador para el motor: uno ' +
      'de ellos no juega nunca y sus fichas no se escriben. Hay que revisarlo a mano.',
    );
  },

  buildSeat(
    table: ITable,
    telegramId: number,
    chips: number,
    username?: string,
  ): ISeat {
    return {
      index: this.primerIndiceLibre(table.seats),
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

    // ------------------------------------------------------------------
    // UNA MESA CON UN SOLO JUGADOR NO SE VACIA, SE ESPERA
    //
    // Antes se hacia `refundTable` en toda mesa con menos de 2 activos. Y eso hacia dos
    // cosas, las dos graves:
    //
    //  1. Con 8 jugadores y mesas de 7 el reparto es 7 + 1, y el jugador de la mesa con
    //     uno se quedaba sin asiento, sin posicion y sin buy-in. Su turno se quedaba
    //     pendiente en el motor, la mano no avanzaba, y el campo entero se congelaba.
    //     Para un Sit'n'Go de 8 jugadores eso no es un caso raro: es el reparto normal.
    //
    //  2. Devolver esas fichas es CREAR DINERO: el buy-in ya se cobro al registrarse y
    //     esta en `Field.buyInsCollected`. Es el mismo dreno que ya se corrigio en
    //     `collectEliminations` y en `closeEmptyTable`, en un tercer sitio.
    //
    // Lo que se hace en un campo de verdad es ESPERAR. El jugador se queda sentado, con
    // sus fichas, hasta que le toque. Y si hay sitio en otra mesa, `checkMerges` lo mueve,
    // que para eso esta.
    //
    // Lo que no se hace nunca, en ningun caso, es devolverle el buy-in: en un campo las
    // fichas son del bote, no suyas.
    //
    // Y una mesa totalmente vacia no necesita hacer nada: no tiene nada que devolver ni
    // alguien a quien esperar.
    // ------------------------------------------------------------------
    for (const t of tables) {
      if (t.seats.length === 0 && t.status !== 'finished') {
        t.status = 'finished';
        if (t.field) t.field.fieldStatus = 'finished';
        await t.save();
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
        await this.reconcileAliveCount(field);
        await this.checkCompletion(field);
      } catch (error) {
        logger.error(`Error en tick del campo ${field.fieldId}:`, error);
      }
    }
  },

  /**
   * Reconcile el contador de vivos con la realidad.
   *
   * ------------------------------------------------------------------
   * POR QUE HACE FALTA, Y POR QUE NO ES UNA TRAMPA
   *
   * `playersRemaining` decide la POSICION de cada eliminado: la posicion es el valor
   * del contador ANTES de decrementarlo. Si el contador miente, todos los que vengan
   * despues reciben una posicion desplazada y el reparto del bote es incorrecto.
   *
   * El contador se mantenia con `$inc`, uno por cada eliminacion que se recoge. Ese
   * estilo es fragil por naturaleza: basta con que un jugador desaparezca de una mesa
   * por una via que no sea la eliminacion para que el contador se quede alto para
   * siempre, y no hay ninguna forma de que se note salvo mirando el numero.
   *
   * Esto no es contabilidad por duplicado: es una COMPROBACION. Si el numero no cuadra
   * con los asientos reales, se corrige y se avisa. El contador deja de ser la fuente
   * de la verdad y pasa a ser una cache que se revalida contra ella.
   *
   * QUE CUENTA COMO VIVO
   *
   * Un asiento humano en una mesa viva del campo que NO este `out`. Es decir:
   *
   *   - `active`: jugando. Vivo.
   *   - `eliminated`: sin fichas, pero SIN posicion adjudicada todavia. Se cuenta
   *     como vivo porque el contador baja cuando se adjudica, no cuando pierde.
   *   - `out`: ya adjudicado y liquidado. NO cuenta.
   *
   * ASI QUE NO HAY DIFERENCIAS LEGITIMAS ENTRE EL CONTADOR Y ESTE RECUENTO, y por eso
   * la correccion se puede hacer sin esperar: no hay estado transitorio que
   * justifique la diferencia. Los eliminados a medio adjudicar ya estan contados como
   * vivos en los dos sitios.
   */
  async reconcileAliveCount(field: IField): Promise<void> {
    const tables = await Table.find({
      'field.fieldId': field.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    // Un jugador solo puede estar en una mesa, asi que se cuentan los asientos
    // humanos distintos. Si apareciera el mismo `playerId` en dos mesas, es un bug
    // de fusion y se avisa: la invariante "nadie esta en dos mesas" tambien importa: un jugador en dos mesas
    // cobraria dos veces.
    const vistos = new Set<number>();
    let vivos = 0;

    for (const t of tables) {
      for (const seat of t.seats) {
        if (seat.kind !== 'human') continue;
        // NO SE CUENTA UN ASIENTO ELIMINADO COMO VIVO.
        //
        // Antes solo se saltaba 'out'. Un asiento marcado 'eliminated' con cero fichas no
        // esta vivo: esta muerto y esperando a que collectEliminations le adjudique la
        // posicion. Contarlo como vivo hacia que este reconciliador, que deberia ser la
        // red de seguridad, le pelease el contador al gestor de campos y le devolviera el
        // eliminado.
        //
        // El efecto era que el campo no llegaba nunca de 2 a 1: el contador se quedaba en
        // 3, checkCompletion no disparaba, y el campo con dos jugadores sentados y con
        // fichas se quedaba esperando para siempre. 12 000 rondas, 12 de 13 posiciones
        // adjudicadas y ni la ultima.
        //
        // 'eliminated' y 'out' son estados resueltos: los dos significan que ese jugador
        // ya no esta jugando. Los dos se saltan.
        if (seat.status === 'out' || seat.status === 'eliminated') continue;

        const id = Number(seat.playerId);
        if (Number.isNaN(id)) continue;

        if (vistos.has(id)) {
          logger.error(
            `Campo ${field.fieldId}: el jugador ${id} esta en dos mesas a la vez ` +
            `(${t.tableId} y otra). Es un bug de fusion.`,
          );
          continue;
        }

        vistos.add(id);
        vivos++;
      }
    }

    if (vivos === field.playersRemaining) return;

    // ------------------------------------------------------------------
    // DIAGNOSTICO DE QUIEN FALTA
    //
    // Saber que el numero no cuadra no dice nada. Saber QUE jugador no esta donde
    // deberia si dice mucho, y es la diferencia entre diez minutos y dos horas.
    //
    // Se listan tres conjuntos:
    //   - quien tiene posicion adjudicada pero no esta en ninguna mesa viva: se fue
    //     sin que nadie lo recogiera. Es el caso que nos importa.
    //   - quien esta en las mesas pero no tiene posicion: aun no ha sido eliminado,
    //     o se ha colado sin adjudicar.
    //   - el desajuste de identificadores, por si el problema es de ids y no de
    //     jugadores.
    // ------------------------------------------------------------------
    const conPosicion = new Set(
      (field.results ?? []).map((r) => r.telegramId).filter((id) => Number.isFinite(id)),
    );
    const sinPosicion = [...vistos].filter((id) => !conPosicion.has(id));
    const sinMesa = [...conPosicion].filter((id) => !vistos.has(id));

    logger.warn(
      `Campo ${field.fieldId}: el contador de vivos decia ` +
      `${field.playersRemaining} y hay ${vivos} jugadores reales en las mesas. ` +
      'Se corrige al valor real.',
    );

    if (sinMesa.length > 0) {
      logger.warn(
        `  ${sinMesa.length} con posicion adjudicada pero NO estan en ninguna mesa viva: ` +
        sinMesa.slice(0, 12).join(', ') +
        (sinMesa.length > 12 ? '...' : ''),
      );
    }
    if (sinPosicion.length > 0) {
      logger.warn(
        `  ${sinPosicion.length} en las mesas SIN posicion adjudicada: ` +
        sinPosicion.slice(0, 12).join(', ') +
        (sinPosicion.length > 12 ? '...' : ''),
      );
    }

    await Field.updateOne({ _id: field._id }, { $set: { playersRemaining: vivos } });
    field.playersRemaining = vivos;
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

    // ------------------------------------------------------------------
    // QUIEN YA TIENE POSICION ADJUDICADA
    //
    // La posicion va en `Field.results`, y NO se deduce del estado del asiento. Por
    // dos razones, y las dos_importantes:
    //
    //  a) Idempotencia. Un asiento marcado `out` pero con una mano en curso no se
    //     puede marcar de otra forma hasta que la mano termine (ver mas abajo), asi
    //     que en el siguiente ciclo lo volverian a encontrar como `eliminated` y le
    //     adjudicarian una SEGUNDA posicion. Con `playersRemaining` decrementandose
    //     dos veces por eliminado, el contador del campo se descuadraba y los
    //     jugadores siguientes recibian posiciones que no les tocaban.
    //
    //  b) El asiento no es una fuente fiable. Se borra cuando la mano se cierra, y
    //     un jugador eliminado puede estar en varias fases distintas segun cuando se
    //     mire. Los resultados del campo son el unico registro que depende solo del
    //     campo.
    //
    // Se lee UNA vez por pasada y se consulta en memoria: con 300 jugadores y
    // cientos de eliminaciones, ir al campo `results` por cada asiento seria una
    // consulta por eliminado.
    const yaAdjudicados = new Set(
      (field.results ?? []).map(r => r.telegramId),
    );

    for (const table of tables) {
      const busted = table.seats.filter(
        s => s.kind === 'human' && s.status === 'eliminated',
      );

      // DIAGNOSTICO
      logger.warn(
        `DIAG-ELIM ${table.tableId}: fase="${table.hand.phase}" ` +
        `asientos=[${table.seats.map((s) => s.index + ':' + s.kind + ':' + s.status + ':' + s.chips).join(' ')}] ` +
        `busted=${busted.length}`,
      );

      if (busted.length === 0) continue;

      // Fichas de los eliminados que pasan al bote del campo. Se lee, no se
      // muta: esta copia de la mesa no se vuelve a guardar (ver mas abajo).
      const deadHere = busted.reduce(
        (sum, s) => sum + Math.max(0, s.chips) + Math.max(0, s.bet),
        0,
      );

      // Cuantos se adjudican posicion en esta pasada. Los que ya la tienen se
      // cuentan aparte: se marcan `out` pero no vuelven a decrementar el contador.
      let seatsLiquidados = 0;

      for (const seat of busted) {
        const telegramId = Number(seat.playerId);

        // Ya tiene posicion: no se le adjudica otra.
        if (yaAdjudicados.has(telegramId)) {
          seatsLiquidados++;
          continue;
        }

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

        // El objeto en memoria, por lo mismo que en `trySeat`. `new: false` devuelve el
        // documento ANTES del cambio, asi que `updated` ya lleva los valores nuevos.
        //
        // Sin esto, las decisiones que leen estos numeros (que el campo ha terminado,
        // cuantos vivos quedan, que posicion le toca al eliminado) van con un valor viejo.
        if (updated) {
          field.playersRemaining = updated.playersRemaining;
          field.eliminated = updated.eliminated;
        }

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

        // ------------------------------------------------------------------
        // LAS FICHAS DEL ELIMINADO NO VUELVEN A SU CARTERA
        //
        // Este era el dreno mas grave que tenia el producto, y no se puede ver
        // leyendo el codigo: `refund` suma a `balance.real` y parece una devolucion
        // razonable.
        //
        // En un campo, un eliminado que conserva fichas las ha perdido: las fichas
        // de un Sit'n'Go se quedan en el bote para los demas. Devolverlas seria:
        //
        //   1. Depositar 1 USDT.
        //   2. Comprar entrada de 1 USDT a un campo.
        //   3. Ser eliminado con las fichas casi intactas.
        //   4. Recoger el buy-in de vuelta en `balance.real`.
        //   5. Repetir.
        //
        // El unico coste del ciclo es el rake, y el rake se cobra POR MANO. Un
        // jugador eliminado antes de la primera mano no paga nada: el ciclo es
        // gratis y se puede repetir indefinidamente.
        //
        // Con esto las fichas se quedan en el asiento hasta que `settleField` barra el
        // bote. No se ponen a cero aqui: desaparecerian de la contabilidad y el campo
        // devolveria menos de lo que cobro.
        await this.recordResult(field, {
          position,
          telegramId,
          username: seat.displayName,
          amount: 0,
          tableId: table.tableId,
        });

        yaAdjudicados.add(telegramId);
        seatsLiquidados++;

        logger.info(
          `Campo ${field.fieldId}: jugador ${telegramId} eliminado ` +
          `en la posicion ${position} (mesa ${table.tableId})`,
        );
      }

      // ------------------------------------------------------------------
      // MARCAR `out` EN CUANTO SE ADJUDICA LA POSICION
      //
      // Antes solo se marcaba cuando `hand.phase` era `idle`. La idea era no tocar
      // un asiento que el motor tuviera en la mano, y era correcta, pero
      //practicamente inalcanzable: una mesa esta casi siempre con una mano en curso, asi que el
      // asiento se quedaba `eliminated` para siempre, ocupaba plaza, `seatsFree`
      // daba 0 y las merges no ocurrian jamas.
      //
      // La solucion no es esperar a un momento que no llega, sino hacer que el motor
      // aguante que un asiento se marque `out` con la mano en marcha: `out` le dice
      // "este jugador ya no esta en el campo", y el motor lo pliega y sigue. Ese
      // guard esta en `TableManager`, en `scheduleTurn` y `checkTurnTimeout`.
      //
      // Aqui ya no hay riesgo de adjudicar dos veces: `yaAdjudicados` lo impide, y
      // por eso el contador del campo baja una vez por eliminado y no mas.
      const hayManoViva =
        table.hand.phase !== 'idle' && table.hand.phase !== 'idle-awaiting';

      if (seatsLiquidados > 0) {
        const resOut = await Table.updateOne(
          { _id: table._id },
          { $set: { 'seats.$[s].status': 'out' } },
          { arrayFilters: [{ 's.status': 'eliminated' }] },
        );

        // Si no se modifica nada, hay asientos `eliminated` en la copia que leimos
        // que en la base ya no lo estan. Eso significa que otro gestor escribio la
        // mesa despues de nuestra lectura, y es exactamente el tipo de carrera que
        // hacia que los asientos nunca se liberaran. Merece un aviso: significa que
        // la mesa y el campo estan stepping el uno sobre el otro.
        logger.warn(
          `DIAG-OUT ${table.tableId}: marcando out ${seatsLiquidados} ` +
          `liquidados. modificados=${resOut.modifiedCount} ` +
          `manoViva=${hayManoViva}`,
        );

        if (resOut.modifiedCount === 0) {
          logger.warn(
            `Campo ${field.fieldId}: se quiso marcar 'out' a ${seatsLiquidados} ` +
            `asiento(s) de ${table.tableId} y no se modifico ninguno. ` +
            'La mesa cambio entre la lectura y la escritura.',
          );
        }

        const tras = await Table.findById(table._id);
        logger.info(
          (tras ? tras.seats.map(s => `${s.index}:${s.status}`).join(' ') : 'no existe') +
          ` (modificados=${resOut.modifiedCount})`,
        );
      } else {
        logger.debug(
          `Campo ${field.fieldId}: ${table.tableId} tiene ${busted.length} ` +
          'eliminado(s) pero ninguno nuevo que liquidar.',
        );
      }

      // ------------------------------------------------------------------
      // LIBERAR LOS ASIENTOS `out` CUANDO LA MESA ESTA EN REPOSO
      //
      // `TableManager.finishHand` tambien libera asientos, pero solo cuando se cierra
      // una mano. Eso no basta: una mesa puede quedarse con UN solo jugador activo, y
      // entonces `startHand` no arranca ninguna mano (hacen falta dos), nunca se cierra
      // ninguna, y los asientos `out` ocupan plaza para siempre. La mesa queda
      // muerta y, como `seatsFree` da 0, tampoco puede fusionarse con la otra.
      //
      // Se vio jugando un campo entero: una mesa con 1 activo y 6 `out`, en reposo
      // perpetuo, y el campo con 4 vivos repartidos entre dos mesas que no se unian.
      //
      // Aqui si se puede quitar el asiento sin riesgo, porque `hand.phase === 'idle'`
      // significa que no hay ninguna mano viva: ningun motor tiene activos a esos
      // jugadores y sus indices no le afectan a nadie.
      // ------------------------------------------------------------------
      // SOLTAR ES INDEPENDIENTE DE ADJUDICAR
      //
      // Antes la condicion era `!hayManoViva && seatsLiquidados > 0`, y encadenaba dos
      // decisiones que no tienen relacion.
      //
      // El caso que se perdia: se adjudica con la mano EN MARCHA, asi que los asientos se
      // marcan `out` pero no se pueden soltar. Cuando la mano acaba, la mesa queda en
      // reposo y ya no hay nada nuevo que adjudicar (`busted` son los `out`, no los
      // `eliminated`), asi que `seatsLiquidados` vale 0 y la liberacion no se intenta
      // NUNCA MAS. Los asientos se acumulan, `seatsFree` da 0, las merges no ocurren, y la
      // mesa se queda sin asientos jugables.
      //
      // Lo que decide es solo lo que tiene sentido: si hay asientos `out` y la mesa esta en
      // reposo, se sueltan. Ni mas ni menos.
      // ------------------------------------------------------------------
      const hayOutParaSoltar = table.seats.some((s) => s.status === 'out');

      if (!hayManoViva && hayOutParaSoltar) {
        // Se relee la mesa, se filtra el array en memoria y se escribe SOLO `seats`
        // con un `$set` dirigido. No se guarda el documento entero, asi que `hand` no
        // se toca (que es lo que rompia las mesas antes).
        //
        // Se descarta `$pull` a proposito: sobre un array de subdocumentos con campos
        // `required` deja HUECOS (entradas nulas) en lugar de compacta el array, y al
        // releer, mongoose ve subdocumentos `undefined` y revienta la validacion con
        // "seats.3.displayName: Path `displayName` is required". Filtrar en memoria y
        // escribir el array entero no tiene ese problema.
        //
        // Y ANTES de soltarlos, SUS FICHAS PASAN AL BOTE DEL CAMPO.
        //
        // Esto no es un extra: es lo que faltaba. `collectEliminations` deja las fichas
        // del eliminado en su asiento a proposito, y quitar el asiento sin pasarlas a
        // `deadChips` las borra. Ver `liberarAsientosLiquidados`: 15 % del bote
        // evaporado en un campo entero.
        const paraLiberar = await Table.findById(table._id);
        if (paraLiberar) {
          const sinLiberar = paraLiberar.seats.length -
            paraLiberar.seats.filter((s) => s.status !== 'out').length;

          if (sinLiberar > 0) {
            await this.liberarAsientosLiquidados(field, paraLiberar);
            logger.info(
              `Campo ${field.fieldId}: ${table.tableId} libera ${sinLiberar} ` +
              `asiento(s) de eliminados ya liquidados.`,
            );
          }
        }
      }

      // Registrar en el campo: el contador de la mesa, el del campo, y las fichas de
      // los eliminados, que siguen siendo del campo y se recogen al repartir.
      //
      // Esto NO guarda la mesa entera. Antes se hacia `table.save()` con una copia
      // leida antes, y el `hand` de esa copia pisaba el que el gestor de mesas
      // acababa de dejar en `idle`. La mesa se quedaba con una fase a medias y sin
      // motor en memoria, y tampoco podia arrancar la mano siguiente: era otro
      // congelamiento, del mismo tipo y por la misma causa de fondo, dos gestores
      // escribiendo el mismo documento.
      await Field.updateOne(
        { _id: field._id },
        {
          $inc: {
            'tables.$[t].eliminated': busted.length,
            deadChips: deadHere,
          },
        },
        { arrayFilters: [{ 't.tableId': table.tableId }] },
      );

      if (deadHere > 0) {
        logger.info(
          `Campo ${field.fieldId}: ${formatUnits(deadHere)} USDT de fichas de ` +
          `eliminados pasan al bote del campo desde la mesa ${table.tableId}`,
        );
      }
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
        await this.closeEmptyTable(field, source.table);
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
          if (!seat) {
            // ------------------------------------------------------------------
            // NO SE PIERDE UN JUGADOR EN UNA FUSION. NUNCA.
            //
            // Antes habia un `continue` aqui, y era una bomba de reloj. Si el plan de
            // fusion mencionaba un asiento que ya no estaba en la mesa, el jugador
            // desaparecia del campo sin adjudicarse posicion: sus fichas y su
            // buy-in se perdian, y el contador `playersRemaining` se quedaba un punto
            // por encima, con lo que todos los siguientes recibian una posicion
            // desplazada.
            //
            // Un jugador que desaparece del campo sin adjudicarse es exactamente el
            // bug que quedaba abierto: el contador decia 6 vivos con 3 asientos
            // reales. Si aqui se pierde uno, el contador vuelve a mentir.
            //
            // Lo que se hace es no tocar la mesa origen (el jugador se queda donde
            // esta, vivo y cobrado) y avisar. Perder un jugador es malo; perderlo en
            // silencio, sin registro, es peor.
            // ------------------------------------------------------------------
            logger.error(
              `Campo ${field.fieldId}: la fusion de ${source.table.tableId} menciona` +
              `el asiento ${seatIndex}, que no esta en la mesa. El jugador NO se ` +
              'mueve y se queda en la mesa origen. Hay que revisarlo a mano.',
            );
            continue;
          }

          // Reindizar: el destino puede tener menos jugadores, y el motor usa
          // el indice de asiento como id del jugador. Un indice duplicado
          // haria que un jugador actuara como si fuera dos.
          // El indice libre, no `target.seats.length`. Ver `primerIndiceLibre`: los
          // indices tienen huecos en cuanto se libera un asiento, y repetir uno mete a
          // dos jugadores en la misma identidad dentro del motor.
          const newIndex = this.primerIndiceLibre(target.seats);
          source.table.seats = source.table.seats.filter(s => s.index !== seatIndex);

          // `toObject()` Y NO `{ ...seat }`.
          //
          // Un asiento de la mesa es un SUBDOCUMENTO de mongoose, no un objeto
          // plano. El operador de spread copia las propiedades propias del
          // documento, no los campos de su esquema, asi que el asiento llega al
          // destino sin `kind`, ni `playerId`, ni `displayName`. Al guardar la mesa,
          // la validacion del esquema revienta:
          //
          //   Table validation failed: seats.2.displayName: Path `displayName` is
          //   required.
          //
          // Este camino no se ejecutaba nunca antes, porque las merges no ocurrian
          // (`seatsFree` daba 0). Ha estado roto desde que existe, y solo se ha
          // visto al arreglar los bloqueos que lo impedian llegar aqui.
          //
          // `toObject()` devuelve el objeto plano con los valores del esquema, que
          // es lo que el array de asientos espera. El `index` se sobrescribe
          // despues porque cambia al reindexar.
          const copia = ((seat as any).toObject ? (seat as any).toObject() : { ...seat }) as ISeat;
          target.seats.push({ ...copia, index: newIndex });
        }
        this.assertIndicesUnicos(target.tableId, target.seats);
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
  /**
   * Cierra una mesa del campo que se ha quedado sin jugadores activos.
   *
   * ------------------------------------------------------------------
   * LAS FICHAS NO SE DEVUELVEN A LA CARTERA. VAN AL BOTE DEL CAMPO.
   *
   * Aqui estaba el mismo dreno que ya se corrigio en `collectEliminations`, en la
   * otra funcion que tocaba fichas de un eliminado: `refund` suma a
   * `balance.real`. En un campo las fichas de una mesa son del bote. Devolverlas es
   * crear dinero: el jugador recupera su buy-in y ademas se le paga su parte del
   * premio.
   *
   * Lo encontro el test del motor: un campo de 14 jugadores se cerraba con 1,127 USDT
   * de mas en el sistema, y la desviacion era exactamente esta devolucion.
   *
   * Lo correcto es lo mismo que se hace al eliminar a un jugador: las fichas salen de
   * la mesa y entran en `Field.deadChips`, de donde `settleField` las reparte.
   */
  async closeEmptyTable(field: IField, table: ITable): Promise<void> {
    let alBote = 0;

    for (const seat of table.seats) {
      alBote += Math.max(0, seat.chips) + Math.max(0, seat.bet);
    }

    if (alBote > 0) {
      await Field.updateOne({ _id: field._id }, { $inc: { deadChips: alBote } });
      field.deadChips = (field.deadChips || 0) + alBote;
      logger.info(
        `Campo ${field.fieldId}: ${table.tableId} se cierra sin jugadores activos. ` +
        `${formatUnits(alBote)} USDT de fichas pasan al bote del campo.`,
      );
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
        // `toObject()` por el mismo motivo que en `checkMerges`: el spread de un
        // subdocumento pierde los campos del esquema y la validacion revienta al
        // guardar. Ver el comentario de ahi.
        const copia = ((seat as any).toObject ? (seat as any).toObject() : { ...seat }) as ISeat;
        keeper.seats.push({ ...copia, index: this.primerIndiceLibre(keeper.seats) });
      }
      donor.seats = [];
      donor.status = 'finished';
      if (donor.field) donor.field.fieldStatus = 'finished';
      await donor.save();
      await this.retireTable(field, donor);
    }

    this.assertIndicesUnicos(keeper.tableId, keeper.seats);

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

// ------------------------------------------------------------------
    // EL BOTE SON LAS FICHAS QUE HAY EN LAS MESAS
    //
    // Antes se hacía una de dos cosas, y las dos estaban mal:
    //
    //   a) Se calculaba el premio con `fieldPayout(buyInUnits, playersRemaining)`,
    //      es decir un bote NUEVO calculado desde el buy-in y los participantes.
    //   b) Después se devolvía a `balance.real` las fichas de TODOS los asientos
    //      que quedaban, incluido el ganador.
    //
    // Las dos juntas creaban dinero de la nada: se pagaba un premio que no salía
    // de ningún bote Y se devolvía el bote entero. Con 300 jugadores de 1 USDT, el
    // campo terminaba con 129,25 USDT más de los que había.
    //
    // Y por debajo había un dreno mucho peor en `collectEliminations`, que
    // devolvía las fichas del eliminado a su cartera. En un campo, eso significa
    // comprar entrada, ser eliminado con las fichas intactas y recuperar el
    // buy-in. Repetido, es un ciclo gratis.
    //
    // LO CORRECTO, y es como funciona un Sit'n'Go:
    //
    //   - Las fichas de un eliminado NO vuelven a su cartera. Se quedan en el bote
    //     para los demás. Por eso el rake es real y el campo tiene sentido.
    //   - El bote es lo que se barre de las mesas, no un cálculo paralelo.
    //   - Se reparte entre las posiciones que existen, y lo que sobra (posiciones
    //     sin nadie adjudicado) se lo lleva el ganador, que es como funciona de
    //     verdad: el que gana se lleva la pila.
    //
    // Barrer las fichas y ponerlas a cero es también lo que impide que una
    // segunda liquidación las pague otra vez.
    const tables = await Table.find({ 'field.fieldId': field.fieldId });

    let swept = 0;
    for (const t of tables) {
      let tableSwept = 0;

      // Lo que hay delante de cada asiento.
      let enAsientos = 0;
      let enBotesDeAsiento = 0;
      for (const seat of t.seats) {
        enAsientos += Math.max(0, seat.chips);
        enBotesDeAsiento += Math.max(0, seat.bet);
        seat.chips = 0;
        seat.bet = 0;
      }

      // ------------------------------------------------------------------
      // EL BOTE DE LA MANO EN CURSO, Y POR QUE SE TOMA EL MAXIMO
      //
      // Antes se sumaba `seat.bet` y nada mas. Con la mano en curso, ese dinero se
      // evaporaba: estaba en el bote y no se pagaba a nadie.
      //
      // Pero tampoco se puede sumar `seat.bet` Y `hand.pot` a la vez, y este es el
      // detalle que hace que un arreglo rapido sea un bug peor que el original:
      // `syncEngineToTable` escribe `seat.bet = player.bet` y `hand.pot = state.pot`,
      // y el bote ES la suma de lo que puso cada uno. Son las mismas fichas.
      // Sumarlas cuenta el bote dos veces y crea dinero de la nada.
      //
      // Ademas hay un momento en que las dos cosas no coinciden: `endGame` deja
      // `state.pot` en 0 pero no toca `player.bet`, asi que entre que acaba la mano
      // y que `finishHand` limpia, se da `hand.pot = 0` con `seat.bet` todavia
      // entero. Ese dinero es real y hay que cobrarlo.
      //
      // El maximo cubre los tres estados y nunca cuenta el bote dos veces:
      //
      //   mano en curso    hand.pot == suma de seat.bet   -> se cuenta el bote
      //   mano recien acabada  hand.pot == 0               -> se cuenta lo que apostaron
      //   mesa en reposo    los dos a cero                -> no hay nada que cobrar
      // ------------------------------------------------------------------
      const enElBote = Math.max(Math.max(0, t.hand.pot || 0), enBotesDeAsiento);
      t.hand.pot = 0;

      tableSwept = enAsientos + enElBote;

      if (tableSwept > 0 || enBotesDeAsiento > 0 || (t.hand.pot || 0) === 0) {
        swept += tableSwept;
        await t.save();
      }
    }

    // Mas las fichas de los eliminados, que `collectEliminations` sacado de las
    // mesas para liberar el sitio y metio aqui. Son tan del campo como las que
    // siguen en la mesa, y sin esta linea desaparecerian del reparto: el campo
    // devolveria menos de lo que cobro y el bote se perderia por el camino.
    const dead = Math.max(0, field.deadChips || 0);
    swept += dead;

    // Y SE PONEN A CERO, porque se pagan.
    //
    // Esto no es cosmetico. `deadChips` son fichas que ya seenni entregar a los
    // jugadores dentro de `swept`, asi que si el documento del campo las sigue
    // declarando, cualquier lectura posterior las cuenta por segunda vez: el campo
    // queda diciendo que debe dinero que ya entrego.
    //
    // Se vio en el test de integracion: al cerrar el campo, `deadChips` valia 5 842 y
    // las fichas se pagaron a los jugadores. La cuenta dio +6 687 de golpe, y el
    // reparto habia sido correcto. No habia ningun bug en el reparto: habia dos
    // veces la misma dinero en el papel.
    //
    // Se pone a cero ANTES del cierre atomico de mas abajo, que se hace con
    // `findOneAndUpdate` sobre `status`, asi que un `$set` aparte no compite con el.
    if (dead > 0) {
      await Field.updateOne({ _id: field._id }, { $set: { deadChips: 0 } });
      field.deadChips = 0;
    }

// ------------------------------------------------------------------
    // EL RAKE, Y CUANTO SE REPARTE
    //
    // El rake de un campo se cobra SOBRE EL BOTE ENTERO, no por mano. Antes
    // dependia de lo que hubiera acumulado el gestor de mesas mano a mano, y con los
    // tiers pequenos eso era CERO SIEMPRE: el t1 tiene buy-in de 1 USDT (1 000
    // unidades), ciegas de 5 y 10 y pots de 15 a 40 unidades. El 5% de 15 es 0,75, y
    // redondeado hacia abajo es 0. Un campo de 300 jugadores repartia 300 USDT sin
    // que la plataforma ganara un centimo, por mucho tiempo que costara.
    //
    // Se comprobo jugando un campo entero de verdad: 200 manos por mesa, rake 0. El
    // RTP del 95% que documentan `fieldPayout` y `tierRtp` era correcto en la
    // teoria y falso en la ejecucion.
    //
    // Sobre `buyInsCollected` el resultado es estable y da el 5% documentado.
    //
    // Se toma el MAXIMO entre lo ya cobrado por mano y el del campo, no la suma: si
    // las mesas ya cobraron su parte no se vuelve a cobrar. Asi el rake total es el
    // 5% del campo, venga como venga la distribucion de manos.
    const grossPot = field.buyInsCollected;
    const rakeObjetivo = rakeOfField(grossPot);
    let rake = Math.max(field.rakeCollected, rakeObjetivo);
    const netPot = Math.max(0, grossPot - rake);

    // ------------------------------------------------------------------
    // CUANTO SE REPARTE: NUNCA MAS DE `grossPot - rake`
    //
    // Lo repartido NO es lo barrado a secas, sino el menor entre lo barrado y el
    // neto que la plataforma debe. La diferencia se queda la plataforma.
    //
    // Esto lo fija una prueba, no una teoria. Si se reparte `swept` tal cual y las
    // fichas de las mesas son mas de `grossPot - rake`, se le devuelve el rake a
    // los jugadores y el producto deja de tener ingresos. En un test de 12
    // jugadores repartia 12 USDT en vez de 11,4 y la plataforma se quedaba sin nada.
    //
    // Puede pasar porque el rake por mano se registra sobre pots reales, que no
    // suman exactamente el 5% del campo. Repartir el minimo hace que el error sea
    // hacia el lado conservador: la plataforma retiene la diferencia en vez de
    // regalarla.
    const distributable = Math.min(swept, netPot);
    const withheld = swept - distributable;
    const faltan = netPot - swept;

    if (faltan > 0) {
      // ------------------------------------------------------------------
      // FALTAN FICHAS, Y ESO ES UN BUG, NO UN INGRESO
      //
      // Lo barrido es MENOR que lo que deberia haber. O sea: hay `faltan` unidades
      // dentro del campo que no estan en ningun asiento, en ningun bote y en
      // `deadChips`. Se han perdido por el camino.
      //
      // Antes se hacia `rake = buyInsCollected - repartido`, que en este caso
      // significa apuntarse como ingreso justo lo que se ha perdido. En el test de
      // integracion eso dio un rake de 7 417 sobre un bote de 14 000: un 53 %.
      //
      // Convertir una fuga en ingresos es lo peor que puede hacer la contabilidad,
      // porque tapa el bug y ademas el mes sale bien. Aqui el rake se queda en el 5 %
      // real y la diferencia se avisa como error, con las cifras, para que se vea.
      // ------------------------------------------------------------------
      logger.error(
        `Campo ${field.fieldId}: FALTAN ${formatUnits(faltan)} UNIDADES. ` +
        `Entraron ${formatUnits(grossPot)}, el rake del 5 % son ${formatUnits(rakeObjetivo)} ` +
        `y se han repartido ${formatUnits(distributable)}, pero solo havia ` +
        `${formatUnits(swept)} en las mesas y en deadChips. ` +
        'El rake se queda en el 5 % real: la diferencia NO son ingresos de la ' +
        'plataforma, es dinero que ha desaparecido y hay que buscar donde.',
      );
    } else if (withheld > 0) {
      // Aqui la diferencia es en el otro sentido, y si es dinero real: hay mas
      // fichas de las que el neto permite repartir. La diferencia se queda la
      // plataforma, que es justo lo que hace falta para que nunca se devuelva el
      // rake por accidente.
      logger.warn(
        `Campo ${field.fieldId}: sobran ${formatUnits(withheld)} unidades ` +
        `(fichas ${formatUnits(swept)}, neto a repartir ${formatUnits(netPot)}). ` +
        'La diferencia se queda la plataforma y no se reparte.',
      );
    }

    // ------------------------------------------------------------------
    // `rakeCollected` SE FIJA, NO SE INCREMENTA
    //
    // El rake del campo tiene que ser exactamente lo que la plataforma se ha
    // quedado, y eso es `grossPot - distributable` por definicion. Incrementarlo con
    // lo retenido lo contaria dos veces: el rake ya cobrado por mano mas la
    // diferencia entre las fichas y el neto, que describen la misma realidad desde
    // dos angulos.
    //
    // Fijarlo hace que la contabilidad del campo no pueda desviarse de la del
    // dinero: si las dos cifras no coinciden, hay un bug, y el test de integracion
    // lo detecta comparando el rake registrado con el dinero que de verdad salio de
    // los saldos.
    //
    // Solo se admite la retencion EXTRA cuando hay fichas de sobra, que es dinero
    // real que la plataforma se queda de verdad. Cuando lo que hay es MENOS, la
    // retencion seria ficticia y `rakeCollected` dejaria de ser lo que salio de los
    // jugadores. En ese caso el rake es el 5 % y la fuga queda a la vista.
    const rakeReal = faltan > 0
      ? rakeObjetivo
      : Math.max(0, grossPot - distributable);

    // Se escribe SIEMPRE, no solo cuando cambia.
    //
    // Antes era `if (rakeReal !== rake) { ...update... }`, y eso hacia que el rake del
    // campo no se guardara nunca en el caso normal: `rake` ya valia `rakeObjetivo` (el
    // 5 % del bote), que es justo lo mismo que `rakeReal` cuando lo barrido cuadra.
    // La condicion nunca se cumplia, el campo se quedaba con `rakeCollected = 0` y el
    // panel de operador mostraba que el campo no habia generado nada, que es
    // justamente lo contrario de la verdad.
    //
    // Lo detectó el test de integracion: los saldos bajaban 15 USDT (el rake se
    // retenia de verdad) pero el campo decia cero, y la comparacion entre ambos
    // numeros no cuadraba.
    rake = rakeReal;
    await Field.updateOne(
      { _id: field._id },
      { $set: { rakeCollected: rakeReal } },
    );

    // El reparto por posicion. `FIELD_PAYOUT` suma 100, asi que las partes cubren
    // todo el bote; lo que sobre por posiciones sin adjudicado va al ganador.
    const shares = splitPrize(distributable, FIELD_PAYOUT);

    // Las posiciones ya adjudicadas durante el campo (las de `collectEliminations`).
    // Se leen de `field`, no del documento cerrado: el cierre atomico de mas abajo
    // todavia no se ha hecho cuando se reparte.
    const results = field.results ?? [];

    const paid: FieldResultOut['paid'] = [];
    /** Lo que ya se ha repartido, para no pagar dos veces la misma posicion. */
    const paidByPosition = new Set<number>();
    /** Dinero que no tiene destinatario y va al ganador. */
    let remainder = 0;

    const winnerId = winner ? Number(winner.playerId) : null;

    for (let i = 0; i < shares.length; i++) {
      const position = i + 1;
      const amount = shares[i];
      if (amount <= 0) continue;

      // La posicion 1 es el ganador. Las demas, los resultados ya registrados.
      const result = position === 1
        ? null
        : results.find(r => r.position === position && !paidByPosition.has(r.position));

      let telegramId: number | null = null;
      let username: string | undefined;
      let tableId: string | undefined;

      if (position === 1 && winnerId !== null) {
        telegramId = winnerId;
        username = winner!.displayName;
      } else if (result) {
        telegramId = result.telegramId;
        username = result.username;
        tableId = result.tableId;
        paidByPosition.add(position);
      }

      if (telegramId === null) {
        // Nadie ocupa esta posicion todavia (no se ha eliminado nadie todavia, o
        // el campo se liquida antes de tiempo). No se pierde: al ganador.
        remainder += amount;
        continue;
      }

      await this.creditPrize(telegramId, amount, position);
      paid.push({ position, telegramId, username, amount, tableId });
    }

    // Lo que no correspondia a ninguna posicion existente se lo lleva el ganador,
    // que en un Sit'n'Go es exactamente lo que hace: se lleva la pila.
    if (remainder > 0) {
      if (winnerId !== null) {
        await this.creditPrize(winnerId, remainder, 1);
        logger.info(
          `Campo ${field.fieldId}: ${formatUnits(remainder)} USDT de posiciones sin ` +
          `adjudicar van al ganador ${winnerId}`,
        );
      } else {
        // Sin ganador no hay a quien darselo. Se registra para que el operador lo
        // vea en el panel: es dinero que la plataforma tiene que devolver a mano.
        logger.error(
          `Campo ${field.fieldId}: ${formatUnits(remainder)} USDT sin destinatario ` +
          `(no hay ganador y hay posiciones sin adjudicar). Hay que devolverlos a mano.`,
        );
      }
    }

    // --- Cerrar el campo (atomico) ---
    const closed2 = await Field.findOneAndUpdate(
      { fieldId: field.fieldId, status: { $ne: 'finished' } },
      {
        $set: { status: 'finished', finishedAt: new Date() },
        $inc: { paidPositionsLeft: -PAID_POSITIONS },
      },
      { new: true },
    );

    if (!closed2) {
      logger.warn(
        `Campo ${field.fieldId}: ya liquidado por otra via. No se paga dos veces.`,
      );
      return { paid, totalPaid: paid.reduce((s, p) => s + p.amount, 0), refunded: 0 };
    }

    // --- Devolver lo que no llego al bote ---
    // Los jugadores que quedaron fuera antes de empezar (los que estaban en cola
    // cuando el campo arranco) reciben su buy-in intacto. Esto SI es una devolucion
    // legitima: nunca llegaron a tener ficha en la mesa, asi que nunca entraron en
    // el bote que se acaba de barrer.
    const refunded = await this.refundUnseated(field);

    await Field.updateOne(
      { _id: field._id },
      { $set: { results: [...results, ...paid] } },
    );

    // Cerrar las mesas. Las fichas ya estan a cero por el barrido de arriba, asi
    // que aqui solo se vacian los asientos y se marca el estado. NO se reembolsa
    // nada: ese era el doble cobro.
    for (const t of tables) {
      if (t.status === 'finished') continue;
      t.seats = [];
      t.status = 'finished';
      if (t.field) t.field.fieldStatus = 'finished';
      await t.save();
    }

    const totalPaid = paid.reduce((s, p) => s + p.amount, 0) + remainder;

    logger.info(
      `Campo ${field.fieldId} liquidado: bote ${formatUnits(grossPot)} USDT, ` +
      `rake ${formatUnits(rake)} USDT, repartido ${formatUnits(totalPaid)} USDT ` +
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
      buyIn: field.buyInUnits,
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

  /**
   * Acredita un premio de campo en `balance.play`.
   *
   * ------------------------------------------------------------------
   * POR QUE EL PREMIO VA A `play` Y NO A `real`
   *
   * ESTA ES LA REGLA QUE PROTEGE A LA PLATAFORMA DE PERDER EL DINERO DE OTROS.
   *
   * Si el premio fuera a `balance.real`, ganar un campo seria indistinguible de
   * un deposito: se podrian comprar entradas con dinero de premio y, al jugarlas,
   * desbloquearlo a saldo retirable. Con el ratio 1:10 de `unlockService`, ganar
   * devuelve la décima parte de lo ganado en dinero gastable, y el resto sirve
   * para jugar. El premio es saldo EN JUEGO, no un ahorro.
   *
   * Y por eso el premio NO puede distinguirse del buy-in al pagarse: los dos
   * vuelven al mismo bote. El rake es lo unico que la plataforma se queda de forma
   * permanente, y es la unica fuente de ingresos del producto.
   */
  async creditPrize(telegramId: number, amount: number, position: number): Promise<void> {
    if (amount <= 0) return;

    await User.updateOne(
      { telegramId },
      {
        $inc: {
          'balance.play': amount,
          'stats.totalFreerollWon': amount,
        },
      },
    );

    logger.info(
      `Campo: ${telegramId} cobra ${formatUnits(amount)} USDT de promocion ` +
      `por la posicion ${position}`,
    );
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
