/**
 * TORNEOS PROGRAMADOS Y SPIN & GO
 * ================================
 *
 * Los torneos pagados no son mesas cash: viven en un `Field` multi-mesa y
 * arrancan a su hora, como un freeroll. La diferencia es que cobran un buy-in
 * en USDT, tienen premio garantizado y reparten el bote entre las posiciones.
 *
 * Un Spin & Go es el mismo motor con tres jugadores y pago al ganador. No tiene
 * hora fija: se abre una mesa de tres plazas y arranca cuando se llena.
 *
 * ------------------------------------------------------------------
 * POR QUE NO SE RELLENAN CON BOTS
 *
 * En un freeroll los bots de relleno son aceptables porque no hay dinero real
 * en juego. En un torneo pagado no: un bot no paga buy-in, pero puede ocupar
 * una plaza premiada. Si ganara, su parte iria a la casa y el jugador humano
 * habria pagado por un bote que no existe. Por eso un torneo pagado arranca
 * con dos humanos o se cancela y devuelve las entradas. Es mas honesto que un
 * torneo de mentira.
 *
 * ------------------------------------------------------------------
 * EL OVERLAY
 *
 * El premio garantizado puede superar lo recaudado. Esa diferencia la pone la
 * casa y se registra en `Field.overlayUnits`; no se crea saldo de la nada ni se
 * paga con fichas de otro jugador.
 */

import { Field, IField } from '../models/Field';
import { Table } from '../models/Table';
import {
  TOURNAMENT_EVENTS,
  TournamentEvent,
  getTournamentEvent,
  tournamentSlotKey,
} from '../config/product';
import { unitsToUsdt } from '../config/units';
import { logger } from '../utils/logger';
import { fieldManager, FieldError, withFieldLock } from './field.manager';
import { tableManager } from './table.manager';

const MINUTOS_REGISTRO_TARDIO = 12;
const HORIZONTE_APERTURA_MS = 24 * 60 * 60 * 1000;

/**
 * Spin & Go: completa la mesa a los 6 minutos y devuelve la entrada a los 9.
 *
 * El relleno es probabilístico por campo, no todos los Spin se completan. La
 * decisión es determinista a partir del `fieldId` para que un reinicio no
 * convierta un "no" en un "sí" ni duplique asientos.
 */
export const SPIN_COMPLETAR_MS = 6 * 60 * 1000;
export const SPIN_REEMBOLSO_MS = 9 * 60 * 1000;
const SPIN_PROBABILIDAD_COMPLETAR = 0.55;

/** Hash FNV-1a simple, sin dependencias externas. */
const hashCampo = (fieldId: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < fieldId.length; i++) {
    hash ^= fieldId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Si ese Spin & Go concreto se completa a los 6 minutos. */
export const spinSeCompleta = (fieldId: string): boolean =>
  hashCampo(fieldId) / 0xffffffff < SPIN_PROBABILIDAD_COMPLETAR;

export class TournamentError extends Error {
  code: string;

  constructor(message: string, code = 'TOURNAMENT_ERROR') {
    super(message);
    this.name = 'TournamentError';
    this.code = code;
  }
}

/** Proxima ocurrencia de un evento programado, en UTC. */
export const proximoInicio = (event: TournamentEvent, now = new Date()): Date => {
  if (!event.schedule) {
    throw new TournamentError('Ese evento no tiene hora fija.', 'NO_SCHEDULE');
  }

  const { weekdayUtc, hourUtc, minuteUtc, hoursUtc } = event.schedule;

  // Eventos recurrentes con varias horas al día (cada 3, 6 o 1 hora). Se
  // prueban hoy y mañana y gana la primera ocurrencia futura.
  if (weekdayUtc === null && hoursUtc && hoursUtc.length > 0) {
    const horas = Array.from(new Set(hoursUtc)).sort((a, b) => a - b);
    for (let dia = 0; dia <= 1; dia++) {
      for (const hora of horas) {
        const candidato = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + dia,
            hora,
            minuteUtc,
            0,
            0,
          ),
        );
        if (candidato.getTime() > now.getTime()) return candidato;
      }
    }
  }

  const inicio = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      minuteUtc,
      0,
      0,
    ),
  );

  if (weekdayUtc === null) {
    if (inicio.getTime() <= now.getTime()) {
      inicio.setUTCDate(inicio.getUTCDate() + 1);
    }
    return inicio;
  }

  const diferencia = (weekdayUtc - inicio.getUTCDay() + 7) % 7;
  inicio.setUTCDate(inicio.getUTCDate() + diferencia);
  if (inicio.getTime() <= now.getTime()) {
    inicio.setUTCDate(inicio.getUTCDate() + 7);
  }
  return inicio;
};

