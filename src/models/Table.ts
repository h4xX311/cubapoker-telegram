import mongoose, { Document, Schema } from 'mongoose';
import { unitsToUsdt } from '../config/units';

/**
 * Estado de un asiento en la mesa.
 *
 * `kind` distingue humano de bot. Esa unica bandera es lo que permite que el
 * motor de juego trate a ambos con el mismo codigo pero reglas distintas
 * (el bot no recibe recordatorios, no ocupa turno de forma bloqueante y su
 * saldo no se toca en la base de datos).
 */
export type SeatKind = 'human' | 'bot';

/**
 * Estado de un asiento.
 *
 * `eliminated` y `out` parecen lo mismo y no lo son. La diferencia importa en
 * el gestor de campos:
 *
 *  - `eliminated`: el jugador se quedo sin fichas. AUN debe recuperar lo que
 *    tenga en la mesa y su posicion no esta adjudicada. Es transitorio.
 *  - `out`: ya esta liquidado. Se le devolvio el saldo y se le asigno su
 *    posicion en el campo. Contarlo otra vez como eliminado le daria una
 *    segunda posicion y le pagaria dos veces.
 *
 * En una mesa cash sin campo, `eliminated` pasa directamente a desaparecer del
 * asiento: no hay nada que liquidar.
 */
export type SeatStatus =
  | 'active'
  | 'folded'
  | 'all_in'
  | 'sitting_out'
  | 'eliminated'
  | 'out';

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
  /**
   * Buy-in de la mesa, en UNIDADES INTERNAS (1/1000 de USDT).
   *
   * No es `minBuyIn` como antes: en un campo el buy-in es unico y lo fija el
   * tier. Antes cada mesa tenia su propio minimo y podia aceptar a alguien con
   * menos fichas que los demas, lo que en un campo es una excepcion sin sentido:
   * todos pagan lo mismo para tener las mismas fichas.
   */
  buyInUnits: number;

  seats: ISeat[];
  /** Asientos de esta mesa fisica. Siempre SEATS_PER_TABLE (7). */
  maxSeats: number;

  /**
   * Pertenencia al campo multi-mesa.
   *
   * Un "campo de 500" no es una mesa de 500: son ~72 mesas de 7 que se fusionan
   * mano a mano hasta que queda una mesa final. Estas dos fases las usa el
   * field manager (aun por construir) para saber cuantas mesas quedan vivas y
   * quien se lleva el premio.
   */
  field?: {
    /** Identificador del campo al que pertenece esta mesa */
    fieldId: string;
    /** Posicion de esta mesa dentro del campo (1 = mesa final cuando queda 1) */
    tableNumber: number;
    /** Participantes objetivo para que arranque el campo */
    targetField: number;
    /** Inscritos hasta ahora en todo el campo */
    registered: number;
    /**Inscritos que ya no pueden volver a entrar (entraron a una mesa) */
    seated: number;
    /** Posiciones ya premiadas (1-based). El field manager lo rellena. */
    paidPositions?: number;
    /** Estado del campo. Una mesafinished tiene el campo 'finished'. */
    fieldStatus?: 'filling' | 'running' | 'final' | 'finished';
  };

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
  buyInUnits: { type: Number, required: true },

  seats: { type: [seatSchema], default: [] },
  maxSeats: { type: Number, required: true },

  // Multi-mesa: una mesa pertenece a un campo. El field manager (aun por
  // construir) es quien lee y escribe estos contadores.
  field: {
    fieldId: { type: String, index: true },
    tableNumber: { type: Number, default: 1 },
    targetField: { type: Number, default: 0 },
    registered: { type: Number, default: 0 },
    seated: { type: Number, default: 0 },
    paidPositions: { type: Number, default: 0 },
    fieldStatus: {
      type: String,
      enum: ['filling', 'running', 'final', 'finished'],
      default: 'filling',
    },
  },

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
    // El buy-in viaja en unidades internas, pero la UI lo necesita en USDT.
    // Convertir aqui y no en el cliente: la regla de redondeo (hacia abajo al
    // entrar, ver `config/units.ts`) tiene que ser la misma en todas partes.
    buyInUnits: table.buyInUnits,
    buyInUsdt: unitsToUsdt(table.buyInUnits),
    smallBlindUsdt: unitsToUsdt(table.smallBlind),
    bigBlindUsdt: unitsToUsdt(table.bigBlind),

    maxSeats: table.maxSeats,
    occupied: table.seats.length,
    humans: table.seats.filter(s => s.kind === 'human').length,
    bots: table.seats.filter(s => s.kind === 'bot').length,

    // Datos del campo multi-mesa para que la UI pueda mostrar
    // "mesa 23 de 72" y el progreso de inscripcion.
    field: table.field
      ? {
          fieldId: table.field.fieldId,
          tableNumber: table.field.tableNumber,
          targetField: table.field.targetField,
          registered: table.field.registered,
          seated: table.field.seated,
          fieldStatus: table.field.fieldStatus,
        }
      : undefined,

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
