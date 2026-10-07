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
    /** USDT retirables (depositos) */
    real: number;
    /** USDT de promocion, no retirables (freerolls, bonuses) */
    play: number;
    /**
     * Parte de `real` que viene de PREMIOS, no de depositos.
     *
     * ------------------------------------------------------------------
     * PARA QUE EXISTE
     *
     * Decision del 7 de octubre: **lo que se gana es del jugador y se puede retirar.** Antes
     * el premio de un campo iba entero a `play`, con lo cual ganar un torneo no daba dinero
     * retirable: se podia jugar mucho rato para acabar con saldo bloqueado.
     *
     * Pero premio y deposito no son lo mismo, y mezclarlos tiene consecuencias: un premio
     * grande seria indistinguible de dinero entrante, que es justo lo que un AML mira. Y el
     * propio codigo lo decia: "si el premio fuera a `balance.real`, ganar un campo seria
     * indistinguible de un deposito".
     *
     * Con este campo se cumplen las dos cosas: el premio entra a `real` y se retira normal,
     * y ademas queda marcado como premio. El saldo no se parte en dos ni el jugador tiene que
     * hacer nada: es una etiqueta, no un saldo aparte.
     *
     * Nunca puede ser mayor que `real`: es una parte, no una cantidad independiente. Cuando
     * el jugador gasta saldo, esta cifra baja en la misma proporcion.
     */
    realFromPrizes?: number;
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
    // Parte de `real` que viene de premios. Ver el comentario de la interfaz: es una etiqueta
    // para poder distinguir premio de deposito, no un saldo aparte. Por eso puede ser 0 y por
    // eso vive DENTRO de `balance` y no al lado.
    realFromPrizes: { type: Number, default: 0, min: 0 },
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