const finRegistro = (inicio: Date): Date =>
  new Date(inicio.getTime() + MINUTOS_REGISTRO_TARDIO * 60_000);

const inscritos = (field: IField): number =>
  (field.registrations ?? []).filter(
    (r) => r.status === 'waiting' || r.status === 'seated',
  ).length;

const publico = (event: TournamentEvent, field: IField | null, telegramId?: number) => {
  const entradas = field ? inscritos(field) : 0;
  // Se usa lo cobrado de verdad, no `buyInUnits * entradas`: QVA Premium paga
  // un 5 % menos y el lobby no debe anunciar un premio que luego no existe.
  const boteEntradas = field ? Math.floor((field.buyInsCollected ?? 0) * 0.95) : 0;
  const premio = Math.max(event.guaranteedPrizeUnits, boteEntradas);

  return {
    id: event.id,
    label: event.label,
    description: event.description,
    kind: event.spin ? 'spingo' : 'torneo',
    buyInUsdt: event.buyInUsdt,
    premioGarantizadoUsdt: event.guaranteedPrizeUsdt,
    premioActualUsdt: unitsToUsdt(premio),
    boteEntradasUsdt: unitsToUsdt(boteEntradas),
    fieldSize: event.maxPlayers,
    startingChips: event.startingChips,
    blinds: event.blinds,
    lateRegMinutes: event.lateRegMinutes,
    payout: event.payout,
    scheduled: event.scheduled,
    fieldId: field?.fieldId ?? null,
    status: field?.status ?? 'scheduled',
    jugadores: entradas,
    jugadoresVivos: field?.playersRemaining ?? 0,
    startsAt: field?.scheduledStartAt?.toISOString?.() ?? null,
    lateRegUntil: field?.lateRegUntil?.toISOString?.() ?? null,
    inscrito: !!(
      telegramId &&
      field &&
      (field.registrations ?? []).some(
        (r) =>
          r.telegramId === telegramId &&
          (r.status === 'waiting' || r.status === 'seated'),
      )
    ),
    maxPorMesa: 7,
    createdAt: field?.createdAt?.toISOString?.() ?? null,
    // Ventanas visibles del Spin & Go. No se expone ninguna decisión interna:
    // el jugador solo necesita saber cuándo puede completarse o reembolsarse.
    spinFillAt:
      event.spin && field?.createdAt
        ? new Date(new Date(field.createdAt).getTime() + SPIN_COMPLETAR_MS).toISOString()
        : null,
    spinRefundAt:
      event.spin && field?.createdAt
        ? new Date(new Date(field.createdAt).getTime() + SPIN_REEMBOLSO_MS).toISOString()
        : null,
  };
};

/** Campo vivo de un evento, incluyendo el registro tardio abierto. */
const campoVivo = async (eventId: string, now = new Date()): Promise<IField | null> => {
  const campos = await Field.find({
    kind: 'tournament',
    eventId,
    status: { $in: ['filling', 'running'] },
  }).sort({ scheduledStartAt: 1 });

  return (
    campos.find(
      (f) =>
        f.status === 'filling' ||
        (!!f.lateRegUntil && new Date(f.lateRegUntil).getTime() > now.getTime()),
    ) ?? null
  );
};

