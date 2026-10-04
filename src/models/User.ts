import mongoose, { Document, Schema } from 'mongoose';

/**
 * Usuario de CubaPoker.
 *
 * BALANCE DOBLE
 * -------------
 * `real` : CUP de verdad. Originados en depositos. RETIRABLE.
 * `play` : saldo de promocion. Se genera en freerolls y regalos. NO RETIRABLE.
 *
 * La distincion existe porque los freerolls reparten 5-50 CUP. Si ese saldo
 * fuera retirable, un jugador podria vaciar su cuenta sin depositar nunca y el
 * modelo de negocio se rompe. Al no ser retirable, el freeroll funciona como
 * gancho de penetracion: invita a entrar, se juega con el saldo ganado, y si
 * quiere retirar tiene que depositar.
 *
 * El saldo que se consume al sentarse en una mesa cash es `play` primero
 * (ver BALANCE.playFirstOnCashTables), de modo que el saldo real se preserva
 * para retirarlo.
 */
export interface IUser extends Document {
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  /**
   * Chat privado donde avisar al jugador de que le toca.
   * Se guarda en `/start` porque es lo unico momento garantizado de que el
   * usuario haya iniciado una conversacion con el bot. En grupos no se avisa:
   * el mensaje del turno llegaria a todos.
   */
  chatId?: number;

  balance: {
    /** CUP retirables (depositos) */
    real: number;
    /** CUP de promocion, no retirables (freerolls) */
    play: number;
  };

  /** Estadisticas agregadas para el perfil */
  stats: {
    handsPlayed: number;
    handsWon: number;
    tablesJoined: number;
    freerollsPlayed: number;
    totalRakePaid: number;
    totalFreerollWon: number;
  };

  /** Estado del juego en curso, para reconectar tras cerrar la app */
  activeTableId?: string;

  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>({
  telegramId: { type: Number, required: true, unique: true, index: true },
  username: String,
  firstName: { type: String, default: 'Jugador' },
  lastName: String,
  chatId: { type: Number, index: true },

  balance: {
    real: { type: Number, default: 0, min: 0 },
    play: { type: Number, default: 0, min: 0 },
  },

  stats: {
    handsPlayed: { type: Number, default: 0 },
    handsWon: { type: Number, default: 0 },
    tablesJoined: { type: Number, default: 0 },
    freerollsPlayed: { type: Number, default: 0 },
    totalRakePaid: { type: Number, default: 0 },
    totalFreerollWon: { type: Number, default: 0 },
  },

  activeTableId: { type: String, default: null },
}, { timestamps: true });

/** Saldo total disponible para jugar (real + play). */
userSchema.virtual('totalBalance').get(function (this: IUser) {
  return this.balance.real + this.balance.play;
});

/** Saldo retirable. La UI debe mostrarlo separado para no confundir. */
userSchema.virtual('withdrawable').get(function (this: IUser) {
  return this.balance.real;
});

export const User = mongoose.model<IUser>('User', userSchema);
