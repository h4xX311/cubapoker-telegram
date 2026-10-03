import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  telegramId: number;
  username: string;
  firstName: string;
  lastName?: string;
  balance: {
    usdt: number;
    credits: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  balance: {
    usdt: { type: Number, default: 0 },
    credits: { type: Number, default: 0 },
  },
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', userSchema);
