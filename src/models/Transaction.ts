import mongoose, { Document, Schema } from 'mongoose';

export type TransactionType = 'deposit' | 'withdrawal' | 'game_bet' | 'game_win' | 'rake' | 'commission' | 'vip_purchase' | 'referral_commission' | 'tournament_buyin' | 'tournament_prize';
export type PaymentMethod = 'enzona' | 'qvapay' | 'usdt' | 'credits';
export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface ITransaction extends Document {
  telegramId: number;
  type: TransactionType;
  paymentMethod: PaymentMethod;
  amount: number;
  currency: 'CUP' | 'USDT';
  status: TransactionStatus;
  commission?: number;      // Comisión cobrada
  commissionRate?: number;  // Tasa de comisión aplicada
  externalId?: string;      // ID de transacción externa (EnZona, QvaPay, etc.)
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const transactionSchema = new Schema<ITransaction>({
  telegramId: { type: Number, required: true },
  type: { type: String, required: true },
  paymentMethod: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  status: { type: String, default: 'pending' },
  commission: { type: Number, default: 0 },
  commissionRate: { type: Number, default: 0 },
  externalId: { type: String },
  metadata: { type: Schema.Types.Mixed },
}, { timestamps: true });

// Índices para búsquedas rápidas
transactionSchema.index({ telegramId: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ createdAt: -1 });

export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);

// Configuración de comisiones
export const COMMISSION_CONFIG = {
  deposit: {
    enzona: 1.5,    // 1.5%
    qvapay: 1.5,    // 1.5%
    usdt: 0.5,      // 0.5%
  },
  withdrawal: {
    enzona: 3,      // 3%
    qvapay: 3,      // 3%
    usdt: 1,        // 1%
  },
  minCommission: {
    deposit: 10,    // Mínimo 10 CUP
    withdrawal: 20, // Mínimo 20 CUP
  },
  maxCommission: {
    deposit: 500,   // Máximo 500 CUP
    withdrawal: 1000, // Máximo 1000 CUP
  },
};
