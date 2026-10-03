import { User } from '../../models/User';
import { Transaction } from '../../models/Transaction';
import { PaymentOrder } from '../../models/PaymentOrder';
import {
  gateways,
  SIMULATION_ENABLED,
  fakeTxHash,
  type PaymentProvider,
} from './gateway';
import { calculateCommission } from '../../config/monetization';
import { validateAddress, CHAINS, isValidChain, type ChainId } from '../../config/chains';

export class MoneyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class PaymentService {
  /**
   * Crea una orden de deposito.
   *
   * A diferencia de la version anterior, NO acreditar saldo aqui: se genera la
   * orden y el saldo se suma unicamente cuando la orden llega a `paid`. Asi el
   * credito siempre es trazable a una orden concreta.
   */
  async createDepositOrder(input: {
    telegramId: number;
    amount: number;
    provider: PaymentProvider;
    chain?: string;
  }) {
    const { telegramId, amount, provider, chain } = input;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MoneyError('El monto debe ser mayor que cero.');
    }

    if (provider === 'usdt') {
      if (!isValidChain(chain)) {
        throw new MoneyError('Red no soportada.');
      }
      const chainId = chain as ChainId;
      const chainInfo = CHAINS[chainId];

      if (amount < 1) {
        throw new MoneyError(`El minimo en ${chainInfo.name} es 1 USDT.`);
      }
      if (amount > 100000) {
        throw new MoneyError('Para montos mayores a 100.000 USDT contacta soporte.');
      }
    } else if (amount < 500) {
      throw new MoneyError('El minimo por este metodo es 500 CUP.');
    }

    const gateway = gateways[provider];
    const order = await gateway.createOrder({ telegramId, amount, chain });

    // Persistimos la orden: es el registro auditable del movimiento
    const saved = await PaymentOrder.create({
      orderId: order.id,
      provider,
      telegramId,
      type: 'deposit',
      amount,
      currency: provider === 'usdt' ? 'USDT' : 'CUP',
      chain: order.chain,
      status: 'pending',
      simulated: SIMULATION_ENABLED,
      instructions: order.instructions,
      expiresAt: order.expiresAt,
    });

