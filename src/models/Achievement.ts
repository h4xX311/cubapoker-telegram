import mongoose, { Document, Schema } from 'mongoose';

export interface IAchievement extends Document {
  telegramId: number;
  achievementId: string;
  unlockedAt: Date;
  progress: number;
  maxProgress: number;
  claimed: boolean;
  reward: number; // CUP reward
}

const achievementSchema = new Schema<IAchievement>({
  telegramId: { type: Number, required: true },
  achievementId: { type: String, required: true },
  unlockedAt: { type: Date, default: Date.now },
  progress: { type: Number, default: 0 },
  maxProgress: { type: Number, required: true },
  claimed: { type: Boolean, default: false },
  reward: { type: Number, default: 0 },
}, { timestamps: true });

// Índice único para evitar duplicados
achievementSchema.index({ telegramId: 1, achievementId: 1 }, { unique: true });

export const Achievement = mongoose.model<IAchievement>('Achievement', achievementSchema);

// Definición de logros
export const ACHIEVEMENTS = {
  // Logros de juego
  first_win: {
    id: 'first_win',
    name: 'Primera Victoria',
    description: 'Gana tu primera mano',
    reward: 50,
    maxProgress: 1,
  },
  win_streak_3: {
    id: 'win_streak_3',
    name: 'Racha de 3',
    description: 'Gana 3 manos consecutivas',
    reward: 100,
    maxProgress: 3,
  },
  win_streak_5: {
    id: 'win_streak_5',
    name: 'Racha de 5',
    description: 'Gana 5 manos consecutivas',
    reward: 250,
    maxProgress: 5,
  },
  win_streak_10: {
    id: 'win_streak_10',
    name: 'Racha de 10',
    description: 'Gana 10 manos consecutivas',
    reward: 500,
    maxProgress: 10,
  },
  
  // Logros de manos
  royal_flush: {
    id: 'royal_flush',
    name: 'Escalera Real',
    description: 'Consigue una escalera real',
    reward: 1000,
    maxProgress: 1,
  },
  four_of_a_kind: {
    id: 'four_of_a_kind',
    name: 'Póker',
    description: 'Consigue un póker (four of a kind)',
    reward: 500,
    maxProgress: 1,
  },
  full_house: {
    id: 'full_house',
    name: 'Full House',
    description: 'Consigue un full house',
    reward: 200,
    maxProgress: 1,
  },
  
  // Logros de volumen
  hands_played_10: {
    id: 'hands_played_10',
    name: '10 Manos',
    description: 'Juega 10 manos',
    reward: 50,
    maxProgress: 10,
  },
  hands_played_50: {
    id: 'hands_played_50',
    name: '50 Manos',
    description: 'Juega 50 manos',
    reward: 200,
    maxProgress: 50,
  },
  hands_played_100: {
    id: 'hands_played_100',
    name: '100 Manos',
    description: 'Juega 100 manos',
    reward: 500,
    maxProgress: 100,
  },
  hands_played_500: {
    id: 'hands_played_500',
    name: '500 Manos',
    description: 'Juega 500 manos',
    reward: 2000,
    maxProgress: 500,
  },
  
  // Logros de torneos
  tournament_win: {
    id: 'tournament_win',
    name: 'Campeón',
    description: 'Gana un torneo',
    reward: 500,
    maxProgress: 1,
  },
  tournament_finalist: {
    id: 'tournament_finalist',
    name: 'Finalista',
    description: 'Llega a la final de un torneo',
    reward: 200,
    maxProgress: 1,
  },
  
  // Logros sociales
  referral_1: {
    id: 'referral_1',
    name: 'Reclutador',
    description: 'Invita a 1 amigo',
    reward: 100,
    maxProgress: 1,
  },
  referral_5: {
    id: 'referral_5',
    name: 'Embajador',
    description: 'Invita a 5 amigos',
    reward: 500,
    maxProgress: 5,
  },
  referral_10: {
    id: 'referral_10',
    name: 'Leyenda',
    description: 'Invita a 10 amigos',
    reward: 1000,
    maxProgress: 10,
  },
  
  // Logros de depósito
  first_deposit: {
    id: 'first_deposit',
    name: 'Primer Depósito',
    description: 'Haz tu primer depósito',
    reward: 50,
    maxProgress: 1,
  },
  deposit_1000: {
    id: 'deposit_1000',
    name: 'Depósito 1000',
    description: 'Deposita 1000 CUP en total',
    reward: 100,
    maxProgress: 1000,
  },
  deposit_10000: {
    id: 'deposit_10000',
    name: 'Depósito 10000',
    description: 'Deposita 10000 CUP en total',
    reward: 500,
    maxProgress: 10000,
  },
};

// Sistema de rachas
export interface IStreak extends Document {
  telegramId: number;
  currentStreak: number;
  bestStreak: number;
  lastWinAt: Date;
  streakType: 'daily' | 'weekly';
}

const streakSchema = new Schema<IStreak>({
  telegramId: { type: Number, required: true, unique: true },
  currentStreak: { type: Number, default: 0 },
  bestStreak: { type: Number, default: 0 },
  lastWinAt: { type: Date },
  streakType: { type: String, default: 'daily' },
}, { timestamps: true });

export const Streak = mongoose.model<IStreak>('Streak', streakSchema);

// Recompensas por racha
export const STREAK_REWARDS = {
  3: 50,    // 3 días seguidos
  7: 200,   // 1 semana
  14: 500,  // 2 semanas
  30: 1500, // 1 mes
};
