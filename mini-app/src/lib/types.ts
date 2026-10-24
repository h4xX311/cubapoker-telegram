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
  defaultNetwork: string;
  networkFees: Record<string, { fee: number; free: boolean }>;
}

export interface ProductConfig {
  seatsPerTable: number;
  cashTiers: CashTier[];
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
  chips: number;
  bet: number;
  status: string;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction?: string;
  isYou: boolean;
}

export interface TableView {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'centroll';
  tierId?: string;
  prizeTier?: number;
  status: string;
  /** Ciegas en fichas de la mesa, no en USDT. */
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  occupied: number;
  hand: {
    handNumber: number;
    phase: string;
    communityCards: string[];
    pot: number;
    currentBet: number;
  };
  seats: SeatView[];
  myCards?: { rank: string; suit: string }[];
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