    return {
      orderId: saved.orderId,
      checkoutUrl: order.checkoutUrl,
      amount,
      currency: provider === 'usdt' ? 'USDT' : 'CUP',
      chain: order.chain,
      expiresAt: order.expiresAt,
      simulated: SIMULATION_ENABLED,
      instructions: order.instructions,
    };
  }

  /**
   * Confirma una orden pagada y acredita el saldo.
   * Idempotente: si ya estaba acreditada no se vuelve a sumar.
   */
  async creditDepositOrder(orderId: string, txHash?: string): Promise<{
    credited: number;
    commission: number;
    alreadyCredited: boolean;
  }> {
    const order = await PaymentOrder.findOne({ orderId });

    if (!order) {
      throw new MoneyError('Orden no encontrada.', 404);
    }
    if (order.status === 'paid') {
      return {
        credited: order.creditedAmount ?? 0,
        commission: order.commission ?? 0,
        alreadyCredited: true,
      };
    }
    if (new Date() > order.expiresAt) {
      order.status = 'expired';
      await order.save();
      throw new MoneyError('La orden expiro. Genera una nueva.');
    }

    const commission = calculateCommission(
      order.amount,
      'deposit',
      order.provider,
    );
    const credited = order.amount - commission;

    await User.findOneAndUpdate(
      { telegramId: order.telegramId },
      { $inc: { 'balance.credits': credited } },
    );

    order.status = 'paid';
    order.creditedAmount = credited;
    order.commission = commission;
    order.txHash = txHash ?? fakeTxHash(order.chain || 'TRC20');
    await order.save();

    await Transaction.create({
      telegramId: order.telegramId,
      type: 'deposit',
      paymentMethod: order.provider,
      amount: credited,
      currency: order.currency,
      status: 'completed',
      commission,
      commissionRate: commission / order.amount,
      externalId: order.orderId,
      metadata: { simulated: order.simulated, chain: order.chain, txHash: order.txHash },
    });

    return { credited, commission, alreadyCredited: false };
  }

  /**
   * Crea una solicitud de retiro.
   *
   * Los retiros NO se acreditan automaticamente: se descontan del saldo y quedan
   * en estado `pending` hasta que un operador los aprueba tras verificar el pago
   * manual (EnZona/QvaPay) o la firma en blockchain (USDT).
   */
  async createWithdrawalRequest(input: {
    telegramId: number;
    amount: number;
    provider: PaymentProvider;
    chain?: string;
    walletAddress?: string;
  }) {
    const { telegramId, amount, provider, chain, walletAddress } = input;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MoneyError('El monto debe ser mayor que cero.');
    }

    const user = await User.findOne({ telegramId });
    if (!user) {
      throw new MoneyError('Usuario no encontrado.', 404);
    }

    if (provider === 'usdt') {
      if (!isValidChain(chain)) {
        throw new MoneyError('Red no soportada.');
      }
      const chainId = chain as ChainId;
      if (!validateAddress(chainId, walletAddress || '')) {
        throw new MoneyError(
          `Direccion invalida para ${CHAINS[chainId].name}. ${CHAINS[chainId].addressExample}`,
        );
      }
      if (amount < 10) {
        throw new MoneyError('El minimo de retiro es 10 USDT.');
      }
    } else if (amount < 1000) {
      throw new MoneyError('El minimo de retiro por este metodo es 1000 CUP.');
    }

    if (user.balance.credits < amount) {
      throw new MoneyError('Saldo insuficiente.');
    }

    // Un usuario no debe tener retiros pendientes que superen su saldo.
    const pending = await PaymentOrder.aggregate([
      {
        $match: {
          telegramId,
          type: 'withdrawal',
          status: 'pending',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const pendingTotal = pending[0]?.total ?? 0;

    if (user.balance.credits - pendingTotal < amount) {
      throw new MoneyError(
        'Saldo insuficiente considerando retiros pendientes en proceso.',
      );
    }

    const commission = calculateCommission(amount, 'withdrawal', provider);
    const net = amount - commission;

    const gateway = gateways[provider];
    const order = await gateway.createOrder({
      telegramId,
      amount,
      chain,
      address: walletAddress,
    });

    const saved = await PaymentOrder.create({
      orderId: order.id,
      provider,
      telegramId,
      type: 'withdrawal',
      amount,
      currency: provider === 'usdt' ? 'USDT' : 'CUP',
      chain: order.chain,
      status: 'pending',
      simulated: SIMULATION_ENABLED,
      walletAddress,
      commission,
      instructions: order.instructions,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await Transaction.create({
      telegramId,
      type: 'withdrawal',
      paymentMethod: provider,
      amount: net,
      currency: provider === 'usdt' ? 'USDT' : 'CUP',
      status: 'pending',
      commission,
      externalId: saved.orderId,
      metadata: { walletAddress, chain: order.chain, simulated: order.simulated },
    });

    return {
      orderId: saved.orderId,
      amount,
      net,
      commission,
      chain: order.chain,
      status: 'pending' as const,
      simulated: SIMULATION_ENABLED,
    };
  }

  /**
   * Aprueba un retiro ya pagado fuera de la plataforma.
   * Consume el saldo y marca la orden como pagada.
   */
  async settleWithdrawal(orderId: string, txHash?: string): Promise<void> {
    const order = await PaymentOrder.findOne({ orderId });
    if (!order) {
      throw new MoneyError('Orden no encontrada.', 404);
    }
    if (order.status === 'paid') {
      throw new MoneyError('El retiro ya fue liquidado.');
    }

    // El saldo se consume al aprobar el pago, no al solicitarlo
    await User.findOneAndUpdate(
      { telegramId: order.telegramId },
      { $inc: { 'balance.credits': -order.amount } },
    );

    order.status = 'paid';
    order.txHash = txHash ?? fakeTxHash(order.chain || 'TRC20');
    await order.save();

    await Transaction.updateMany(
      { externalId: orderId, status: 'pending' },
      { $set: { status: 'completed', metadata: { txHash: order.txHash } } },
    );
  }

  /** Cancela un retiro y devuelve el saldo al usuario. */
  async cancelWithdrawal(orderId: string, reason: string): Promise<void> {
    const order = await PaymentOrder.findOne({ orderId });
    if (!order) {
      throw new MoneyError('Orden no encontrada.', 404);
    }
    if (order.status !== 'pending') {
      throw new MoneyError('Solo se pueden cancelar retiros pendientes.');
    }

    order.status = 'cancelled';
    await order.save();

    await Transaction.updateMany(
      { externalId: orderId, status: 'pending' },
      { $set: { status: 'cancelled', metadata: { reason } } },
    );
  }

  async getOrders(telegramId: number, type?: 'deposit' | 'withdrawal') {
    const filter: any = { telegramId };
    if (type) filter.type = type;
    return PaymentOrder.find(filter).sort({ createdAt: -1 }).limit(50);
  }

  async getOrder(orderId: string) {
    return PaymentOrder.findOne({ orderId });
  }
}

export const paymentService = new PaymentService();
