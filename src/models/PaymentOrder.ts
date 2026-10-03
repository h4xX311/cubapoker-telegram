import mongoose, { Document, Schema } from 'mongoose';
import type { PaymentProvider, OrderStatus } from '../services/payment/gateway';

/**
 * Orden de pago persistida.
 *
 * Guardar la orden en base de datos (y no solo en memoria) es lo que permite
 * auditar el dinero: cada abono tiene un origen rastreable aunque la pasarela
 * real aun no este conectada.
 */
export interface IPaymentOrder extends Document {
  orderId: string;
  provider: PaymentProvider;
  telegramId: number;
  type: 'deposit' | 'withdrawal';
  amount: number;
  currency: 'CUP' | 'USDT';
  chain?: string;
  status: OrderStatus;
  simulated: boolean;
  externalId?: string;
  txHash?: string;
  walletAddress?: string;
  instructions?: Record<string, string>;
  creditedAmount?: number;
  commission?: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const paymentOrderSchema = new Schema<IPaymentOrder>({
  orderId: { type: String, required: true, unique: true },
  provider: { type: String, required: true },
  telegramId: { type: Number, required: true },
  type: { type: String, required: true, enum: ['deposit', 'withdrawal'] },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  chain: { type: String },
  status: { type: String, default: 'pending' },
  simulated: { type: Boolean, default: true },
  externalId: { type: String },
  txHash: { type: String },
  walletAddress: { type: String },
  instructions: { type: Schema.Types.Mixed },
  creditedAmount: { type: Number },
  commission: { type: Number },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

paymentOrderSchema.index({ telegramId: 1, createdAt: -1 });
paymentOrderSchema.index({ status: 1, createdAt: -1 });
paymentOrderSchema.index({ simulated: 1, status: 1 });

export const PaymentOrder = mongoose.model<IPaymentOrder>(
  'PaymentOrder',
  paymentOrderSchema,
);
