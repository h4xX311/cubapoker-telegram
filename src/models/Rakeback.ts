import mongoose, { Document, Schema } from 'mongoose';

/**
 * LIBRO DE RAKE POR JUGADOR
 * =========================
 *
 * El rake se cobraba y solo se anotaba en `table.stats.rakeCollected`. Eso
 * alcanza para saber cuánto ganó la casa, pero no para pagar rakeback: no hay
 * forma de saber cuánto generó cada jugador.
 *
 * Este libro guarda un evento por jugador humano y por mano con rake. Es la
 * única fuente para calcular el pago semanal. No se toca el saldo aquí.
 */
export interface IRakeEvent extends Document {
  telegramId: number;
  tableId: string;
  handNumber: number;
  /** Parte del rake atribuida a este jugador, en unidades internas. */
  amount: number;
  /**
   * `true` si la mano se jugó en VIP Arena.
   *
   * El 3-Bet Club cuenta todo el rake cash, también el de Arena. El profit
   * share de Arena solo cuenta estas manos. Sin esta bandera no se pueden
   * calcular dos programas distintos sobre el mismo libro.
   */
  arena: boolean;
  at: Date;
}

const rakeEventSchema = new Schema<IRakeEvent>({
  telegramId: { type: Number, required: true, index: true },
  tableId: { type: String, required: true },
  handNumber: { type: Number, required: true },
  amount: { type: Number, required: true, min: 0 },
  arena: { type: Boolean, required: true, default: false, index: true },
  at: { type: Date, required: true, default: Date.now },
}, { timestamps: false });

// La consulta semanal es siempre por jugador y rango de fechas.
rakeEventSchema.index({ telegramId: 1, at: 1 });
rakeEventSchema.index({ at: 1 });
// Una mano no puede atribuir rake dos veces al mismo jugador si `finishHand`
// se reintenta tras un error de escritura. La mano y la mesa identifican el
// evento; el índice es la garantía, no una comprobación en memoria.
rakeEventSchema.index(
  { tableId: 1, handNumber: 1, telegramId: 1 },
  { unique: true, name: 'un_rake_por_mano_y_jugador' },
);

export const RakeEvent = mongoose.model<IRakeEvent>('RakeEvent', rakeEventSchema);

/**
 * PAGO SEMANAL DE RAKEBACK
 * ========================
 *
 * `weekKey` es el lunes de la semana pagada en formato YYYY-MM-DD. El índice
 * único es lo que impide pagar dos veces la misma semana, incluso con dos
 * procesos o dos clics simultáneos.
 *
 * El registro se crea en `pending` ANTES de acreditar. El crédito en sí es
 * idempotente: `User.payoutCredits` guarda la clave de la semana en el mismo
 * `findOneAndUpdate` que sube el saldo. Por eso un pago `pending` o `failed`
 * se puede reintentar sin miedo a pagar dos veces; si el dinero ya entró, el
 * segundo intento lo detecta y solo marca el registro como `paid`.
 *
 * `creditKey` se añadió después de los primeros pagos. Los registros viejos
 * que no lo tengan no se reintentan automáticamente: sin la clave no hay forma
 * de demostrar que el crédito no se aplicó antes de morir el proceso.
 */
export interface IRakebackPayout extends Document {
  telegramId: number;
  weekKey: string;
  level: string;
  /** Rake del jugador en la semana, en unidades. */
  rakeUnits: number;
  /** Lo que se le paga, en unidades. */
  amountUnits: number;
  /** Clave idempotente del crédito (`vip_rakeback:YYYY-MM-DD`). */
  creditKey?: string;
  status: 'pending' | 'paid' | 'failed';
  paidAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const rakebackPayoutSchema = new Schema<IRakebackPayout>({
  telegramId: { type: Number, required: true },
  weekKey: { type: String, required: true },
  level: { type: String, required: true },
  rakeUnits: { type: Number, required: true, min: 0 },
  amountUnits: { type: Number, required: true, min: 0 },
  creditKey: String,
  status: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending',
    index: true,
  },
  paidAt: Date,
  error: String,
}, { timestamps: true });

rakebackPayoutSchema.index(
  { telegramId: 1, weekKey: 1 },
  { unique: true, name: 'un_pago_por_semana' },
);

export const RakebackPayout = mongoose.model<IRakebackPayout>(
  'RakebackPayout',
  rakebackPayoutSchema,
);

/**
 * PROFIT SHARE DE VIP ARENA
 * =========================
 *
 * Es un programa distinto del 3-Bet Club. Un jugador puede cobrar los dos por
 * la misma semana: el 10 % del 3-Bet por todo su rake cash y el 15 % de Arena
 * por el rake generado en esa sala. Por eso no se reutiliza `RakebackPayout`:
 * su índice único es por jugador y semana, y bloquearía el segundo pago.
 *
 * Se crea `pending` antes de acreditar. Igual que el rakeback, el crédito usa
 * una clave idempotente en `User.payoutCredits` y se puede reintentar sin
 * pagar dos veces. El prefijo de la clave (`arena_profit_share:`) es distinto
 * del de 3-Bet para que ambos programas paguen la misma semana.
 */
export interface IArenaPayout extends Document {
  telegramId: number;
  weekKey: string;
  /** Rake generado en VIP Arena durante la semana, en unidades. */
  rakeUnits: number;
  profitSharePercent: number;
  /** Lo que se le paga, en unidades. */
  amountUnits: number;
  /** Clave idempotente del crédito (`arena_profit_share:YYYY-MM-DD`). */
  creditKey?: string;
  status: 'pending' | 'paid' | 'failed';
  paidAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const arenaPayoutSchema = new Schema<IArenaPayout>({
  telegramId: { type: Number, required: true },
  weekKey: { type: String, required: true },
  rakeUnits: { type: Number, required: true, min: 0 },
  profitSharePercent: { type: Number, required: true, min: 0 },
  amountUnits: { type: Number, required: true, min: 0 },
  creditKey: String,
  status: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending',
    index: true,
  },
  paidAt: Date,
  error: String,
}, { timestamps: true });

arenaPayoutSchema.index(
  { telegramId: 1, weekKey: 1 },
  { unique: true, name: 'un_profit_share_arena_por_semana' },
);

export const ArenaPayout = mongoose.model<IArenaPayout>(
  'ArenaPayout',
  arenaPayoutSchema,
);
