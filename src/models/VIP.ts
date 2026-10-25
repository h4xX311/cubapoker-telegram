import mongoose, { Document, Schema } from 'mongoose';

/**
 * MEMBRESÍA 3-BET CLUB
 * ====================
 *
 * El VIP de CubaPoker no es un descuento de rake: es un reparto semanal del
 * rake que el jugador genera. Es el modelo de CoinPoker y el único que se
 * sostiene sin regalar margen en cada mano.
 *
 * `rakeDiscount` se conserva en el documento por compatibilidad con datos
 * viejos, pero el producto ya no lo usa. El beneficio real es
 * `rakebackPercent`, que se paga los lunes sobre el rake de la semana anterior.
 *
 * IMPORTANTE: VIP Arena NO es un plan de esta membresía. Es una sala de cash
 * de high stakes con su propio profit share. Mezclarlos hacía que la UI
 * vendiera una "membresía VIP Arena" que en CoinPoker no existe.
 */
export type VIPLevel = 'basic' | 'premium';

export interface IVIP extends Document {
  telegramId: number;
  level: VIPLevel;
  startDate: Date;
  endDate: Date;
  /** Porcentaje del rake semanal que se devuelve al jugador. */
  rakebackPercent: number;
  /** Descuento en torneos. Se muestra en el plan; el cobro se aplica aparte. */
  tournamentDiscount: number;
  /** Power Ups incluidos en el periodo. */
  powerUpsPerMonth: number;
  /** @deprecated El VIP ya no descuenta rake. Se conserva por datos viejos. */
  rakeDiscount: number;
  createdAt: Date;
  updatedAt: Date;
}

const vipSchema = new Schema<IVIP>({
  telegramId: { type: Number, required: true, unique: true },
  level: { type: String, enum: ['basic', 'premium'], required: true },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  rakebackPercent: { type: Number, default: 0 },
  tournamentDiscount: { type: Number, default: 0 },
  powerUpsPerMonth: { type: Number, default: 0 },
  rakeDiscount: { type: Number, default: 0 },
}, { timestamps: true });

vipSchema.index({ endDate: 1 });

export const VIP = mongoose.model<IVIP>('VIP', vipSchema);

export interface VIPPlan {
  name: string;
  /** Precio en unidades internas. */
  price: number;
  /** Duración en días. */
  duration: number;
  /** Porcentaje del rake semanal que se reparte. */
  rakebackPercent: number;
  powerUpsPerMonth: number;
  tournamentDiscount: number;
  benefits: string[];
}

/**
 * Planes del 3-Bet Club.
 *
 * Precios de referencia de CoinPoker: 35 USD al mes y 100 USD al trimestre.
 * `price` está en unidades internas (1 USDT = 1000), que es lo que descuenta
 * el servicio. La interfaz recibe además `priceUsdt`.
 *
 * Solo hay dos planes comprables. VIP Arena vive en el lobby de cash, no aquí.
 */
export const VIP_CONFIG: Record<VIPLevel, VIPPlan> = {
  basic: {
    name: '3-Bet Club · Mensual',
    price: 35_000,
    duration: 30,
    rakebackPercent: 10,
    powerUpsPerMonth: 6,
    tournamentDiscount: 0,
    benefits: [
      '10% de rakeback semanal sobre el rake que generas',
      '6 Power Ups al mes (1,5x durante 12 h)',
      'Badge 3-Bet Club en la mesa',
      'Pagos de rakeback los lunes',
    ],
  },
  premium: {
    name: '3-Bet Club · Trimestral',
    price: 100_000,
    duration: 90,
    rakebackPercent: 10,
    powerUpsPerMonth: 6,
    tournamentDiscount: 5,
    benefits: [
      '10% de rakeback semanal sobre el rake que generas',
      '18 Power Ups en el trimestre',
      '5% de descuento en buy-ins de torneos',
      'Badge trimestral y prioridad en retiros',
      'Pagos de rakeback los lunes',
    ],
  },
};
