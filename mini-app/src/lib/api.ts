/**
 * Cliente API del Mini App.
 *
 * Centraliza dos responsabilidades criticas:
 *  1. Enviar el `initData` de Telegram para que el servidor valide la identidad.
 *  2. Dar un unico lugar donde manejar errores y timeouts.
 *
 * El `telegramId` NUNCA se envia: el servidor lo deduce de la firma.
 */

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

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
}

async function request<T = any>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const initData = getInitData();
    if (initData) {
      headers['X-Telegram-Init-Data'] = initData;
    }

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
      throw new ApiError(
        data?.error || `Error ${response.status}`,
        response.status,
        data?.code,
      );
    }

    return data as T;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new ApiError('La conexión tardó demasiado. Intenta de nuevo.', 0, 'TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  // Sesión / perfil
  me: () => request<any>('/me'),

  // Dinero
  deposit: (amount: number, method: string, externalId?: string) =>
    request<any>('/deposit', { method: 'POST', body: { amount, method, externalId } }),

  withdraw: (amount: number, method: string, address?: string) =>
    request<any>('/withdraw', { method: 'POST', body: { amount, method, address } }),

  transactions: () => request<any>('/transactions'),

  // Juego
  createGame: (smallBlind = 1, bigBlind = 2) =>
    request<any>('/game/create', { method: 'POST', body: { smallBlind, bigBlind } }),

  joinGame: (gameId: string) =>
    request<any>('/game/join', { method: 'POST', body: { gameId } }),

  gameState: (gameId: string, telegramId: number) =>
    request<any>(`/game/state/${gameId}/${telegramId}`),

  gameAction: (gameId: string, action: string, amount?: number) =>
    request<any>('/game/action', { method: 'POST', body: { gameId, action, amount } }),

  leaveGame: (gameId: string) =>
    request<any>('/game/leave', { method: 'POST', body: { gameId } }),

  activeGames: () => request<any>('/game/active'),

  // Torneos
  tournaments: () => request<any>('/game/tournaments'),

  registerTournament: (id: string) =>
    request<any>(`/game/tournaments/${id}/register`, { method: 'POST', body: {} }),

  // Monetización
  vip: () => request<any>('/monetization/vip'),
  vipConfig: () => request<any>('/monetization/vip/config'),
  purchaseVip: (level: string) =>
    request<any>('/monetization/vip/purchase', { method: 'POST', body: { level } }),

  referrals: () => request<any>('/monetization/referrals'),
  achievements: () => request<any>('/monetization/achievements'),
  streaks: () => request<any>('/monetization/streaks'),
};
