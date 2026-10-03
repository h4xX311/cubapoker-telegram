import mongoose, { Document, Schema } from 'mongoose';

export interface IGame extends Document {
  gameId: string;
  players: string[];
  status: 'waiting' | 'active' | 'completed';
  pot: number;
  rake: number;
  winner?: string;
  createdAt: Date;
  updatedAt: Date;
}

const gameSchema = new Schema<IGame>({
  gameId: { type: String, required: true, unique: true },
  players: [{ type: String }],
  status: { type: String, default: 'waiting' },
  pot: { type: Number, default: 0 },
  rake: { type: Number, default: 0 },
  winner: { type: String },
}, { timestamps: true });

export const Game = mongoose.model<IGame>('Game', gameSchema);
