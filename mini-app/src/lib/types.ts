/**
 * Tipos compartidos del Mini App.
 *
 * MONEDA: la unica moneda de la plataforma es USDT. Los importes de cuenta que
 * llegan por la API ya estan en USDT; las unidades internas (1 USDT = 1000) no
 * cruzan la frontera. Las fichas de una mesa son otra cosa: son chips de juego.
 */

export const PAGES = [
  'home',
  'profile',
  'deposit',
  'withdraw',
  'game',
  'tables',
  'freeroll',
  'centroll',
  'tournaments',
  'vip',
  'referrals',
  'achievements',
  'source',
] as const;

export type Page = (typeof PAGES)[number];

export interface Balance {
  /**
   * Saldo retirable, en USDT. Origen: depositos y ganancias.
   *
   * Un retiro solo puede consumir esta parte: el saldo de `play` se desbloquea a
   * `real` jugando, no directamente.
   */
  real: number;
  /**
   * Promotional Dollars, en USDT. NO es retirable: se desbloquea 1 de cada 10
   * al usarlo. Origen: premios de freeroll, centrolls, logros y referidos.
   */
  play: number;
  /** Suma de ambos: lo que puede gastar en jugar. */
  total: number;
  /** Alias de `real`, explicito para la UI de retiro. */
  withdrawable: number;
}

export interface UserStats {
  handsPlayed: number;
  handsWon: number;
  tablesJoined: number;
  freerollsPlayed: number;
  totalRakePaid: number;
  totalFreerollWon: number;
}

export interface AvatarOption {
  id: string;
  emoji: string;
  label: string;
  memberOnly: boolean;
  /** El servidor ya resolvió si la membresía lo desbloquea. */
  unlocked: boolean;
}

export interface Session {
  id: string;
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  balance: Balance;
  stats: UserStats;
  activeTableId: string | null;
  vip: string | null;
  /** Clave del catálogo de avatares. */
  avatar?: string;
  avatarCatalog?: AvatarOption[];
}

// --- Mesas ---

export interface PayoutEntry {
  /** Posicion final en el campo, 1-based. 1 = ganador. */
  position: number;
  /** Importe en USDT, a campo lleno. */
  amount: number;
  /** Porcentaje del bote. */
  percentage: number;
}

export interface CashTier {
  id: string;
  label: string;
  description: string;
  /** Buy-in por jugador, en USDT. */
  buyIn: number;
  /** Ciegas en USDT. */
  blinds: { small: number; big: number };
  /** Stack de referencia en ciegas grandes. */
  stackInBigBlinds: number;
  /** VIP Arena es una sala de cash, no una membresía. */
  vipArena?: boolean;
  /** Profit share semanal de la sala, en porcentaje del rake. */
  arenaProfitSharePercent?: number;
}

/** Formato de mesa cash disponible en una sala. */
export interface CashFormat {
  id: '7max' | '6max' | 'hu';
  label: string;
  shortLabel: string;
  maxSeats: number;
}

/** Un freeroll en el lobby (abierto o en juego). */
export interface FreerollCampo {
  fieldId: string;
  inicio: string | null;
  finRegistro: string | null;
  estado: string;
  premioUsdt: number;
  inscritos: number;
  jugadoresVivos: number;
  plazasPagadas: number;
  /** Porcentaje por posicion: [50, 30, 20]. */
  reparto: number[];
  inscrito: boolean;
  maxPorMesa: number;
  tamanoMaximo: number;
}

/** Un slot de la lista de proximas horas (puede no tener campo creado aun). */
export interface FreerollSlot {
  clave: string;
  inicio: string;
  finRegistro: string;
  premioUsdt: number;
  jugadores: number;
  estado: string;
}

/** Mecanismo de Promotional Dollars. */
export interface UnlockInfo {
  /** Fraccion que se desbloquea al jugar (0,1 = 1 de cada 10). */
  rate: number;
  /** Texto tipo "1:10". */
  ratioLabel: string;
  /** Explicacion para la interfaz. */
  disclosure: string;
}

export interface WithdrawalLimits {
  min: number;
  maxPerTransaction: number;
  monthlyWinCap: number;
  /** Comision fija por retiro, en USDT. */
  fixedFee: number;
  defaultNetwork: string;
  networkFees: Record<string, { fee: number; free: boolean }>;
}

