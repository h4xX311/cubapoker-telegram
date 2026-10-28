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
  'tournaments',
  'membership',
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
   * al usarlo. Origen: premios de freeroll, logros y referidos.
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
  /**
   * Acceso automatico a VIP Arena. No es una membresia comprable: se obtiene
   * por participar en la sala. `user.vip` es la membresia QVA-Bet Club y no se usa
   * para decidir esto.
   */
  vipArena?: {
    participating: boolean;
    profitSharePercent: number;
    estimatedUsdt?: number;
    claimableUsdt?: number;
    nextPayoutAt?: string;
  };
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
  unlock: UnlockInfo;
  withdrawals: WithdrawalLimits;
}

export interface TableSummary {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'tournament';
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

/**
 * Fotografia de equidad por calle de un all-in.
 *
 * `players` solo lleva jugadores que llegaron al showdown. Las cartas de quien
 * se retiro no estan aqui y no deben mostrarse.
 */
export type AllInStreetName = 'preflop' | 'flop' | 'turn' | 'river';

export interface AllInRevealPlayer {
  seatIndex: number;
  displayName: string;
  cards: string[];
  /** Porcentaje por calle. El backend lo normaliza a 100. */
  equity: Record<AllInStreetName, number>;
  /** Nombre de la mano que se ve en cada calle. */
  handName: Record<AllInStreetName, string>;
}

export interface AllInReveal {
  startStreet: AllInStreetName;
  board: string[];
  players: AllInRevealPlayer[];
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
  allIn?: AllInReveal;
}

/**
 * Una mano cerrada dentro del historial de la mesa.
 *
 * `myCards` son las cartas del espectador en ESA mano. Las de los rivales solo
 * aparecen en `showdown` o en `winners` si llegaron a enseñarlas. El backend
 * ya recorta el resto antes de enviar la vista.
 */
export interface TableHistoryEntry {
  handNumber: number;
  endedAt: string;
  pot: number;
  potUsdt: number;
  rake: number;
  rakeUsdt: number;
  board: string[];
  unit: 'USDT' | 'PTS';
  endedByFold: boolean;
  myCards: string[];
  winners: LastHandWinner[];
  showdown: LastHandShowdown[];
}

export interface TableView {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'tournament';
  tierId?: string;
  formatId?: string;
  prizeTier?: number;
  status: string;
  /** USDT en cash ring; PTS en torneos y freerolls. */
  mode: 'USDT' | 'PTS';
  /** Ciegas en unidades internas. Para pintar, usar `smallBlindUsdt`. */
  smallBlind: number;
  bigBlind: number;
  smallBlindUsdt: number;
  bigBlindUsdt: number;
  /** Nivel de ciegas en torneos; 0 en cash. */
  blindLevel?: number;
  blindLevelStartedAt?: string;
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
  /** Banco de tiempo que le queda al espectador en la mano actual. */
  myTimeBankMs?: number;
  /** Cuando empezo el turno actual y cuando vence. */
  turnStartedAt?: string | null;
  turnEndsAt?: string | null;
  /** Cuando arranca la proxima mano durante la pausa. */
  nextHandAt?: string | null;
  /** Últimas manos de la mesa, de la más reciente a la más antigua. */
  history?: TableHistoryEntry[];
}

/** Resumen de una mesa abierta, para el selector multi-mesa. */
export interface MyTable {
  tableId: string;
  kind: 'cash' | 'freeroll' | 'tournament';
  tierId?: string;
  formatId?: string;
  label: string;
  field?: {
    fieldId: string;
    tableNumber: number;
    targetField: number;
    registered: number;
  };
  status: string;
  mode: 'USDT' | 'PTS';
  phase: string;
  handNumber: number;
  seatIndex: number;
  chips: number;
  displayChips: number;
  buyInUsdt: number;
  smallBlindUsdt: number;
  bigBlindUsdt: number;
  blindLevel: number;
  pot: number;
  displayPot: number;
  isMyTurn: boolean;
  turnEndsAt: string | null;
  turnStartedAt: string | null;
  nextHandAt: string | null;
  /** Cartas privadas del jugador en esta mesa (solo si hay mano activa). */
  myCards?: { rank: string; suit: string }[];
}

// --- Torneos y Spin & Go ---

export interface TournamentLobbyEntry {
  id: string;
  label: string;
  description: string;
  kind: 'torneo' | 'spingo';
  buyInUsdt: number;
  premioGarantizadoUsdt: number;
  premioActualUsdt: number;
  boteEntradasUsdt: number;
  fieldSize: number;
  startingChips: number;
  blinds: { small: number; big: number };
  lateRegMinutes: number;
  payout: number[];
  scheduled: boolean;
  fieldId: string | null;
  status: string;
  jugadores: number;
  jugadoresVivos: number;
  startsAt: string | null;
  lateRegUntil: string | null;
  inscrito: boolean;
  maxPorMesa: number;
  createdAt?: string | null;
  /** Momento en que el Spin & Go puede completarse automáticamente. */
  spinFillAt?: string | null;
  /** Momento máximo de espera: si no se llena, se reembolsa la entrada. */
  spinRefundAt?: string | null;
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