/** Abre el campo de una ocurrencia concreta. Es idempotente. */
const abrirEvento = async (
  event: TournamentEvent,
  inicio: Date,
): Promise<IField> => {
  if (!event.schedule) {
    throw new TournamentError('Ese evento no se abre por horario.', 'NO_SCHEDULE');
  }

  const fieldId = `tournament-${tournamentSlotKey(event.id, inicio)}`;
  const existente = await Field.findOne({ fieldId });
  if (existente) return existente;

  try {
    const field = await Field.create({
      fieldId,
      kind: 'tournament',
      eventId: event.id,
      format: 'standard',
      // El tier es la ocurrencia concreta. El indice unico impide que dos
      // procesos abran el mismo torneo, pero permite el de hoy y el de manana.
      tierId: fieldId,
      status: 'filling',
      buyInUnits: event.buyInUnits,
      prizePoolUnits: event.guaranteedPrizeUnits,
      payoutTable: [...event.payout],
      scheduledStartAt: inicio,
      lateRegUntil: finRegistro(inicio),
      startChips: event.startingChips,
      smallBlind: event.blinds.small,
      bigBlind: event.blinds.big,
      targetField: event.maxPlayers,
      waiting: 0,
      seated: 0,
      eliminated: 0,
      playersRemaining: 0,
      paidPositionsLeft: event.payout.length,
      plannedTables: Math.ceil(event.maxPlayers / 7),
      tables: [],
    });

    logger.info(
      `Torneo ${event.id} abierto (${fieldId}): arranca ${inicio.toISOString()}, ` +
      `buy-in ${event.buyInUsdt} USDT, garantizado ${event.guaranteedPrizeUsdt} USDT.`,
    );
    return field;
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const ganador = await Field.findOne({ fieldId });
    if (ganador) return ganador;
    throw new TournamentError('No se pudo abrir el torneo.', 'OPEN_FAILED');
  }
};

/** Devuelve el campo que toca inscribirse, abriéndolo si hace falta. */
const campoParaInscripcion = async (
  event: TournamentEvent,
  now = new Date(),
): Promise<IField> => {
  const vivo = await campoVivo(event.id, now);
  if (vivo) return vivo;

  const inicio = proximoInicio(event, now);
  return abrirEvento(event, inicio);
};

/** Abre un campo Spin & Go de tres plazas si no hay uno esperando. */
const campoSpin = async (
  event: TournamentEvent,
  now = new Date(),
): Promise<IField> => {
  const existente = await Field.findOne({
    kind: 'tournament',
    eventId: event.id,
    format: 'spingo',
    status: 'filling',
  }).sort({ createdAt: 1 });

  if (existente) return existente;

  const fieldId = `spingo-${event.id}-${now.getTime().toString(36)}`;
  try {
    const field = await Field.create({
      fieldId,
      kind: 'tournament',
      eventId: event.id,
      format: 'spingo',
      tierId: fieldId,
      status: 'filling',
      buyInUnits: event.buyInUnits,
      prizePoolUnits: event.guaranteedPrizeUnits,
      payoutTable: [100],
      startChips: event.startingChips,
      smallBlind: event.blinds.small,
      bigBlind: event.blinds.big,
      targetField: event.maxPlayers,
      waiting: 0,
      seated: 0,
      eliminated: 0,
      playersRemaining: 0,
      paidPositionsLeft: 1,
      plannedTables: 1,
      tables: [],
    });

    logger.info(
      `Spin & Go ${event.id} abierto (${fieldId}): ` +
      `${event.buyInUsdt} USDT, premio ${event.guaranteedPrizeUsdt} USDT.`,
    );
    return field;
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const ganador = await Field.findOne({ fieldId });
    if (ganador) return ganador;
    throw new TournamentError('No se pudo abrir el Spin & Go.', 'OPEN_FAILED');
  }
};

