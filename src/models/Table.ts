import mongoose, { Document, Schema } from 'mongoose';
import { unitsToUsdt } from '../config/units';
import { avatarForDisplay } from '../config/avatars';
import { TURN_TIMER } from '../config/product';

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
  /**
   * Identificador del avatar elegido. Es solo una clave del catálogo; el
   * servidor decide si el jugador puede usarlo (algunos son exclusivos de
   * miembros) y la UI pinta el arte correspondiente.
   */
  avatar?: string;

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
  /**
   * Banco de tiempo disponible en la mano actual, en milisegundos. Se
   * reinicia al empezar cada mano. Solo se usa para humanos; los bots no
   * tienen banco.
   */
  timeBankMs?: number;

  joinedAt: Date;
}

/**
 * Una mano cerrada, tal como se guarda para el historial.
 *
 * `players` conserva las cartas privadas de TODOS los que jugaron la mano.
 * Es un dato interno de la mesa y NUNCA debe serializarse entero: la vista
 * pública deja `myCards` solo para el asiento del espectador y las cartas de
 * los rivales solo si llegaron al showdown. Los bots no tienen una etiqueta
 * distinta: son jugadores con nombre y cartas.
 */
/**
 * Fotografia de un all-in para el replay del showdown.
 *
 * Las equidades se calculan al cerrar la mano, una por calle y con el board
 * parcial de esa calle. No son el resultado definitivo: son la probabilidad
 * que tenia cada mano cuando se conocian esas cartas. La UI las reproduce con
 * una pequena pausa para que se vea como en una retransmision.
 */
export interface AllInReveal {
  /** Calle en la que se produjo el primer all-in. */
  startStreet: 'preflop' | 'flop' | 'turn' | 'river';
  /** Board completo, en notacion `rank|suit`. */
  board: string[];
  players: Array<{
    seatIndex: number;
    displayName: string;
    cards: string[];
    /** Porcentaje por calle; la clave es preflop, flop, turn o river. */
    equity: Record<'preflop' | 'flop' | 'turn' | 'river', number>;
    /** Nombre de la mano que se ve en esa calle. */
    handName: Record<'preflop' | 'flop' | 'turn' | 'river', string>;
  }>;
}

export interface HandHistoryEntry {
  handNumber: number;
  endedAt: string;
  pot: number;
  rake: number;
  board: string[];
  unit: 'USDT' | 'PTS';
  endedByFold: boolean;
  players: Array<{
    seatIndex: number;
    displayName: string;
    cards: string[];
    folded: boolean;
  }>;
  winners: Array<{
    seatIndex: number;
    displayName: string;
    amount: number;
    handName: string;
    cards: string[];
  }>;
  showdown: Array<{
    seatIndex: number;
    displayName: string;
    cards: string[];
    handName: string;
  }>;
}

export interface ITable extends Document {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'centroll' | 'tournament';
  /** Solo en mesas cash */
  tierId?: string;
  /**
   * Formato de la mesa cash: '7max', '6max' o 'hu'. Las mesas antiguas sin
   * este campo se tratan como 7-max.
   */
  formatId?: string;
  /** Solo en freeroll */
  prizeTier?: number;

  status: 'waiting' | 'running' | 'paused' | 'finished';

  smallBlind: number;
  bigBlind: number;

  /**
   * Ciegas base de una mesa de campo. Las ciegas actuales cambian por nivel;
   * estas no. Se guardan para poder recalcular el nivel sin depender del tier
   * ni de una copia en memoria.
   */
  blindBaseSmall?: number;
  blindBaseBig?: number;
  /** Nivel actual de ciegas (0 = ciegas base). Solo mesas de campo. */
  blindLevel?: number;
  /** Momento en que arrancó el reloj de ciegas (nivel 0). */
  blindLevelStartedAt?: Date;

  /**
   * Buy-in de la mesa, en UNIDADES INTERNAS (1/1000 de USDT).
   *
   * No es `minBuyIn` como antes: en un campo el buy-in es unico y lo fija el
   * tier. Antes cada mesa tenia su propio minimo y podia aceptar a alguien con
   * menos fichas que los demas, lo que en un campo es una excepcion sin sentido:
   * todos pagan lo mismo para tener las mismas fichas.
   */
  buyInUnits: number;

