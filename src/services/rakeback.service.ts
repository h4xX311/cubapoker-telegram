import { RakeEvent, RakebackPayout, ArenaPayout } from '../models/Rakeback';
import { VIP, VIP_CONFIG, type VIPLevel } from '../models/VIP';
import { VIP_ARENA } from '../config/product';
import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import type { ITable } from '../models/Table';
import { logger } from '../utils/logger';

/**
 * RAKEBACK SEMANAL DEL 3-BET CLUB
 * ================================
 *
 * Reglas:
 *
 *   - Se atribuye rake a cada humano en proporcion a lo que aporto al bote de
 *     la mano. Es la forma mas justa sin guardar el historial completo de la
 *     mano: quien puso mas dinero, genero mas rake.
 *   - El pago es del 10% (15% en VIP Arena) del rake de la semana anterior.
 *   - Se paga una sola vez por jugador y semana, garantizado por el indice
 *     unico de `RakebackPayout`.
 *   - El dinero va a `balance.real`: es retirable, no saldo de promocion.
 *
 * No se paga en el momento de la mano. Se acumula y se paga los lunes; si el
 * proceso no corre el lunes, el siguiente intento paga la misma semana una
 * sola vez.
 */

const DAY_MS = 86_400_000;

/**
 * Los indices se construyen una sola vez por proceso.
 *
 * No basta con declararlos en el esquema: Mongoose los crea en segundo plano y
 * las primeras peticiones pueden llegar antes. En una tabla de dinero eso es
 * una carrera real: dos cobros simultaneos podrian pagar dos veces si el indice
 * unico todavia no existe. Se espera aqui, antes de escribir.
 */
let indicesListos: Promise<unknown> | null = null;
const asegurarIndices = (): Promise<unknown> => {
  if (!indicesListos) {
    indicesListos = Promise.all([
      RakeEvent.init(),
      RakebackPayout.init(),
      ArenaPayout.init(),
    ]).catch((error) => {
      // Si falla, se reintenta en la proxima llamada. Mientras tanto es mejor
      // no escribir que escribir sin la garantia de unicidad.
      indicesListos = null;
      throw error;
    });
  }
  return indicesListos;
};

/** Lunes 00:00 UTC de la semana de `date`. */
export const startOfWeekUtc = (date: Date): Date => {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay(): domingo = 0. Se convierte a lunes = 0.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
};

/** Clave de la semana: el lunes en formato YYYY-MM-DD. */
export const weekKeyOf = (date: Date): string =>
  startOfWeekUtc(date).toISOString().slice(0, 10);

const previousWeek = (now: Date) => {
  const end = startOfWeekUtc(now);
  return { start: new Date(end.getTime() - 7 * DAY_MS), end };
};

export const nextPayoutAt = (now: Date): Date =>
  new Date(startOfWeekUtc(now).getTime() + 7 * DAY_MS);

export interface RakebackStatus {
  active: boolean;
  level: VIPLevel | null;
  endDate: string | null;
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  rakebackPercent: number;
  /** Rake generado en la semana que se esta pagando. */
  rakeUnits: number;
  /** Lo que corresponde por esa semana. */
  estimatedUnits: number;
  /** Lo ya pagado de esa semana. */
  paidUnits: number;
  /** Lo que falta por pagar de la semana cerrada. */
  claimableUnits: number;
  /** Rake de la semana en curso, solo informativo. */
  currentWeekRakeUnits: number;
  payoutStatus: 'none' | 'pending' | 'paid' | 'failed';
  lastPayoutAt: string | null;
  nextPayoutAt: string;
}

export interface ArenaStatus {
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  profitSharePercent: number;
  /** Rake generado en VIP Arena durante la semana cerrada. */
  rakeUnits: number;
  estimatedUnits: number;
  paidUnits: number;
  claimableUnits: number;
  payoutStatus: 'none' | 'pending' | 'paid' | 'failed';
  lastPayoutAt: string | null;
  nextPayoutAt: string;
}

