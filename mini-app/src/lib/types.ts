/** Tipos compartidos del Mini App. */

export const PAGES = [
  'home',
  'deposit',
  'withdraw',
  'game',
  'tables',
  'freeroll',
  'tournaments',
  'vip',
  'referrals',
  'achievements',
] as const;

export type Page = (typeof PAGES)[number];

export interface Balance {
  /** CUP de deposito. Unico retirable. */
  real: number;
  /** CUP de promocion. Solo para jugar. */
  play: number;
  /** Suma de ambos, para jugar en mesas. */
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

export interface CashTier {
  id: string;
  label: string;
  description: string;
  maxPlayers: number;
  guaranteedPrize: number;
  minBuyIn: number;
  defaultBuyIn: number;
}

export interface TableSummary {
  tableId: string;
  kind: 'cash' | 'freeroll';
  tierId?: string;
  status: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  guaranteedPrize: number;
  maxSeats: number;
  occupied: number;
  humans: number;
  bots: number;
  pot: number;
  phase: string;
  handNumber: number;
  rakeCollected: number;
  prizePaid: number;
}

export interface FreerollSummary {
  prizeTier: number;
  players: number;
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
  kind: 'human' | 'bot';
  displayName: string;
  chips: number;
  bet: number;
  status: string;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction?: string;
  isYou: boolean;
  botStyle?: string;
}

export interface TableView {
  tableId: string;
  kind: 'cash' | 'freeroll';
  tierId?: string;
  prizeTier?: number;
  status: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  guaranteedPrize: number;
  maxSeats: number;
  occupied: number;
  humans: number;
  bots: number;
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
