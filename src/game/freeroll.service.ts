/**
 * FREEROLLS HORARIOS MULTI-MESA
 * =============================
 *
 * Un freeroll de CubaPoker es un CAMPO, no una mesa suelta: hasta 300 jugadores repartidos
 * en mesas de 7 que se fusionan hasta la mesa final. Reutiliza `field.manager`, que ya sabe
 * repartir asientos, fusionar mesas, adjudicar posiciones y liquidar.
 *
 * ------------------------------------------------------------------
 * QUE HACE ESTE SERVICIO QUE NO HAGA EL GESTOR DE CAMPOS
 *
 * Tres cosas, y las tres son de RELOJ, no de poker:
 *
 *   1. ABRIR el campo de la proxima hora. Siempre hay exactamente uno en inscripcion.
 *   2. ARRANCARLO a su hora, aunque haya un solo humano. Si hay menos de dos, se rellena
 *      con bots: la decision fue que es mejor un torneo con un bot que un torneo cancelado.
 *   3. CERRAR el que no arranco y abrir el siguiente. Sin esto, un reinicio del servidor
 *      deja un campo `filling` para siempre y nadie vuelve a ver un freeroll.
 *
 * ------------------------------------------------------------------
 * EL REGISTRO TARDIO Y EL REINICIO
 *
 * La cola de espera vive en un `Map` del proceso. Al reiniciar se pierde. Si el arranque se
 * limitara a llamar a `trySeat`, los jugadores apuntados seguirian en `registrations` pero no
 * en la cola, y el campo arrancaria con CERO sentados.
 *
 * Por eso `rehidratarCola` reconstruye la cola desde `registrations` antes de sentar. Es la
 * misma leccion del centroll: la verdad esta en la base, no en la memoria.
 */

import { Field, IField } from '../models/Field';
import { Table } from '../models/Table';
import { User } from '../models/User';
import { fieldManager, withFieldLock, FieldError } from './field.manager';
import { tableManager } from './table.manager';
import { logger } from '../utils/logger';
import { unitsToUsdt, formatUnits } from '../config/units';
import { FREEROLL_PAYOUT } from '../config/product';
import {
  PLAZAS_PAGADAS_FREEROLL,
  TAMANO_FREEROLL,
  FICHAS_INICIALES_FREEROLL,
  CIEGA_GRANDE_FREEROLL,
  CIEGA_PEQUENA_FREEROLL,
  MIN_JUGADORES_PARA_ARRANCAR,
  claveSlot,
  finRegistroTardio,
  premioHorarioUnits,
  proximoInicio,
  slotsProximos,
} from '../config/freeroll';

export class FreerollError extends Error {
  constructor(message: string, readonly code: string = 'FREEROLL_ERROR') {
    super(message);
  }
}

/** Aviso de "tu mesa esta lista". El bot lo traduce a un mensaje de Telegram. */
type AvisoInicio = (field: IField, jugadores: number[]) => void | Promise<void>;

let avisoInicio: AvisoInicio | null = null;

/**
 * Evita que dos vueltas del planificador se pisen.
 *
 * `setInterval` no espera a que la vuelta anterior termine. Si una tarda mas que el
 * intervalo (una liquidacion con 300 jugadores puede tardar), dos vueltas pueden intentar
 * arrancar el mismo campo a la vez. El cerrojo por campo lo evita igual, pero esto ahorra
 * trabajo y ruido en el log.
 */
let procesando = false;

