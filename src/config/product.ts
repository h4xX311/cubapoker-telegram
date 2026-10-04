/**
 * Configuracion del producto.
 *
 * Concentra las reglas de negocio de las mesas, los freerolls y los bots.
 * Cambiar numeros aqui debe bastar para reajustar el producto sin tocar
 * la logica de juego.
 */

export type TableKind = 'cash' | 'freeroll';
export type TableTierId = 't50' | 't100' | 't300' | 't500';

/**
 * Mesas cash con premio garantizado.
 *
 * El premio se entrega al ganador cuando la mesa se completa. El rake se
 * descuenta del bote como en cualquier mesa; el premio garantizado es
 * adicional y es lo que financia el modelo, de forma similar a CoinPoker.
 */
export interface TableTier {
  id: TableTierId;
  maxPlayers: number;
  guaranteedPrize: number;
  /** Buy-in minimo para poder sentarse */
  minBuyIn: number;
  /** Buy-in por defecto al abrir la mesa */
  defaultBuyIn: number;
  label: string;
  description: string;
}

export const TABLE_TIERS: Record<TableTierId, TableTier> = {
  t50: {
    id: 't50',
    maxPlayers: 50,
    guaranteedPrize: 50,
    minBuyIn: 200,
    defaultBuyIn: 500,
    label: 'Mesa 50',
    description: '50 jugadores · Premio 50 CUP',
  },
  t100: {
    id: 't100',
    maxPlayers: 100,
    guaranteedPrize: 100,
    minBuyIn: 500,
    defaultBuyIn: 1000,
    label: 'Mesa 100',
    description: '100 jugadores · Premio 100 CUP',
  },
  t300: {
    id: 't300',
    maxPlayers: 300,
    guaranteedPrize: 300,
    minBuyIn: 1000,
    defaultBuyIn: 2500,
    label: 'Mesa 300',
    description: '300 jugadores · Premio 300 CUP',
  },
  t500: {
    id: 't500',
    maxPlayers: 500,
    guaranteedPrize: 500,
    minBuyIn: 2000,
    defaultBuyIn: 5000,
    label: 'Mesa 500',
    description: '500 jugadores · Premio 500 CUP',
  },
};

export const TABLE_TIER_LIST: TableTier[] = [
  TABLE_TIERS.t50,
  TABLE_TIERS.t100,
  TABLE_TIERS.t300,
  TABLE_TIERS.t500,
];

/** Escalones de premio del freeroll, en CUP. */
export const FREEROLL_PRIZES = [5, 10, 20, 30, 40, 50] as const;

/** Reparto del freeroll segun posicion final (porcentaje del bote). */
export const FREEROLL_PAYOUT = [50, 30, 20] as const;

/**
 * REGLAS DE SALDO
 * ------------------------------------------------------------------
 * El saldo ganado en freeroll entra a `balance.play`, que NO es retirable.
 * Solo `balance.real` (CUP de verdad) puede retirarse. Esta distincion es la
 * que hace que los freerolls sirvan de gancho sin generar obligaciones de pago.
 */
export const BALANCE = {
  /** En mesas cash se consume primero el saldo play */
  playFirstOnCashTables: true,
  minBuyInCUP: 200,
} as const;

/**
 * Bots que rellenan las mesas.
 *
 * `winRate` esta deliberadamente por debajo de 0.5: un bot que gana mas de lo
 * que pierde empobrece a los jugadores reales, y uno que pierde en exceso se
 * convierte en una giveaway detectable. Se calibra entre 0.42 y 0.48 para que
 * la mesa se sienta viva sin generar dinero ni regalar dinero.
 */
export const BOT_CONFIG = {
  enabled: true,
  winRateMin: 0.42,
  winRateMax: 0.48,
  /** Minutos que un bot tarda en actuar */
  minThinkMs: 900,
  maxThinkMs: 2600,
  /** Tope de bots por mesa */
  maxBotsPerTable: 60,
  /** Proporcion objetivo de bots respecto a humanos (0.6 = 60%) */
  botRatio: 0.6,
  /** Cada cuanto el gestor revisa y rellena las mesas */
  tickMs: 2000,
  /** Nombres para bots (neutros, sin acentos para evitar problemas de encoding) */
  names: [
    'ElPro', 'Marta', 'CubanKing', 'LaEstrena', 'ReyDeOros', 'Nube',
    'Coco', 'Yeni', 'ElGato', 'Solares', 'Trinidad', 'Habana',
    'Vega', 'Punto', 'Cauto', 'Zafiro', 'Bermuda', 'Coral',
    'Cobre', 'Duna', 'Guaro', 'Isla', 'Jabeque', 'Canales',
    'Tropico', 'Cafetal', 'Guarapo', 'Malecon', 'Almendron', 'Cimarron',
  ] as readonly string[],
} as const;

/**
 * Rake por tipo de mesa.
 * El freeroll no aplica rake: es el coste de adquisicion.
 */
export const RAKE = {
  cashPercentage: 5,
  cashMax: 100,
  minPot: 10,
  freerollPercentage: 0,
} as const;

/** Tiempo maximo para actuar antes de que el bot juegue por el usuario. */
export const TURN_TIMER = {
  humanMs: 30_000,
  botMs: 2_000,
  warnBeforeMs: 10_000,
} as const;

export const getTier = (id: string): TableTier | undefined => TABLE_TIERS[id as TableTierId];