let procesando = false;

export const tournamentManager = {
  /**
   * Arranca un torneo programado.
   *
   * No se rellena con bots: si no hay dos humanos, se espera al cierre del
   * registro tardio y se cancela con devolucion. El jugador no paga por un
   * torneo que no se va a jugar.
   */
  async arrancar(field: IField): Promise<boolean> {
    await fieldManager.rehidratarColaFreeroll(field);
    await fieldManager.trySeat(field);

    const fresco = await Field.findOne({ fieldId: field.fieldId });
    if (!fresco || fresco.status !== 'filling') return false;

    const humanos = inscritos(fresco);
    if (humanos < 2) {
      logger.info(
        `Torneo ${fresco.fieldId}: solo ${humanos} humano(s). No arranca; ` +
        'se espera al cierre del registro tardio.',
      );
      return false;
    }

    const ok = await fieldManager.startField(fresco);
    if (ok) {
      logger.info(
        `Torneo ${fresco.fieldId} arrancado con ${humanos} jugadores.`,
      );
    }
    return ok;
  },

  /**
   * Completa un Spin & Go que lleva seis minutos esperando y lo arranca.
   *
   * Solo se completa si hay al menos un humano. Los asientos que faltan los
   * pone la casa hasta el aforo de tres; sus premios, si ganan, quedan en la
   * casa. El jugador que esperó no paga una mesa vacía.
   */
  async completarSpin(field: IField): Promise<boolean> {
    await fieldManager.rehidratarColaFreeroll(field);
    await fieldManager.trySeat(field);

    const fresco = await Field.findOne({ fieldId: field.fieldId });
    if (!fresco || fresco.status !== 'filling') return false;
    if (inscritos(fresco) === 0) return false;

    const mesas = await Table.find({
      'field.fieldId': fresco.fieldId,
      status: { $in: ['waiting', 'running'] },
    });

    let agregados = 0;
    let mesaElegida: typeof mesas[number] | null = null;

    for (const mesa of mesas) {
      const humanos = mesa.seats.filter(
        (s) => s.kind === 'human' && s.status !== 'out',
      ).length;
      if (humanos === 0) continue;

      mesaElegida = mesa;
      agregados += await tableManager.asegurarMinimoAsientos(
        mesa.tableId,
        fresco.targetField ?? 3,
      );
      // Un Spin & Go es una sola mesa. Se completa la primera mesa con
      // humanos y no se reparte a los jugadores en mesas distintas.
      break;
    }

    if (!mesaElegida) return false;

    // Si la mesa ya tenía los asientos necesarios, `agregados` es 0 pero el
    // campo sigue en `filling`: hay que arrancarlo igualmente.
    const activos = mesaElegida.seats.filter(
      (s) => s.status === 'active' && s.chips > 0,
    ).length;
    if (agregados === 0 && activos < (fresco.targetField ?? 3)) return false;

    const ok = await fieldManager.startField(fresco);
    if (ok) {
      logger.info(
        `Spin ${fresco.fieldId}: mesa completada; arranca con la mesa llena.`,
      );
    }
    return ok;
  },

  /** Cancela y devuelve el buy-in a todos los inscritos de un torneo que no arranco. */
  async cancelar(field: IField, motivo: string): Promise<void> {
    try {
      const resultado = await fieldManager.cancelarCampo(field.fieldId, {
        politica: 'todos',
        motivo,
      });
      if (resultado.cancelado) {
        logger.info(
          `Torneo ${field.fieldId} cancelado (${motivo}); ` +
          `${unitsToUsdt(resultado.devuelto)} USDT devueltos.`,
        );
      }
    } catch (err) {
      if (err instanceof FieldError && err.code === 'FIELD_FINISHED') return;
      logger.error(`Torneo ${field.fieldId}: fallo al cancelar:`, err);
      throw err;
    }
  },

  // ======================================================================
  // Planificador
  // ======================================================================

  async procesar(): Promise<{ arrancados: number; cancelados: number }> {
    if (procesando) return { arrancados: 0, cancelados: 0 };
    procesando = true;
    let arrancados = 0;
    let cancelados = 0;

    try {
      const ahora = new Date();

      // Abre con antelacion los eventos que estan dentro del horizonte. No se
      // abren todos los del catalogo de golpe: un torneo semanal a siete dias
      // vista solo distraeria en el lobby.
      for (const event of TOURNAMENT_EVENTS) {
        if (!event.scheduled || !event.schedule) continue;
        const inicio = proximoInicio(event, ahora);
        if (inicio.getTime() - ahora.getTime() > HORIZONTE_APERTURA_MS) continue;
        if (!(await campoVivo(event.id, ahora))) {
          await abrirEvento(event, inicio);
        }
      }

      const pendientes = await Field.find({
        kind: 'tournament',
        status: 'filling',
        scheduledStartAt: { $lte: ahora },
      }).sort({ scheduledStartAt: 1 });

      for (const field of pendientes) {
        const cierre = field.lateRegUntil ?? field.scheduledStartAt;
        if (!cierre) continue;

        const humanos = inscritos(field);

        // Si ya paso el registro tardio y no hay dos humanos, no se puede
        // jugar. Se devuelve el buy-in; no se deja el dinero colgado.
        if (ahora.getTime() > new Date(cierre).getTime()) {
          if (humanos < 2) {
            await this.cancelar(field, 'no hubo dos jugadores');
            cancelados++;
          } else {
            // El servidor estuvo caido. Hay gente suficiente, pero el reloj
            // del torneo ya paso: se arranca ahora y se sigue con el nivel
            // actual. Es preferible a cancelar a quienes pagaron.
            const ok = await this.arrancar(field);
            if (ok) arrancados++;
          }
          continue;
        }

        if (humanos === 0) {
          // Un torneo sin nadie no debe quedarse abierto toda la noche.
          if (ahora.getTime() - new Date(field.scheduledStartAt!).getTime() > 30 * 60_000) {
            await this.cancelar(field, 'nadie se apunto');
            cancelados++;
          }
          continue;
        }

        if (humanos >= 2) {
          const ok = await this.arrancar(field);
          if (ok) arrancados++;
        }
      }

      // Spin & Go: arranca al llenarse. Si a los 6 minutos sigue esperando,
      // una parte de los campos se completa automáticamente; el resto se
      // reembolsa al cumplir 9 minutos. `trySeat` ya arranca al tercer humano.
      const spins = await Field.find({
        kind: 'tournament',
        format: 'spingo',
        status: 'filling',
      });

      for (const spin of spins) {
        const humanos = inscritos(spin);
        if (humanos >= 3) {
          await fieldManager.rehidratarColaFreeroll(spin);
          await fieldManager.trySeat(spin);
          continue;
        }

        const edad = ahora.getTime() - new Date(spin.createdAt).getTime();

        // Nueve minutos es el máximo: se devuelve la entrada, tanto si hay
        // jugadores esperando como si el campo quedó vacío.
        if (edad >= SPIN_REEMBOLSO_MS) {
          await this.cancelar(
            spin,
            humanos > 0
              ? 'Spin & Go sin llenarse: reembolso automático'
              : 'Spin & Go sin jugadores',
          );
          cancelados++;
          continue;
        }

        // A los seis minutos, solo algunos campos se completan. El hash del
        // `fieldId` mantiene la decisión estable entre reinicios.
        if (
          humanos > 0 &&
          edad >= SPIN_COMPLETAR_MS &&
          spinSeCompleta(spin.fieldId)
        ) {
          const ok = await this.completarSpin(spin);
          if (ok) arrancados++;
        }
      }
    } catch (error) {
      logger.error('Torneos: fallo la vuelta del planificador:', error);
    } finally {
      procesando = false;
    }

    return { arrancados, cancelados };
  },

  // ======================================================================
  // Inscripcion
  // ======================================================================

  async registrar(
    telegramId: number,
    eventId: string,
    username?: string,
  ): Promise<{ fieldId: string; seated: boolean; position: number; late: boolean }> {
    const event = getTournamentEvent(eventId);
    if (!event) throw new TournamentError('Ese torneo no existe.', 'NOT_FOUND');

    return withFieldLock(`tournament:${event.id}`, async () => {
      const field = event.spin
        ? await campoSpin(event)
        : await campoParaInscripcion(event);

      const fresco = await Field.findOne({ fieldId: field.fieldId });
      if (!fresco) throw new TournamentError('El torneo ya no esta disponible.', 'NOT_FOUND');

      return fieldManager.registrarEnTorneo(fresco, telegramId, username);
    });
  },

  async salir(telegramId: number, fieldId: string): Promise<{ salio: boolean }> {
    const field = await Field.findOne({ fieldId, kind: 'tournament' });
    if (!field) throw new TournamentError('Ese torneo no existe.', 'NOT_FOUND');

    if (field.status !== 'filling') {
      throw new TournamentError(
        'El torneo ya empezo: no se puede cancelar la inscripcion.',
        'ALREADY_STARTED',
      );
    }

    try {
      await fieldManager.unregister(telegramId, fieldId);
    } catch (error) {
      if (error instanceof FieldError && error.code === 'NOT_IN_FIELD') {
        return { salio: false };
      }
      throw error;
    }

    logger.info(`Torneo ${fieldId}: ${telegramId} cancela su inscripcion.`);
    return { salio: true };
  },

  // ======================================================================
  // Lobby
  // ======================================================================

  async estado(telegramId?: number) {
    const ahora = new Date();
    const programados = [];

    // Abre los que estan dentro del horizonte para que el lobby y la
    // inscripcion hablen del mismo documento.
    for (const event of TOURNAMENT_EVENTS) {
      if (!event.scheduled || !event.schedule) continue;
      const inicio = proximoInicio(event, ahora);
      if (inicio.getTime() - ahora.getTime() <= HORIZONTE_APERTURA_MS) {
        await abrirEvento(event, inicio);
      }
    }

    for (const event of TOURNAMENT_EVENTS) {
      if (!event.scheduled) continue;
      const field = await campoVivo(event.id, ahora);
      if (field) {
        programados.push(publico(event, field, telegramId));
        continue;
      }

      // La ocurrencia todavia no tiene documento, pero el jugador merece ver
      // la hora. El campo se abre al acercarse el inicio o al pulsar JUGAR.
      const inicio = proximoInicio(event, ahora);
      programados.push({
        ...publico(event, null, telegramId),
        startsAt: inicio.toISOString(),
        lateRegUntil: finRegistro(inicio).toISOString(),
        status: 'scheduled',
      });
    }

    const spins = [];
    for (const event of TOURNAMENT_EVENTS) {
      if (!event.spin) continue;
      const field = await campoSpin(event, ahora);
      spins.push(publico(event, field, telegramId));
    }

    return { torneos: programados, spin: spins };
  },

  /** Vista de un campo concreto, para la pantalla de espera. */
  async estadoCampo(fieldId: string, telegramId?: number) {
    const field = await Field.findOne({ fieldId, kind: 'tournament' });
    if (!field) throw new TournamentError('Ese torneo no existe.', 'NOT_FOUND');
    const event = getTournamentEvent(field.eventId ?? '');
    if (!event) throw new TournamentError('Ese torneo no tiene evento.', 'NOT_FOUND');

    return {
      ...publico(event, field, telegramId),
      tabla: fieldManager.status ? await fieldManager.status(fieldId) : null,
    };
  },
};

export { tournamentManager as tournaments };