  /**
   * Fichas con las que entra cada jugador. Solo en mesas de freeroll.
   *
   * En un freeroll el `buyInUnits` es 0 (nadie paga), pero las fichas del torneo no son
   * cero. Sin este campo los bots entraban con `smallBlind * 2` y se quedaban sin stack en
   * dos manos, mientras el humano tenia 100 ciegas.
   */
  startChips?: number;

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
    /**
     * Momento en el que puede empezar la siguiente mano. La mesa queda en
     * `idle` unos segundos despues de cerrar para que el jugador vea el
     * resultado y las cartas del showdown. Sin esta pausa la mano siguiente
     * tapaba el ganador casi al instante.
     */
    nextHandAt?: Date;
    /**
     * Resultado de la última mano. La mesa vuelve a `idle` en cuanto termina,
     * así que sin este snapshot la UI nunca puede mostrar quién ganó, con qué
     * mano ni cuánto se llevó.
     */
    lastResult?: {
      handNumber: number;
      endedAt: string;
      pot: number;
      potUsdt: number;
      rake: number;
      rakeUsdt: number;
      board: string[];
      winners: Array<{
        seatIndex: number;
        displayName: string;
        amount: number;
        amountUsdt: number;
        handName: string;
        cards: string[];
      }>;
      showdown: Array<{
        seatIndex: number;
        displayName: string;
        cards: string[];
        handName: string;
      }>;
      endedByFold: boolean;
      unit: 'USDT' | 'PTS';
      /** Solo si hubo all-in y showdown; alimenta el replay con porcentajes. */
      allIn?: AllInReveal;
    };
  };

  /**
   * Ultimas manos cerradas de la mesa, de la mas reciente a la mas antigua.
   * Se limita para no crecer sin fin en una mesa cash que vive dias.
   */
  handHistory?: HandHistoryEntry[];

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
    avatar: String,

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
    timeBankMs: { type: Number, default: 30_000 },

    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const tableSchema = new Schema<ITable>({
  tableId: { type: String, required: true, unique: true, index: true },
  // `centroll` faltaba, y no fallaba el campo: fallaba LA MESA, al sentar al primer
  // jugador. Se veia como "Table validation failed", no como un problema de enum.
  kind: {
    type: String,
    enum: ['cash', 'freeroll', 'centroll', 'tournament'],
    required: true,
    index: true,
  },
  tierId: String,
  // Formato cash: 7max, 6max o hu. Ausente en mesas antiguas = 7max.
  formatId: String,
  prizeTier: Number,

  status: {
    type: String,
    enum: ['waiting', 'running', 'paused', 'finished'],
    default: 'waiting',
    index: true,
  },

  smallBlind: { type: Number, required: true },
  bigBlind: { type: Number, required: true },
  // Ciegas base y reloj del torneo. En cash quedan sin definir.
  blindBaseSmall: Number,
  blindBaseBig: Number,
  blindLevel: Number,
  blindLevelStartedAt: Date,
  buyInUnits: { type: Number, required: true },
  // Fichas iniciales del freeroll. Es distinto del buy-in: aqui nadie paga.
  startChips: Number,

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
    nextHandAt: Date,
    // Snapshot heterogéneo: winners y showdown tienen formas distintas y no
    // se consultan por campo. Mixed evita duplicar el esquema en dos sitios.
    lastResult: { type: Schema.Types.Mixed, default: undefined },
  },

  // Historial heterogéneo: las cartas privadas se guardan en `players` y se
  // recortan al serializar. Mixed evita congelar una forma que aún cambia.
  handHistory: { type: [Schema.Types.Mixed] as any, default: [] },

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
  // Una mesa de campo es un torneo: sus "fichas" son puntos, no USDT. Solo las
  // ring tables cash muestran dinero real. Esto lo decide el servidor para que
  // la UI no tenga que adivinar a partir de `kind`.
  const esCashRing = table.kind === 'cash' && !table.field?.fieldId;
  const modo: 'USDT' | 'PTS' = esCashRing ? 'USDT' : 'PTS';
  const aMostrar = (unidades: number) =>
    modo === 'USDT' ? unitsToUsdt(unidades) : unidades;

  // ------------------------------------------------------------------
  // HISTORIAL REDACTADO
  //
  // El documento guarda las cartas de todos para poder reconstruir la mano.
  // La vista pública no las copia a ciegas:
  //
  //   - `myCards` solo para el asiento del espectador.
  //   - las cartas de un rival solo si están en `showdown`.
  //   - un ganador que ganó porque todos se retiraron no muestra sus cartas.
  //
  // Los bots no tienen un campo especial: si un bot llega al showdown, sus
  // cartas son públicas como las de cualquier rival. Si no llega, no viajan.
  // ------------------------------------------------------------------
  const asientosEnShowdown = (entrada: { showdown?: Array<{ seatIndex: number }> }) =>
    new Set((entrada.showdown ?? []).map((s) => s.seatIndex));

  const redactarResultado = (resultado: NonNullable<ITable['hand']['lastResult']>) => {
    const publicas = asientosEnShowdown(resultado);
    return {
      ...resultado,
      winners: (resultado.winners ?? []).map((w) => ({
        ...w,
        // El ganador por fold no revela su mano; el espectador sí puede ver
        // las cartas que él mismo tenía.
        cards: publicas.has(w.seatIndex) || w.seatIndex === viewerSeat
          ? (w.cards ?? [])
          : [],
      })),
      showdown: (resultado.showdown ?? []).map((s) => ({ ...s })),
    };
  };

  const historial = (table.handHistory ?? []).map((entrada) => {
    const publicas = asientosEnShowdown(entrada);
    const yo = (entrada.players ?? []).find(
      (p) => p.seatIndex === viewerSeat,
    );

    return {
      handNumber: entrada.handNumber,
      endedAt: entrada.endedAt,
      pot: entrada.pot,
      potUsdt: unitsToUsdt(entrada.pot),
      rake: entrada.rake,
      rakeUsdt: unitsToUsdt(entrada.rake),
      board: entrada.board ?? [],
      unit: entrada.unit ?? modo,
      endedByFold: entrada.endedByFold,
      myCards: yo?.cards ?? [],
      winners: (entrada.winners ?? []).map((w) => ({
        seatIndex: w.seatIndex,
        displayName: w.displayName,
        amount: w.amount,
        amountUsdt: unitsToUsdt(w.amount),
        handName: w.handName,
        cards: publicas.has(w.seatIndex) || w.seatIndex === viewerSeat
          ? (w.cards ?? [])
          : [],
      })),
      showdown: (entrada.showdown ?? []).map((s) => ({
        seatIndex: s.seatIndex,
        displayName: s.displayName,
        cards: s.cards ?? [],
        handName: s.handName,
      })),
    };
  });

  return {
    tableId: table.tableId,
    kind: table.kind,
    tierId: table.tierId,
    formatId: table.formatId ?? '7max',
    prizeTier: table.prizeTier,
    /** Unidad que debe pintar la mesa: USDT en cash ring, puntos en torneos. */
    mode: modo,

    status: table.status,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    // Nivel de ciegas del torneo. En cash es 0 y no se pinta.
    blindLevel: table.blindLevel ?? 0,
    blindLevelStartedAt: table.blindLevelStartedAt?.toISOString?.(),
    // El buy-in viaja en unidades internas, pero la UI lo necesita en USDT.
    // Convertir aqui y no en el cliente: la regla de redondeo (hacia abajo al
    // entrar, ver `config/units.ts`) tiene que ser la misma en todas partes.
    buyInUnits: table.buyInUnits,
    buyInUsdt: unitsToUsdt(table.buyInUnits),
    smallBlindUsdt: unitsToUsdt(table.smallBlind),
    bigBlindUsdt: unitsToUsdt(table.bigBlind),

    maxSeats: table.maxSeats,
    // Cuantos asientos estan ocupados, sin separar por tipo. La vista publica no
    // distingue humanos de bots: para el jugador todos son rivales de la mesa.
    occupied: table.seats.length,

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
      potUsdt: unitsToUsdt(table.hand.pot),
      currentBet: table.hand.currentBet,
      currentBetUsdt: unitsToUsdt(table.hand.currentBet),
      // Indice del asiento que tiene el turno, -1 si nadie. La mesa lo usa para
      // iluminar al jugador que piensa; es publico, como el propio turno.
      actingSeat: table.hand.actingSeat ?? -1,
      /**
       * Reloj publico del turno. El cliente pinta el aro del avatar con
       * `turnEndsAt - ahora`; el time bank mueve `lastActionAt` y por tanto
       * alarga este vencimiento sin que la UI tenga que saber nada mas.
       */
      turnStartedAt: table.hand.lastActionAt
        ? new Date(table.hand.lastActionAt).toISOString()
        : null,
      turnEndsAt: table.hand.lastActionAt
        ? new Date(
            new Date(table.hand.lastActionAt).getTime() + TURN_TIMER.humanMs,
          ).toISOString()
        : null,
      nextHandAt: table.hand.nextHandAt
        ? new Date(table.hand.nextHandAt).toISOString()
        : null,
      lastResult: table.hand.lastResult
        ? redactarResultado(table.hand.lastResult)
        : undefined,
    },

    // Historial de las últimas manos, ya recortado para este espectador.
    history: historial,

    stats: table.stats,

    seats: table.seats.map(s => ({
      index: s.index,
      displayName: s.displayName,
      avatar: s.avatar ?? 'fox',
      // El emoji se resuelve en el servidor para que la interfaz no tenga que
      // mantener una copia del catálogo ni romperse si se añade un avatar.
      avatarEmoji: avatarForDisplay(s.avatar).emoji,
      chips: s.chips,
      chipsUsdt: unitsToUsdt(s.chips),
      displayChips: aMostrar(s.chips),
      bet: s.bet,
      betUsdt: unitsToUsdt(s.bet),
      displayBet: aMostrar(s.bet),
      status: s.status,
      isDealer: s.isDealer,
      isSmallBlind: s.isSmallBlind,
      isBigBlind: s.isBigBlind,
      lastAction: s.lastAction,
      // Marca el asiento del espectador, para que la UI resalte su turno
      isYou: s.index === viewerSeat,
    })),
  };
};

export const Table = mongoose.model<ITable>('Table', tableSchema);
