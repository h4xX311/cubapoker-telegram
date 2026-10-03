import mongoose, { Document, Schema } from 'mongoose';

export type VIPLevel = 'basic' | 'premium' | 'elite';

export interface IVIP extends Document {
  telegramId: number;
  level: VIPLevel;
  startDate: Date;
  endDate: Date;
  rakeDiscount: number;    // Porcentaje de descuento en rake
  tournamentDiscount: number; // Descuento en buy-ins
  createdAt: Date;
  updatedAt: Date;
}

const vipSchema = new Schema<IVIP>({
  telegramId: { type: Number, required: true, unique: true },
  level: { type: String, enum: ['basic', 'premium', 'elite'], required: true },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  rakeDiscount: { type: Number, default: 0 },
  tournamentDiscount: { type: Number, default: 0 },
}, { timestamps: true });

// Índice para búsquedas rápidas
vipSchema.index({ telegramId: 1 });
vipSchema.index({ endDate: 1 });

export const VIP = mongoose.model<IVIP>('VIP', vipSchema);

// Configuración de niveles VIP
export const VIP_CONFIG = {
  basic: {
    name: 'VIP Básico',
    price: 500,
    duration: 30, // días
    rakeDiscount: 2, // 2% de descuento
    tournamentDiscount: 5, // 5% de descuento
    benefits: [
      'Rake reducido (3% en lugar de 5%)',
      'Acceso a torneos VIP',
      'Badge especial en el juego',
    ],
  },
  premium: {
    name: 'VIP Premium',
    price: 2000,
    duration: 30,
    rakeDiscount: 3,
    tournamentDiscount: 10,
    benefits: [
      'Rake reducido (2% en lugar de 5%)',
      'Acceso a torneos exclusivos',
      'Badge dorado especial',
      'Retiros prioritarios',
      'Soporte prioritario',
    ],
  },
  elite: {
    name: 'VIP Elite',
    price: 5000,
    duration: 30,
    rakeDiscount: 5,
    tournamentDiscount: 20,
    benefits: [
      'Rake 0% (sin comisión)',
      'Acceso a todos los torneos',
      'Badge legendario',
      'Retiros instantáneos',
      'Gestor de cuenta dedicado',
      'Torneos privados',
    ],
  },
};
