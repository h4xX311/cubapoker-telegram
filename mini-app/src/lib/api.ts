const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const getInitData = (): string => window.Telegram?.WebApp?.initData || '';

async function request<T = any>(endpoint: string, options: { method?: string; body?: any } = {}): Promise<T> {
  const { method = 'GET', body } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const initData = getInitData();
    if (initData) headers['X-Telegram-Init-Data'] = initData;

    const response = await fetch(`/api${endpoint}`, {
      method,
      headers,
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }

    if (!response.ok) {
      throw new ApiError(data?.error || `Error ${response.status}`, response.status, data?.code);
    }
    return data as T;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new ApiError('La conexion tardo demasiado. Intenta de nuevo.', 0, 'TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Tipos de cadenas ---

export interface ChainInfo {
  id: string;
  name: string;
  nativeSymbol: string;
  addressExample: string;
  avgFeeUsd: number;
  confirmationMinutes: number;
  recommended: boolean;
}

export interface DepositOrder {
  orderId: string;
  checkoutUrl: string;
  amount: number;
  currency: 'CUP' | 'USDT';
  chain?: string;
  expiresAt: string;
  simulated: boolean;
  instructions: Record<string, string>;
}

export const api = {
  // Sesion
  me: () => request<any>('/me'),

  // Pagos
  chains: () => request<{ chains: ChainInfo[]; simulate: boolean }>('/payment/chains'),
  createDepositOrder: (amount: number, provider: string, chain?: string) =>
    request<DepositOrder>('/payment/deposit/order', {
      method: 'POST',
      body: { amount, provider, chain },
    }),
  confirmDeposit: (orderId: string, txHash?: string) =>
    request<any>('/payment/deposit/confirm', {
      method: 'POST',
      body: { orderId, txHash },
    }),
  withdraw: (amount: number, provider: string, chain?: string, walletAddress?: string) =>
    request<any>('/payment/withdraw', {
      method: 'POST',
      body: { amount, provider, chain, walletAddress },
    }),
  orders: (type?: 'deposit' | 'withdrawal') =>
    request<any>(`/payment/orders${type ? `?type=${type}` : ''}`),

  // Simulador (solo desarrollo)
  getSimulatedOrder: (orderId: string) => request<any>(`/payment/simulate/${orderId}`),
  confirmSimulated: (orderId: string) =>
    request<any>(`/payment/simulate/${orderId}/confirm`, { method: 'POST', body: {} }),

  // Juego
  createGame: (smallBlind = 1, bigBlind = 2) =>
    request<any>('/game/create', { method: 'POST', body: { smallBlind, bigBlind } }),
  joinGame: (gameId: string) =>
    request<any>('/game/join', { method: 'POST', body: { gameId } }),
  gameState: (gameId: string, telegramId: number) =>
    request<any>(`/game/state/${gameId}/${telegramId}`),
  gameAction: (gameId: string, action: string, amount?: number) =>
    request<any>('/game/action', { method: 'POST', body: { gameId, action, amount } }),
  leaveGame: (gameId: string) => request<any>('/game/leave', { method: 'POST', body: { gameId } }),
  activeGames: () => request<any>('/game/active'),

  // Torneos
  tournaments: () => request<any>('/game/tournaments'),
  registerTournament: (id: string) =>
    request<any>(`/game/tournaments/${id}/register`, { method: 'POST', body: {} }),

  // Monetizacion
  vip: () => request<any>('/monetization/vip'),
  vipConfig: () => request<any>('/monetization/vip/config'),
  purchaseVip: (level: string) =>
    request<any>('/monetization/vip/purchase', { method: 'POST', body: { level } }),
  referrals: () => request<any>('/monetization/referrals'),
  achievements: () => request<any>('/monetization/achievements'),
  streaks: () => request<any>('/monetization/streaks'),
};

export { ApiError as ApiErrorClass };
