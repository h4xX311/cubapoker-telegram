/**
 * Redes soportadas para depositos/retiros en USDT.
 *
 * Cada cadena declara su red, el contrato de USDT, la Exploradora y el formato
 * de direccion, porque no es uniforme: EVM usa hex de 40 caracteres mientras
 * que Solana usa Base58 de 32-44 caracteres. Validar con una sola expresion
 * regular rechazaria direcciones legitimas o aceptaria invalidas.
 */

export type ChainId =
  | 'TRC20'
  | 'ERC20'
  | 'BEP20'
  | 'POL'
  | 'SOL';

export type ChainKind = 'evm' | 'solana';

export interface Chain {
  id: ChainId;
  kind: ChainKind;
  name: string;
  nativeSymbol: string;
  /** Contrato del token USDT (para EVM) o token mint (Solana) */
  tokenAddress: string;
  decimals: number;
  explorer: string;
  /** Expresion de validacion de direccion */
  addressPattern: RegExp;
  addressExample: string;
  /** Coste aproximado de confirmacion en USD */
  avgFeeUsd: number;
  /** Tiempo medio hasta considered "confirmado" en minutos */
  confirmationMinutes: number;
  recommended?: boolean;
  /** QR de deposito sigue el formato de la cadena */
  supportsMemo?: boolean;
}

export const CHAINS: Record<ChainId, Chain> = {
  TRC20: {
    id: 'TRC20',
    kind: 'evm',
    name: 'Tron',
    nativeSymbol: 'TRX',
    tokenAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    explorer: 'https://tronscan.org/#/transaction/',
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    addressExample: 'TXYZ... (34 caracteres, empieza por T)',
    avgFeeUsd: 0.5,
    confirmationMinutes: 1,
    recommended: true,
  },
  ERC20: {
    id: 'ERC20',
    kind: 'evm',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    explorer: 'https://etherscan.io/tx/',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    addressExample: '0xABC... (42 caracteres)',
    avgFeeUsd: 4.5,
    confirmationMinutes: 12,
  },
  BEP20: {
    id: 'BEP20',
    kind: 'evm',
    name: 'BNB Smart Chain',
    nativeSymbol: 'BNB',
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    explorer: 'https://bscscan.com/tx/',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    addressExample: '0xABC... (42 caracteres)',
    avgFeeUsd: 0.05,
    confirmationMinutes: 3,
  },
  POL: {
    id: 'POL',
    kind: 'evm',
    name: 'Polygon',
    nativeSymbol: 'POL',
    tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    decimals: 6,
    explorer: 'https://polygonscan.com/tx/',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    addressExample: '0xABC... (42 caracteres)',
    avgFeeUsd: 0.01,
    confirmationMinutes: 2,
  },
  SOL: {
    id: 'SOL',
    kind: 'solana',
    name: 'Solana',
    nativeSymbol: 'SOL',
    // USDT SPL mint
    tokenAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    explorer: 'https://solscan.io/tx/',
    // Base58: 32-44 caracteres, sin 0, O, I, l.
    // Ademas se rechaza el prefijo 'T': una direccion de Tron (T + 33 = 34
    // chars) es Base58 valido, asi que sin esta guarda un usuario podria
    // enviar USDT por TRC20 creyendo que va a Solana y perderlo.
    addressPattern: /^(?!T[1-9A-HJ-NP-Za-km-z]{33}$)[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    addressExample: 'Base58 de 32-44 caracteres (no empieza por T)',
    avgFeeUsd: 0.001,
    confirmationMinutes: 1,
  },
};

/** Lista ordenada: las recomendadas primero. */
export const CHAIN_LIST: Chain[] = [
  CHAINS.TRC20,
  CHAINS.SOL,
  CHAINS.POL,
  CHAINS.BEP20,
  CHAINS.ERC20,
];

export const isValidChain = (value: unknown): value is ChainId =>
  typeof value === 'string' && value in CHAINS;

export const validateAddress = (chainId: ChainId, address: string): boolean => {
  const chain = CHAINS[chainId];
  if (!chain || !address) return false;
  return chain.addressPattern.test(address.trim());
};

/**
 * Direcciones de deposito simuladas por cadena.
 * En modo produccion deben ser wallets reales de la plataforma; aqui se generan
 * de forma determinista para poder probar el flujo completo sin fondos.
 */
export const DEPOSIT_ADDRESSES: Record<ChainId, string> = {
  TRC20: 'TSIMULATEDTRONdepositADDRESS000001',
  ERC20: '0x51E0000000000000000000000000000000000000',
  BEP20: '0x51E0000000000000000000000000000000000000',
  POL: '0x51E0000000000000000000000000000000000000',
  SOL: 'SimulatedSolanaDepositAddress1111111111',
};

/** Convierte USDT a unidades atomicas segun los decimales de la cadena. */
export const toAtomic = (amount: number, chainId: ChainId): bigint => {
  const decimals = CHAINS[chainId].decimals;
  const factor = 10n ** BigInt(decimals);
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * factor + BigInt(padded || '0');
};

/** Convierte unidades atomicas a un numero decimal legible. */
export const fromAtomic = (atomic: bigint, chainId: ChainId): number => {
  const decimals = CHAINS[chainId].decimals;
  const factor = 10n ** BigInt(decimals);
  const whole = atomic / factor;
  const frac = (atomic % factor).toString().padStart(decimals, '0');
  return Number(`${whole}.${frac}`);
};