export interface ProductConfig {
  seatsPerTable: number;
  cashTiers: CashTier[];
  cashFormats: CashFormat[];
  prizeDisclosure: string;
  freerollTiers: readonly number[];
  freerollTargetField: number;
  freerollMaxField: number;
  centroll: {
    buyIn: number;
    prizeMultiplier: number;
    targetField: number;
    maxField: number;
    maxRebuys: number;
  };
  unlock: UnlockInfo;
  withdrawals: WithdrawalLimits;
}

export interface TableSummary {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'centroll';
  tierId?: string;
  /** Formato cash: 7max, 6max o hu. */
  formatId?: string;
  status: string;
  /** Ciegas en USDT. */
  smallBlind: number;
  bigBlind: number;
  /** Buy-in de la mesa, en USDT. */
  buyIn: number;
  /** Asientos de esta mesa fisica (7). */
  maxSeats: number;
  /** Datos del campo multi-mesa al que pertenece. */
  field?: {
    fieldId: string;
    tableNumber: number;
    targetField: number;
    registered: number;
    seated: number;
    fieldStatus: 'filling' | 'running' | 'final' | 'finished';
  };
  occupied: number;
  pot: number;
  phase: string;
  handNumber: number;
  rakeCollected: number;
  prizePaid: number;
}

export interface FreerollSummary {
  prizeTier: number;
  /** Participantes inscritos en el campo (todas las mesas). */
  players: number;
  /** Objetivo de inscripcion para que arranque el campo. */
  fieldTarget: number;
  /** Asientos de una mesa fisica (siempre 7). */
  maxPlayers: number;
  phase: string;
  pot: number;
  tableId?: string;
  status?: string;
  payout: readonly number[];
  /** Siempre false: el premio de freeroll no es retirable. */
  withdrawable: boolean;
}

// --- Vista de mesa ---

export interface SeatView {
  index: number;
  displayName: string;
  /** Clave del catálogo de avatares. Puede estar vacío. */
  avatar?: string;
  /** Emoji ya resuelto por el servidor. */
  avatarEmoji?: string;
  chips: number;
  chipsUsdt: number;
  /** Lo que debe pintar la UI: USDT en cash ring, puntos en torneos. */
  displayChips: number;
  bet: number;
  betUsdt: number;
  displayBet: number;
  status: string;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction?: string;
  isYou: boolean;
}

export interface LastHandWinner {
  seatIndex: number;
  displayName: string;
  amount: number;
  amountUsdt: number;
  handName: string;
  cards: string[];
}

export interface LastHandShowdown {
  seatIndex: number;
  displayName: string;
  cards: string[];
  handName: string;
}

export interface LastHandResult {
  handNumber: number;
  endedAt: string;
  pot: number;
  potUsdt: number;
  rake: number;
  rakeUsdt: number;
  board: string[];
  winners: LastHandWinner[];
  showdown: LastHandShowdown[];
  endedByFold: boolean;
  unit: 'USDT' | 'PTS';
}

export interface TableView {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'centroll';
  tierId?: string;
  formatId?: string;
  prizeTier?: number;
  status: string;
  /** USDT en cash ring; PTS en torneos, freerolls y centrolls. */
  mode: 'USDT' | 'PTS';
  /** Ciegas en unidades internas. Para pintar, usar `smallBlindUsdt`. */
  smallBlind: number;
  bigBlind: number;
  smallBlindUsdt: number;
  bigBlindUsdt: number;
  buyInUnits: number;
  buyInUsdt: number;
  maxSeats: number;
  occupied: number;
  hand: {
    handNumber: number;
    phase: string;
    communityCards: string[];
    pot: number;
    potUsdt: number;
    currentBet: number;
    currentBetUsdt: number;
    /** Indice del asiento con el turno; -1 si nadie esta pensando. */
    actingSeat: number;
    lastResult?: LastHandResult;
  };
  seats: SeatView[];
  myCards?: { rank: string; suit: string }[];
  myHand?: { rank: string; name: string; cards?: string[] } | null;
  myChips?: number;
  myBet?: number;
  toCall?: number;
  minRaise?: number;
  canCheck?: boolean;
  canRaise?: boolean;
  isMyTurn?: boolean;
  turnEndsAt?: string | null;
}

/** Resuelve la ruta de la URL a una pagina de la app. */
export const pageFromPath = (pathname: string): Page => {
  const segment = pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  return (PAGES as readonly string[]).includes(segment) ? (segment as Page) : 'home';
};

export const SUIT_SYMBOL: Record<string, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

export const isRedSuit = (suit: string) => suit === 'hearts' || suit === 'diamonds';

export const PHASE_LABEL: Record<string, string> = {
  idle: 'Esperando',
  waiting: 'Esperando',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  finished: 'Finalizada',
};