const rakeBetween = async (
  telegramId: number,
  start: Date,
  end: Date,
  soloArena = false,
): Promise<number> => {
  if (start >= end) return 0;

  const match: Record<string, unknown> = {
    telegramId,
    at: { $gte: start, $lt: end },
  };
  if (soloArena) match.arena = true;

  const rows = await RakeEvent.aggregate<{ _id: null; total: number }>([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return rows[0]?.total ?? 0;
};

type CreditOutcome = 'credited' | 'already' | 'missing';

/**
 * Acredita un pago una sola vez, aunque se reintente.
 *
 * El saldo y la marca de "esta semana ya se pagó" se escriben en el MISMO
 * `findOneAndUpdate` sobre el jugador. No es un detalle de estilo: si fueran
 * dos escrituras, un fallo de red entre ellas dejaría el dinero dentro y la
 * marca fuera (o al revés), y el reintento no sabría qué de las dos pasó.
 *
 * La condición `payoutCredits.key != clave` hace que el segundo intento no
 * encuentre el documento y no vuelva a incrementar el saldo. Si el jugador
 * existe pero la clave ya está, devuelve `already`; si no existe, `missing`.
 */
const creditPayoutOnce = async (
  telegramId: number,
  creditKey: string,
  amountUnits: number,
): Promise<CreditOutcome> => {
  const actualizado = await User.findOneAndUpdate(
    {
      telegramId,
      'payoutCredits.key': { $ne: creditKey },
    },
    {
      $inc: { 'balance.real': amountUnits },
      $push: {
        payoutCredits: {
          key: creditKey,
          amount: amountUnits,
          at: new Date(),
        },
      },
    },
    { new: true },
  );

  if (actualizado) return 'credited';
  return (await User.exists({ telegramId })) ? 'already' : 'missing';
};

class RakebackService {
  /**
   * Atribuye el rake de una mano cash a los humanos que aportaron al bote.
   *
   * Debe llamarse ANTES de que `finishHand` reinicie `seat.totalBet`. Si se
   * llamara despues, todos los eventos valdrian cero.
   */
  async recordTableRake(table: ITable, rakeUnits: number): Promise<void> {
    if (rakeUnits <= 0) return;

    // Solo ring tables. Las mesas de un campo (torneo, freeroll, centroll) no
    // reparten rakeback: su economia ya esta definida por el campo.
    if (table.kind !== 'cash' || table.field?.fieldId) return;

    const humanos = (table.seats ?? []).filter(
      (s) => s.kind === 'human' && s.totalBet > 0,
    );
    if (humanos.length === 0) return;

    const totalAportado = humanos.reduce((sum, s) => sum + s.totalBet, 0);
    if (totalAportado <= 0) return;

    const handNumber = table.hand?.handNumber ?? 0;
    const at = new Date();

    const eventos = humanos
      .map((seat) => ({
        telegramId: Number(seat.playerId),
        tableId: table.tableId,
        handNumber,
        amount: Math.floor((rakeUnits * seat.totalBet) / totalAportado),
        arena: table.tierId === VIP_ARENA.id,
        at,
      }))
      .filter((e) => Number.isFinite(e.telegramId) && e.amount > 0);

    if (eventos.length === 0) return;

    try {
      await asegurarIndices();
      // Upsert por (mesa, mano, jugador), no insertMany. Si `finishHand` se
      // reintenta, el segundo intento actualiza el mismo documento en vez de
      // sumar otra fila. El índice único es la segunda barrera; esta es la
      // primera y funciona incluso en una base recién creada donde el índice
      // todavía no se ha construido.
      await RakeEvent.bulkWrite(
        eventos.map((evento) => ({
          updateOne: {
            filter: {
              tableId: evento.tableId,
              handNumber: evento.handNumber,
              telegramId: evento.telegramId,
            },
            update: { $setOnInsert: evento },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (error: any) {
      // 11000 = clave duplicada. Significa que otra escritura ganó la carrera
      // por el mismo evento; el rake ya está anotado una vez.
      if (error?.code !== 11000 && error?.code !== 11001) {
        logger.error('No se pudo registrar el rake por jugador:', error);
      }
    }
  }

  /** Estado de rakeback del jugador para la pantalla VIP. */
  async getStatus(telegramId: number, now = new Date()): Promise<RakebackStatus> {
    const previa = previousWeek(now);
    const key = weekKeyOf(previa.start);

    const vip = await VIP.findOne({ telegramId });

    // Una membresía vencida esta semana todavía tiene derecho al rakeback de la
    // semana cerrada. No se borra el documento al vencer: si se borrara, el
    // jugador perdería el pago por darse de baja un día antes del lunes.
    if (!vip || vip.startDate >= previa.end || vip.endDate <= previa.start) {
      return {
        active: false,
        level: null,
        endDate: null,
        weekKey: key,
        weekStart: previa.start.toISOString(),
        weekEnd: previa.end.toISOString(),
        rakebackPercent: 0,
        rakeUnits: 0,
        estimatedUnits: 0,
        paidUnits: 0,
        claimableUnits: 0,
        currentWeekRakeUnits: 0,
        payoutStatus: 'none',
        lastPayoutAt: null,
        nextPayoutAt: nextPayoutAt(now).toISOString(),
      };
    }

    const plan = VIP_CONFIG[vip.level as VIPLevel];
    // Se respeta el porcentaje que se contrato. Si manana cambia el plan, no se
    // reescribe retroactivamente lo que se prometio al jugador.
    const porcentaje =
      vip.rakebackPercent > 0
        ? vip.rakebackPercent
        : plan?.rakebackPercent ?? 0;

    // Solo cuenta el rake generado mientras la membresia estaba activa.
    const inicioElegible =
      vip.startDate > previa.start ? vip.startDate : previa.start;
    const finElegible = vip.endDate < previa.end ? vip.endDate : previa.end;
    const rakeSemana = await rakeBetween(telegramId, inicioElegible, finElegible);

    const inicioSemanaActual = startOfWeekUtc(now);
    const inicioActual =
      vip.startDate > inicioSemanaActual ? vip.startDate : inicioSemanaActual;
    const rakeActual =
      vip.endDate > now
        ? await rakeBetween(telegramId, inicioActual, now)
        : 0;

    const estimado = Math.floor((rakeSemana * porcentaje) / 100);
    const pago = await RakebackPayout.findOne({ telegramId, weekKey: key });
    const pagado = pago?.status === 'paid' ? pago.amountUnits : 0;

    return {
      // `active` es para la pantalla; el pago de la semana cerrada no depende
      // de que la membresía siga viva hoy, sino de que lo estuviera la semana
      // pasada. Por eso una membresía vencida aún puede tener `claimableUnits`.
      active: vip.endDate > now,
      level: vip.level as VIPLevel,
      endDate: vip.endDate.toISOString(),
      weekKey: key,
      weekStart: previa.start.toISOString(),
      weekEnd: previa.end.toISOString(),
      rakebackPercent: porcentaje,
      rakeUnits: rakeSemana,
      estimatedUnits: estimado,
      paidUnits: pagado,
      claimableUnits: Math.max(0, estimado - pagado),
      currentWeekRakeUnits: rakeActual,
      payoutStatus: (pago?.status as RakebackStatus['payoutStatus']) ?? 'none',
      lastPayoutAt: pago?.paidAt ? pago.paidAt.toISOString() : null,
      nextPayoutAt: nextPayoutAt(now).toISOString(),
    };
  }

  /**
   * Paga la semana cerrada a un jugador.
   *
   * Idempotente por `(telegramId, weekKey)` y por la clave del crédito. El
   * registro se crea en `pending` antes de acreditar; si el proceso muere, el
   * siguiente intento encuentra el registro y `creditPayoutOnce` decide si el
   * dinero ya entró. No hay que elegir entre deberle la semana o pagarla dos
   * veces.
   */
  async payWeeklyRakeback(
    telegramId: number,
    now = new Date(),
  ): Promise<{ paid: number; weekKey: string; reason?: string }> {
    const estado = await this.getStatus(telegramId, now);

    if (estado.claimableUnits <= 0) {
      return { paid: 0, weekKey: estado.weekKey, reason: 'sin rakeback pendiente' };
    }

    let pago;
    try {
      await asegurarIndices();

      // Un pago `failed` o `pending` de esta semana se reutiliza y se
      // reintenta. Solo si tiene `creditKey`: los registros anteriores a la
      // clave idempotente no se pueden distinguir de un pago ya aplicado.
      pago = await RakebackPayout.findOneAndUpdate(
        {
          telegramId,
          weekKey: estado.weekKey,
          status: { $in: ['pending', 'failed'] },
          creditKey: { $exists: true, $ne: null },
        },
        {
          $set: { status: 'pending' },
          $unset: { error: 1, paidAt: 1 },
        },
        { new: true },
      );

      if (!pago) {
        const existente = await RakebackPayout.findOne({
          telegramId,
          weekKey: estado.weekKey,
        });
        if (existente) {
          return {
            paid: 0,
            weekKey: estado.weekKey,
            reason:
              existente.status === 'pending'
                ? 'pago pendiente de revision'
                : existente.status === 'failed'
                  ? 'pago fallido anterior: revisar'
                  : 'ya pagado o en curso',
          };
        }

        pago = await RakebackPayout.create({
          telegramId,
          weekKey: estado.weekKey,
          level: estado.level,
          rakeUnits: estado.rakeUnits,
          amountUnits: estado.claimableUnits,
          creditKey: `vip_rakeback:${estado.weekKey}`,
          status: 'pending',
        });
      }
    } catch (error: any) {
      if (error?.code === 11000 || error?.code === 11001) {
        return { paid: 0, weekKey: estado.weekKey, reason: 'ya pagado o en curso' };
      }
      throw error;
    }

    if (!pago.creditKey) {
      return {
        paid: 0,
        weekKey: estado.weekKey,
        reason: 'pago sin clave de reintento',
      };
    }

    let credito: CreditOutcome;
    try {
      credito = await creditPayoutOnce(
        telegramId,
        pago.creditKey,
        pago.amountUnits,
      );
    } catch (error: any) {
      pago.status = 'failed';
      pago.error = error?.message ?? 'error al acreditar';
      await pago.save();
      throw error;
    }

    if (credito === 'missing') {
      pago.status = 'failed';
      pago.error = 'usuario no encontrado';
      await pago.save();
      throw new Error('No se encontro al jugador para pagarle el rakeback');
    }

    pago.status = 'paid';
    pago.paidAt = pago.paidAt ?? new Date();
    pago.error = undefined;
    await pago.save();

    if (credito === 'already') {
      logger.info(
        `Rakeback 3-Bet Club: la semana ${pago.weekKey} de ${telegramId} ya ` +
          'estaba acreditada; se marca el pago sin volver a sumar saldo.',
      );
      return { paid: 0, weekKey: pago.weekKey, reason: 'ya acreditado' };
    }

    // El libro de transacciones es para el operador. Si falla, el pago ya esta
    // hecho y no se revierte: se registra el error, no se le quita el dinero al
    // jugador por un fallo de auditoria.
    try {
      await Transaction.create({
        telegramId,
        type: 'vip_rakeback',
        paymentMethod: 'credits',
        amount: pago.amountUnits,
        // Unidades internas; 'CUP' es la etiqueta histórica del ledger.
        currency: 'CUP',
        status: 'completed',
        metadata: {
          weekKey: pago.weekKey,
          rakeUnits: pago.rakeUnits,
          level: pago.level,
        },
      });
    } catch (error) {
      logger.error('Rakeback pagado pero no se pudo registrar la transaccion:', error);
    }

    logger.info(
      `Rakeback 3-Bet Club: ${telegramId} cobra ${pago.amountUnits} unidades ` +
      `(${estado.rakebackPercent}% de ${pago.rakeUnits}) por la semana ${pago.weekKey}`,
    );

    return { paid: pago.amountUnits, weekKey: pago.weekKey };
  }

  /**
   * Pago de todas las membresias que estuvieron vigentes la semana pasada.
   *
   * No se filtra por `endDate > now`: una membresía que venció ayer todavía
   * tiene derecho al rakeback de la semana cerrada. Si solo se buscaran las
   * activas, el jugador tendría que reclamarlo a mano o lo perdería.
   *
   * Se llama al arrancar y cada pocas horas. Es seguro llamarlo muchas veces:
   * la semana pagada no se repite.
   */
  async payDuePayouts(now = new Date()): Promise<{ vips: number; totalPaid: number }> {
    const previa = previousWeek(now);
    const vips = await VIP.find({
      startDate: { $lt: previa.end },
      endDate: { $gt: previa.start },
    }).limit(1000);
    let totalPaid = 0;

    for (const vip of vips) {
      try {
        const res = await this.payWeeklyRakeback(vip.telegramId, now);
        totalPaid += res.paid;
      } catch (error) {
        logger.error(
          `Rakeback: fallo al pagar a ${vip.telegramId} (${vip.level}):`,
          error,
        );
      }
    }

    return { vips: vips.length, totalPaid };
  }

  // ======================================================================
  // VIP ARENA · PROFIT SHARE
  // ======================================================================

  /**
   * Estado del profit share de VIP Arena.
   *
   * No exige membresía. Cualquier jugador que haya generado rake en la sala
   * tiene derecho; el cálculo se hace sobre sus eventos `arena: true`.
   */
  async getArenaStatus(
    telegramId: number,
    now = new Date(),
  ): Promise<ArenaStatus> {
    const previa = previousWeek(now);
    const key = weekKeyOf(previa.start);
    const porcentaje = VIP_ARENA.profitSharePercent;
    const rake = await rakeBetween(telegramId, previa.start, previa.end, true);
    const estimado = Math.floor((rake * porcentaje) / 100);
    const pago = await ArenaPayout.findOne({ telegramId, weekKey: key });
    const pagado = pago?.status === 'paid' ? pago.amountUnits : 0;

    return {
      weekKey: key,
      weekStart: previa.start.toISOString(),
      weekEnd: previa.end.toISOString(),
      profitSharePercent: porcentaje,
      rakeUnits: rake,
      estimatedUnits: estimado,
      paidUnits: pagado,
      claimableUnits: Math.max(0, estimado - pagado),
      payoutStatus: (pago?.status as ArenaStatus['payoutStatus']) ?? 'none',
      lastPayoutAt: pago?.paidAt ? pago.paidAt.toISOString() : null,
      nextPayoutAt: nextPayoutAt(now).toISOString(),
    };
  }

  /**
   * Paga el profit share de la semana cerrada a un jugador de Arena.
   *
   * Idempotente por `(telegramId, weekKey)` y por la clave del crédito. Igual
   * que el 3-Bet: `pending` se crea antes de acreditar y un reintento sabe si
   * el dinero entró. No se paga dos veces ni se queda como deuda invisible.
   */
  async payArenaWeekly(
    telegramId: number,
    now = new Date(),
  ): Promise<{ paid: number; weekKey: string; reason?: string }> {
    const estado = await this.getArenaStatus(telegramId, now);

    if (estado.claimableUnits <= 0) {
      return { paid: 0, weekKey: estado.weekKey, reason: 'sin profit share pendiente' };
    }

    let pago;
    try {
      await asegurarIndices();

      pago = await ArenaPayout.findOneAndUpdate(
        {
          telegramId,
          weekKey: estado.weekKey,
          status: { $in: ['pending', 'failed'] },
          creditKey: { $exists: true, $ne: null },
        },
        {
          $set: { status: 'pending' },
          $unset: { error: 1, paidAt: 1 },
        },
        { new: true },
      );

      if (!pago) {
        const existente = await ArenaPayout.findOne({
          telegramId,
          weekKey: estado.weekKey,
        });
        if (existente) {
          return {
            paid: 0,
            weekKey: estado.weekKey,
            reason:
              existente.status === 'pending'
                ? 'pago pendiente de revision'
                : existente.status === 'failed'
                  ? 'pago fallido anterior: revisar'
                  : 'ya pagado o en curso',
          };
        }

        pago = await ArenaPayout.create({
          telegramId,
          weekKey: estado.weekKey,
          rakeUnits: estado.rakeUnits,
          profitSharePercent: estado.profitSharePercent,
          amountUnits: estado.claimableUnits,
          creditKey: `arena_profit_share:${estado.weekKey}`,
          status: 'pending',
        });
      }
    } catch (error: any) {
      if (error?.code === 11000 || error?.code === 11001) {
        return { paid: 0, weekKey: estado.weekKey, reason: 'ya pagado o en curso' };
      }
      throw error;
    }

    if (!pago.creditKey) {
      return {
        paid: 0,
        weekKey: estado.weekKey,
        reason: 'pago sin clave de reintento',
      };
    }

    let credito: CreditOutcome;
    try {
      credito = await creditPayoutOnce(
        telegramId,
        pago.creditKey,
        pago.amountUnits,
      );
    } catch (error: any) {
      pago.status = 'failed';
      pago.error = error?.message ?? 'error al acreditar';
      await pago.save();
      throw error;
    }

    if (credito === 'missing') {
      pago.status = 'failed';
      pago.error = 'usuario no encontrado';
      await pago.save();
      throw new Error('No se encontro al jugador para pagarle el profit share de Arena');
    }

    pago.status = 'paid';
    pago.paidAt = pago.paidAt ?? new Date();
    pago.error = undefined;
    await pago.save();

    if (credito === 'already') {
      logger.info(
        `VIP Arena: la semana ${pago.weekKey} de ${telegramId} ya estaba ` +
          'acreditada; se marca el pago sin volver a sumar saldo.',
      );
      return { paid: 0, weekKey: pago.weekKey, reason: 'ya acreditado' };
    }

    try {
      await Transaction.create({
        telegramId,
        type: 'arena_profit_share',
        paymentMethod: 'credits',
        amount: pago.amountUnits,
        // Unidades internas; 'CUP' es la etiqueta histórica del ledger.
        currency: 'CUP',
        status: 'completed',
        metadata: {
          weekKey: pago.weekKey,
          rakeUnits: pago.rakeUnits,
          profitSharePercent: pago.profitSharePercent,
        },
      });
    } catch (error) {
      logger.error(
        'Profit share de Arena pagado pero no se pudo registrar la transaccion:',
        error,
      );
    }

    logger.info(
      `VIP Arena: ${telegramId} cobra ${pago.amountUnits} unidades ` +
      `(${pago.profitSharePercent}% de ${pago.rakeUnits}) por la semana ${pago.weekKey}`,
    );

    return { paid: pago.amountUnits, weekKey: pago.weekKey };
  }

  /**
   * Paga el profit share de todos los jugadores con rake en Arena la semana
   * pasada. No hay lista de miembros: la elegibilidad nace de haber jugado.
   */
  async payDueArenaPayouts(
    now = new Date(),
  ): Promise<{ players: number; totalPaid: number }> {
    const previa = previousWeek(now);
    const rows = await RakeEvent.aggregate<{ _id: number }>([
      {
        $match: {
          arena: true,
          at: { $gte: previa.start, $lt: previa.end },
        },
      },
      { $group: { _id: '$telegramId' } },
      { $limit: 5000 },
    ]);

    let totalPaid = 0;
    for (const row of rows) {
      try {
        const res = await this.payArenaWeekly(row._id, now);
        totalPaid += res.paid;
      } catch (error) {
        logger.error(
          `VIP Arena: fallo al pagar a ${row._id}:`,
          error,
        );
      }
    }

    return { players: rows.length, totalPaid };
  }

  /** Una sola vuelta del job paga los dos programas. */
  async payAllDuePayouts(now = new Date()) {
    const vip = await this.payDuePayouts(now);
    const arena = await this.payDueArenaPayouts(now);
    return { vip, arena };
  }
}

export const rakebackService = new RakebackService();
