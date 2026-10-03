import crypto from 'crypto';
import { randomUUID } from 'crypto';

/**
 * Capa de pasarelas de pago.
 *
 * Cada metodo implementa el mismo contrato, asi el flujo de negocio (crear orden,
 * confirmar, acreditar) no cambia cuando se conecte la API real: basta con
 * implementar la misma interfaz contra EnZona / QvaPay / epusdt.
 *
 * MODO SIMULACION: mientras `SIMULATE_PAYMENTS=true` ninguna pasarela mueve
 * dinero real. Las ordenes quedan marcadas con `simulated: true` y se pueden
 * confirmar desde el panel de pruebas, de forma que el flujo completo
 * (crear -> pagar -> confirmar -> acreditar) es verificable de punta a punta.
 */

export type PaymentProvider = 'enzona' | 'qvapay' | 'usdt';

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';

export interface CreateOrderInput {
  telegramId: number;
  amount: number;
  chain?: string;
  address?: string;
  metadata?: Record<string, any>;
}

export interface PaymentOrder {
  id: string;
  provider: PaymentProvider;
  telegramId: number;
  amount: number;
  currency: 'CUP' | 'USDT';
  chain?: string;
  status: OrderStatus;
  /** URL a donde se envia al usuario para completar el pago */
  checkoutUrl: string;
  /** Datos a mostrar en la pantalla de pago */
  instructions: Record<string, string>;
  expiresAt: Date;
  createdAt: Date;
  simulated: boolean;
}

export interface GatewayResult {
  order: PaymentOrder;
}

/** Interfaz que toda pasarela real debera cumplir. */
export interface PaymentGateway {
  readonly provider: PaymentProvider;
  createOrder(input: CreateOrderInput): Promise<PaymentOrder>;
  verify(orderId: string): Promise<OrderStatus>;
  cancel(orderId: string): Promise<void>;
}

export const SIMULATION_ENABLED = process.env.SIMULATE_PAYMENTS !== 'false';
export const SIMULATION_SECRET = process.env.SIMULATION_SECRET || 'cubapoker-dev';

const ORDER_TTL_MINUTES = 30;

/**
 * Almacen en memoria para las ordenes simuladas.
 * En produccion con pasarelas reales, la fuente de verdad es la propia pasarela
 * y este mapa no se usa.
 */
const simulatedOrders = new Map<string, PaymentOrder>();

const buildCheckoutUrl = (orderId: string): string => {
  const base = (process.env.MINI_APP_URL || '').replace(/\/+$/, '');
  return `${base}/simulate/${orderId}`;
};

const createBaseOrder = (
  provider: PaymentProvider,
  input: CreateOrderInput,
  currency: 'CUP' | 'USDT',
  instructions: Record<string, string>,
): PaymentOrder => {
  const now = new Date();
  const id = randomUUID();

  return {
    id,
    provider,
    telegramId: input.telegramId,
    amount: input.amount,
    currency,
    chain: input.chain,
    status: 'pending',
    checkoutUrl: buildCheckoutUrl(id),
    instructions,
    expiresAt: new Date(now.getTime() + ORDER_TTL_MINUTES * 60 * 1000),
    createdAt: now,
    simulated: true,
  };
};

/** Genera un hash de transaccion con el formato de cada explorer. */
export const fakeTxHash = (chain: string): string => {
  switch (chain) {
    case 'SOL':
      return crypto.randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 88);
    case 'TRC20':
      return crypto.randomBytes(32).toString('hex');
    default:
      return '0x' + crypto.randomBytes(32).toString('hex');
  }
};

export class SimulatedGateway implements PaymentGateway {
  constructor(public readonly provider: PaymentProvider) {}

  async createOrder(input: CreateOrderInput): Promise<PaymentOrder> {
    if (this.provider === 'usdt') return this.createUsdtOrder(input);
    return this.createFiatOrder(input);
  }

  /** EnZona y QvaPay: monto en CUP, se paga desde el movil. */
  private async createFiatOrder(input: CreateOrderInput): Promise<PaymentOrder> {
    const order = createBaseOrder(this.provider, input, 'CUP', {
      metodo: this.provider === 'enzona' ? 'EnZona (transferencia movil)' : 'QvaPay (tarjeta)',
      monto: `${input.amount} CUP`,
      referencia: `CP${Date.now().toString().slice(-8)}`,
      instruccion: 'Confirma el pago para acreditar tu saldo.',
    });

    simulatedOrders.set(order.id, order);
    return order;
  }

  /** USDT: el usuario envia a una direccion de deposito por cadena. */
  private async createUsdtOrder(input: CreateOrderInput): Promise<PaymentOrder> {
    const { DEPOSIT_ADDRESSES } = await import('../../config/chains');
    const chain = input.chain || 'TRC20';
    const address = DEPOSIT_ADDRESSES[chain as keyof typeof DEPOSIT_ADDRESSES];

    const order = createBaseOrder(this.provider, input, 'USDT', {
      cadena: chain,
      direccion: address,
      monto_exacto: `${input.amount} USDT`,
      referencia_memo: 'No requerido',
      instruction: `Envia exactamente ${input.amount} USDT a la direccion indicada.`,
    });
    order.chain = chain;

    simulatedOrders.set(order.id, order);
    return order;
  }

  async verify(orderId: string): Promise<OrderStatus> {
    const order = simulatedOrders.get(orderId);
    return order?.status ?? 'expired';
  }

  async cancel(orderId: string): Promise<void> {
    const order = simulatedOrders.get(orderId);
    if (order && order.status === 'pending') {
      order.status = 'expired';
    }
  }
}

/**
 * Endpoint de la pasarela simulada: marca la orden como pagada.
 * En un entorno real esto lo haria el webhook firmado del proveedor.
 */
export const confirmSimulatedOrder = (
  orderId: string,
  secret: string,
): { ok: boolean; order?: PaymentOrder; error?: string } => {
  if (secret !== SIMULATION_SECRET) {
    return { ok: false, error: 'Clave de simulacion invalida' };
  }

  const order = simulatedOrders.get(orderId);
  if (!order) {
    return { ok: false, error: 'Orden no encontrada' };
  }
  if (order.status === 'paid') {
    return { ok: false, error: 'La orden ya fue confirmada' };
  }
  if (new Date() > order.expiresAt) {
    order.status = 'expired';
    return { ok: false, error: 'La orden expiro' };
  }

  order.status = 'paid';
  return { ok: true, order };
};

export const getSimulatedOrder = (orderId: string): PaymentOrder | undefined =>
  simulatedOrders.get(orderId);

/** Limpia ordenes expiradas. Se invoca periodicamente. */
export const pruneSimulatedOrders = (): number => {
  const now = new Date();
  let removed = 0;
  for (const [id, order] of simulatedOrders.entries()) {
    if (now > order.expiresAt && order.status === 'pending') {
      simulatedOrders.delete(id);
      removed++;
    }
  }
  return removed;
};

export const gateways: Record<PaymentProvider, SimulatedGateway> = {
  enzona: new SimulatedGateway('enzona'),
  qvapay: new SimulatedGateway('qvapay'),
  usdt: new SimulatedGateway('usdt'),
};
