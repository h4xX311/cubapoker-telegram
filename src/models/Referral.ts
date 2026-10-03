import mongoose, { Document, Schema } from 'mongoose';

export interface IReferral extends Document {
  referrerId: number;      // Telegram ID del referidor
  referredId: number;      // Telegram ID del referido
  totalRake: number;       // Rake generado por el referido
  commission: number;      // Comisión ganada
  level: number;           // Nivel del referido (1, 2, 3)
  createdAt: Date;
  updatedAt: Date;
}

const referralSchema = new Schema<IReferral>({
  referrerId: { type: Number, required: true },
  referredId: { type: Number, required: true, unique: true },
  totalRake: { type: Number, default: 0 },
  commission: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
}, { timestamps: true });

// Índices para consultas por referidor (referredId ya es unique por esquema)
referralSchema.index({ referrerId: 1 });

export const Referral = mongoose.model<IReferral>('Referral', referralSchema);