export const freerollManager = {
  /** El bot registra aqui como quiere avisar a los jugadores. */
  setAvisoInicio(fn: AvisoInicio): void {
    avisoInicio = fn;
  },

  // ======================================================================
  // Apertura
  // ======================================================================

  /**
   * Abre el campo de la proxima hora si no hay ninguno en inscripcion.
   *
   * Se llama al arrancar el servidor y en cada vuelta del planificador. Es idempotente: si
   * ya hay uno abierto, lo devuelve tal cual.
   */
  async asegurarAbierto(): Promise<IField> {
    const existente = await Field.findOne({
      kind: 'freeroll',
      status: 'filling',
    }).sort({ scheduledStartAt: 1 });

    if (existente) {
      logger.debug(
        `Freeroll: ya hay uno en inscripcion (${existente.fieldId}, ` +
        `arranca ${existente.scheduledStartAt?.toISOString?.() ?? '?'}).`,
      );
      return existente;
    }

    return this.abrirSlot(proximoInicio());
  },

  /** Crea el campo de un slot concreto. Si ya existe, devuelve el que hay. */
  async abrirSlot(inicio: Date): Promise<IField> {
    const clave = claveSlot(inicio);
    const fieldId = `freeroll-${clave}`;
    const premio = premioHorarioUnits();

    const documento = {
      fieldId,
      kind: 'freeroll',

      // El `tierId` identifica la HORA, no un nivel de buy-in. Ademas de ser la clave del
      // slot, es lo que hace que el indice unico `un_campo_vivo_por_nivel` impida abrir dos
      // campos para la misma hora. Dos procesos a la vez: uno gana, el otro recibe E11000 y
      // entra al ganador.
      tierId: fieldId,

      status: 'filling',
      // Nadie paga entrada. El premio es de la casa y va aparte.
      buyInUnits: 0,
      prizePoolUnits: premio,

      // El reloj. Las dos fechas se guardan, no se recalculan al leer: el registro tardio
      // tiene que sobrevivir a un reinicio.
      scheduledStartAt: inicio,
      lateRegUntil: finRegistroTardio(inicio),

      // Fichas y ciegas del torneo. No son dinero: son puntos.
      startChips: FICHAS_INICIALES_FREEROLL,
      smallBlind: CIEGA_PEQUENA_FREEROLL,
      bigBlind: CIEGA_GRANDE_FREEROLL,

      targetField: TAMANO_FREEROLL,
      waiting: 0,
      seated: 0,
      playersRemaining: 0,
      paidPositionsLeft: PLAZAS_PAGADAS_FREEROLL,
      plannedTables: 0,
      tables: [],
    };

    for (let intento = 1; intento <= 3; intento++) {
      try {
        const field = await Field.create(documento);
        logger.info(
          `Freeroll ${fieldId} abierto: arranca ${inicio.toISOString()}, ` +
          `premio ${formatUnits(premio)} USDT, hasta ${TAMANO_FREEROLL} jugadores`,
        );
        return field;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;

        const ganador = await Field.findOne({ fieldId });
        if (ganador) return ganador;
      }
    }

    throw new FreerollError(
      'No se pudo abrir el freeroll. Intentalo de nuevo en un momento.',
      'OPEN_FAILED',
    );
  },

  // ======================================================================
  // Inscripcion
  // ======================================================================

  /**
   * Inscribe a un jugador en un freeroll.
   *
   * `fieldId` es opcional: si la UI manda el torneo que el jugador esta viendo, se usa ese
   * (asi no se apunta al siguiente por una carrera). Si no, se usa el que este abierto.
   */
  async registrar(
    telegramId: number,
    username?: string,
    fieldId?: string,
  ): Promise<{ fieldId: string; seated: boolean; position: number; late: boolean }> {
    const user = await User.findOne({ telegramId });
    if (!user) throw new FreerollError('Usuario no encontrado', 'NOT_FOUND');

    let field: IField | null = null;

    if (fieldId) {
      field = await Field.findOne({ fieldId, kind: 'freeroll' });
      if (!field) throw new FreerollError('Ese freeroll no existe', 'NOT_FOUND');
    } else {
      field = await this.asegurarAbierto();
    }

    // El cerrojo va por el campo concreto, no por el slot: dos personas pulsando JUGAR a la
    // vez comparten documento y sin esto el `$inc` y el `$push` pueden acabar en campos
    // distintos (el mismo fallo que dejo 18 campos abiertos en el cash).
    return withFieldLock(`freeroll:${field.fieldId}`, async () => {
      // Releer dentro del cerrojo: entre la consulta de arriba y aqui, el campo puede haber
      // arrancado o haberse cancelado.
      const fresco = await Field.findOne({ fieldId: field!.fieldId });
      if (!fresco) throw new FreerollError('El freeroll ya no esta disponible', 'NOT_FOUND');

      return fieldManager.registrarEnFreeroll(fresco, telegramId, username);
    });
  },

  /**
   * Sale de un freeroll antes de que empiece.
   *
   * ------------------------------------------------------------------
   * POR QUE DELEGA EN `fieldManager.unregister`
   *
   * La primera version solo miraba las entradas en estado `waiting`. Pero `trySeat` sienta
   * al jugador EN EL MISMO momento del registro si hay sitio, asi que el estado normal es
   * `seated`, no `waiting`. El boton "Cancelar inscripcion" devolvia 200 sin hacer nada: el
   * jugador seguia dentro y, cuando arrancaba el torneo, le tocaba jugar un torneo que creia
   * haber cancelado. Lo detecto la prueba de humo por HTTP, no el test del servicio.
   *
   * `unregister` ya hace las tres cosas bien para el cash: saca de la cola, quita el asiento
   * de la mesa y ajusta los contadores. Aqui solo hay que llamarlo sabiendo que el buy-in es
   * 0: `refund(0)` no hace nada y `buyInsCollected` se queda igual. Duplicar esa logica en
   * este servicio seria la forma mas facil de que las dos versiones se separen.
   * ------------------------------------------------------------------
   */
  async salir(telegramId: number, fieldId: string): Promise<{ salio: boolean }> {
    const field = await Field.findOne({ fieldId, kind: 'freeroll' });
    if (!field) throw new FreerollError('Ese freeroll no existe', 'NOT_FOUND');

    if (field.status !== 'filling') {
      throw new FreerollError(
        'El torneo ya empezo: no se puede cancelar la inscripcion.',
        'ALREADY_STARTED',
      );
    }

    try {
      // No devuelve dinero (la entrada es gratis), pero si quita el asiento y la anotacion.
      await fieldManager.unregister(telegramId, fieldId);
    } catch (error) {
      if (error instanceof FieldError && error.code === 'NOT_IN_FIELD') {
        return { salio: false };
      }
      throw error;
    }

    logger.info(`Freeroll ${fieldId}: ${telegramId} cancela su inscripcion.`);
    return { salio: true };
  },

  // ======================================================================
  // Planificador
  // ======================================================================

  /**
   * Una vuelta del reloj.
   *
   * Hace tres cosas en este orden, y el orden importa:
   *
   *   1. Abre el siguiente slot si no hay ninguno en inscripcion.
   *   2. Arranca los que ya han llegado a su hora.
   *   3. Cancela los que se quedaron sin arrancar (servidor caido, por ejemplo).
   */
  async procesar(): Promise<{ arrancados: number; cancelados: number }> {
    if (procesando) return { arrancados: 0, cancelados: 0 };
    procesando = true;

    let arrancados = 0;
    let cancelados = 0;

    try {
      // 1. Siempre tiene que haber uno en inscripcion.
      await this.asegurarAbierto();

      const ahora = new Date();

      const pendientes = await Field.find({
        kind: 'freeroll',
        status: 'filling',
        scheduledStartAt: { $lte: ahora },
      }).sort({ scheduledStartAt: 1 });

      for (const field of pendientes) {
        const cierre = field.lateRegUntil
          ? new Date(field.lateRegUntil)
          : new Date((field.scheduledStartAt?.getTime() ?? 0) + 12 * 60_000);

        // Se quedo atras: el servidor estuvo caido mas de lo que dura el registro tardio.
        // Arrancar un torneo de hace tres horas no es un torneo, es una confusion. Se
        // cancela y se sigue con el siguiente.
        if (ahora > cierre) {
          await this.cancelar(field, 'no arranco dentro del plazo');
          cancelados++;
          continue;
        }

        const humanos = (field.registrations ?? []).filter(
          (r) => r.status === 'waiting' || r.status === 'seated',
        );

        if (humanos.length === 0) {
          await this.cancelar(field, 'nadie se apunto');
          cancelados++;
          continue;
        }

        const ok = await this.arrancar(field);
        if (ok) arrancados++;
      }
    } catch (error) {
      logger.error('Freeroll: fallo la vuelta del planificador:', error);
    } finally {
      procesando = false;
    }

    return { arrancados, cancelados };
  },

  /**
   * Arranca un campo de freeroll.
   *
   * El orden es el que evita los dos fallos clasicos:
   *
   *   1. Rehidratar la cola desde la base (la memoria se pierde al reiniciar).
   *   2. Sentar a todos los inscritos.
   *   3. Rellenar con bots SOLO las mesas que tienen humanos, hasta dos.
   *   4. Arrancar el campo.
   *   5. Avisar a los jugadores.
   */
  async arrancar(field: IField): Promise<boolean> {
    // 1. La cola de verdad esta en `registrations`.
    const rehidratados = await fieldManager.rehidratarColaFreeroll(field);
    if (rehidratados > 0) {
      logger.info(
        `Freeroll ${field.fieldId}: ${rehidratados} inscritos recuperados de la base ` +
        '(la cola en memoria estaba vacia).',
      );
    }

    // 2. Sentar.
    await fieldManager.trySeat(field);

    const fresco = await Field.findOne({ fieldId: field.fieldId });
    if (!fresco) return false;

    // 3. Bots de relleno. Solo en mesas con al menos un humano: una mesa de solo bots no
    //    produce nada y ademas podria ganar el torneo, que es peor que cancelarlo.
    const mesas = await Table.find({
      'field.fieldId': field.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    let botsAnyadidos = 0;
    for (const mesa of mesas) {
      const humanosEnMesa = mesa.seats.filter(
        (s) => s.kind === 'human' && s.status !== 'out',
      ).length;
      if (humanosEnMesa === 0) continue;

      botsAnyadidos += await tableManager.asegurarMinimoAsientos(
        mesa.tableId,
        MIN_JUGADORES_PARA_ARRANCAR,
      );
    }

    if (botsAnyadidos > 0) {
      logger.info(
        `Freeroll ${field.fieldId}: ${botsAnyadidos} bots de relleno para que el torneo ` +
        'pueda arrancar con menos de dos humanos.',
      );
    }

    // 4. Arrancar.
    //
    // Puede haber arrancado ya dentro de `trySeat` si el campo se lleno por aforo. En ese
    // caso NO se vuelve a llamar: `startField` recalcularia `playersRemaining` y `startedAt`
    // sobre un torneo que ya esta en marcha.
    if (fresco.status === 'filling') {
      const ok = await fieldManager.startField(fresco);
      if (!ok) {
        logger.warn(
          `Freeroll ${field.fieldId}: no arranco todavia (ninguna mesa con 2 activos). ` +
          'Se reintenta en la proxima vuelta.',
        );
        return false;
      }
    }

    // 5. Avisar. Si el aviso falla, el torneo sigue: es una comodidad, no parte del juego.
    if (avisoInicio) {
      const ids = (fresco.registrations ?? [])
        .filter((r) => r.status === 'waiting' || r.status === 'seated')
        .map((r) => r.telegramId);

      try {
        await avisoInicio(fresco, ids);
      } catch (error) {
        logger.error(
          `Freeroll ${field.fieldId}: el aviso de inicio fallo:`,
          error,
        );
      }
    }

    return true;
  },

  /** Cierra un campo que no llego a arrancar. No hay dinero que devolver. */
  async cancelar(field: IField, motivo: string): Promise<void> {
    const cerrado = await Field.findOneAndUpdate(
      { _id: field._id, status: 'filling' },
      {
        $set: {
          status: 'cancelled',
          finishedAt: new Date(),
        },
      },
      { new: true },
    );

    if (!cerrado) return;

    // Los inscritos no pagaron nada, pero se les marca para que no sigan apareciendo como
    // "apuntados" en la UI.
    await Field.updateOne(
      { _id: field._id },
      { $set: { 'registrations.$[r].status': 'refunded' } },
      { arrayFilters: [{ 'r.status': { $in: ['waiting', 'seated'] } }] },
    );

    logger.info(`Freeroll ${field.fieldId} cancelado: ${motivo}.`);
  },

  // ======================================================================
  // Lectura para la API
  // ======================================================================

  /** Lo que la UI necesita para pintar el lobby de freerolls. */
  async estado(telegramId?: number) {
    await this.asegurarAbierto();

    const abierto = await Field.findOne({
      kind: 'freeroll',
      status: 'filling',
    }).sort({ scheduledStartAt: 1 });

    // Los que estan en juego y todavia admiten registro tardio.
    const enJuego = await Field.find({
      kind: 'freeroll',
      status: 'running',
      lateRegUntil: { $gt: new Date() },
    }).sort({ scheduledStartAt: 1 });

    const misCampos = telegramId
      ? await Field.find({
          kind: 'freeroll',
          status: { $in: ['filling', 'running'] },
          registrations: {
            $elemMatch: {
              telegramId,
              status: { $in: ['waiting', 'seated'] },
            },
          },
        })
      : [];

    const inscritoEn = new Set(misCampos.map((f) => f.fieldId));

    return {
      abierto: abierto ? this.publico(abierto, inscritoEn.has(abierto.fieldId)) : null,
      enJuego: enJuego.map((f) => this.publico(f, inscritoEn.has(f.fieldId))),
      // Los proximos slots, aunque todavia no tengan campo creado. La UI puede pintar la
      // cuenta atras sin esperar a que el planificador abra el documento.
      proximos: slotsProximos(6).map((s) => ({
        clave: s.clave,
        inicio: s.inicio.toISOString(),
        finRegistro: s.finRegistro.toISOString(),
        premioUsdt: unitsToUsdt(premioHorarioUnits()),
        jugadores: 0,
        estado: 'programado',
      })),
    };
  },

  /** Vista publica de un campo de freeroll. */
  publico(field: IField, inscrito = false) {
    return {
      fieldId: field.fieldId,
      inicio: field.scheduledStartAt?.toISOString() ?? null,
      finRegistro: field.lateRegUntil?.toISOString() ?? null,
      estado: field.status,
      premioUsdt: unitsToUsdt(field.prizePoolUnits ?? 0),
      inscritos: (field.waiting ?? 0) + (field.seated ?? 0),
      jugadoresVivos: field.playersRemaining ?? 0,
      plazasPagadas: PLAZAS_PAGADAS_FREEROLL,
      reparto: FREEROLL_PAYOUT,
      inscrito,
      // Una mesa de 7. Se dice explicitamente para que la UI no prometa "300 en una mesa".
      maxPorMesa: 7,
      tamanoMaximo: field.targetField,
    };
  },
};

export { avisoInicio };
