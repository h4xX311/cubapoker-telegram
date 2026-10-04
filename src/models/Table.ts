import mongoose, { Document, Schema } from 'mongoose';

/**
 * Estado de un asiento en la mesa.
 *
 * `kind` distingue humano de bot. Esa unica bandera es lo que permite que el
 * motor de juego trate a ambos con el mismo codigo pero reglas distintas
 * (el bot no recibe recordatorios, no ocupa turno de forma bloqueante y su
 * saldo no se toca en la base de datos).
 */
export type SeatKind = 'human' | 'bot';

export type SeatStatus = 'active' | 'folded' | 'all_in' | 'sitting_out' | 'eliminated';

export interface ISeat {
  index: number;
  kind: SeatKind;
  /** telegramId para humanos; botId para bots */
  playerId: string;
  displayName: string;

  /** Fichas en la mesa */
  chips: number;
  /** Fichas que ha puesto en la mano actual */
  bet: number;
  /** Total aportado en la mano (para el pot) */
  totalBet: number;

  status: SeatStatus;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;

  /** Personalidad, solo para bots */
  botProfile?: {
    style: string;
    winRate: number;
    raiseFreq: number;
    foldFreq: number;
    aggression: number;
  };

  /** Estadisticas de la sesion */
  handsPlayed: number;
  handsWon: number;
  /** Resultado neto de la sesion (positivo = gana) */
  netChips: number;
  lastAction?: string;

  joinedAt: Date;
}

export interface ITable extends Document {
  tableId: string;
  kind: 'cash' | 'freeroll';
  /** Solo en mesas cash */
  tierId?: string;
  /** Solo en freeroll */
  prizeTier?: number;

  status: 'waiting' | 'running' | 'paused' | 'finished';

  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  /** Premio garantizado (cash) o bote del freeroll */
  guaranteedPrize: number;

  seats: ISeat[];
  maxSeats: number;

  /** Estado volatil de la mano en curso */
  hand: {
    handNumber: number;
    phase: string;
    communityCards: string[];
    pot: number;
    currentBet: number;
    /** Indice del asiento cuyo turno es */
    actingSeat: number;
    dealerSeat: number;
    startedAt?: Date;
    lastActionAt?: Date;
  };

  /** Estadisticas agregadas */
  stats: {
    handsPlayed: number;
    rakeCollected: number;
    prizePaid: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

const seatSchema = new Schema<ISeat>(
  {
    index: { type: Number, required: true },
    kind: { type: String, enum: ['human', 'bot'], required: true },
    playerId: { type: String, required: true },
    displayName: { type: String, required: true },

    chips: { type: Number, default: 0 },
    bet: { type: Number, default: 0 },
    totalBet: { type: Number, default: 0 },

    status: { type: String, default: 'active' },
    isDealer: { type: Boolean, default: false },
    isSmallBlind: { type: Boolean, default: false },
    isBigBlind: { type: Boolean, default: false },

    botProfile: {
      style: String,
      winRate: Number,
      raiseFreq: Number,
      foldFreq: Number,
      aggression: Number,
    },

    handsPlayed: { type: Number, default: 0 },
    handsWon: { type: Number, default: 0 },
    netChips: { type: Number, default: 0 },
    lastAction: String,

    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const tableSchema = new Schema<ITable>({
  tableId: { type: String, required: true, unique: true, index: true },
  kind: { type: String, enum: ['cash', 'freeroll'], required: true, index: true },
  tierId: String,
  prizeTier: Number,

  status: {
    type: String,
    enum: ['waiting', 'running', 'paused', 'finished'],
    default: 'waiting',
    index: true,
  },

  smallBlind: { type: Number, required: true },
  bigBlind: { type: Number, required: true },
  minBuyIn: { type: Number, required: true },
  guaranteedPrize: { type: Number, default: 0 },

  seats: { type: [seatSchema], default: [] },
  maxSeats: { type: Number, required: true },

  hand: {
    handNumber: { type: Number, default: 0 },
    phase: { type: String, default: 'idle' },
    communityCards: { type: [String], default: [] },
    pot: { type: Number, default: 0 },
    currentBet: { type: Number, default: 0 },
    actingSeat: { type: Number, default: -1 },
    dealerSeat: { type: Number, default: 0 },
    startedAt: Date,
    lastActionAt: Date,
  },

  stats: {
    handsPlayed: { type: Number, default: 0 },
    rakeCollected: { type: Number, default: 0 },
    prizePaid: { type: Number, default: 0 },
  },
}, { timestamps: true });

tableSchema.index({ kind: 1, status: 1, tierId: 1 });

/**
 * Vista publica de la mesa.
 * Nunca se envia al cliente el estado interno completo: solo lo necesario para
 * pintar la interfaz. Las cartas de los demas no viajan nunca.
 */
export const toPublicTable = (table: ITable, viewerSeat?: number) => {
  const isFreeroll = table.kind === 'freeroll';

  return {
    tableId: table.tableId,
    kind: table.kind,
    tierId: table.tierId,
    prizeTier: table.prizeTier,

    status: table.status,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    guaranteedPrize: table.guaranteedPrize,

    maxSeats: table.maxSeats,
    occupied: table.seats.length,
    humans: table.seats.filter(s => s.kind === 'human').length,
    bots: table.seats.filter(s => s.kind === 'bot').length,

    hand: {
      handNumber: table.hand.handNumber,
      phase: table.hand.phase,
      communityCards: table.hand.communityCards,
      pot: table.hand.pot,
      currentBet: table.hand.currentBet,
    },

    stats: table.stats,

    seats: table.seats.map(s => ({
      index: s.index,
      kind: s.kind,
      displayName: s.displayName,
      chips: s.chips,
      bet: s.bet,
      status: s.status,
      isDealer: s.isDealer,
      isSmallBlind: s.isSmallBlind,
      isBigBlind: s.isBigBlind,
      lastAction: s.lastAction,
      // Marca el asiento del espectador, para que la UI resalte su turno
      isYou: s.index === viewerSeat,
      botStyle: s.kind === 'bot' ? s.botProfile?.style : undefined,
    })),
  };
};

export const Table = mongoose.model<ITable>('Table', tableSchema);
