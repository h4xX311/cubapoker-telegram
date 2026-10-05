import { User } from '../../models/User';
import { Transaction } from '../../models/Transaction';
import { PaymentOrder } from '../../models/PaymentOrder';
import {
  gateways,
  SIMULATION_ENABLED,
  fakeTxHash,
  type PaymentProvider,
} from './gateway';
import { formatUnits } from '../../config/units';
import { checkWithdrawal } from './withdrawal.rules';
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
      { $inc: { 'balance.real': credited } },
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

    // REGLA CRITICA: el saldo de promocion (`play`) NO es retirable.
    // Un retiro solo puede consumir `balance.real`. Si se permitiera usar `play`,
    // el usuario vaciaria la plataforma sin haber depositado nunca.
    if (user.balance.real < amount) {
      throw new MoneyError(
        `Solo puedes retirar saldo real. Tienes ${user.balance.real} CUP retirables ` +
        `(tu saldo de promocion de ${user.balance.play} CUP no es retirable).`,
      );
    }

    // Un usuario no debe tener retiros pendientes que superen su saldo.
    //
    // Y lo ya retirado este mes, para el tope mensual de ganancias. Se cuenta
    // desde el dia 1 en hora local del servidor; con un mes de 30 dias y el tope
    // en 25 000 USDT, el error de un dia es irrelevante.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [pending, paidThisMonthAgg] = await Promise.all([
      PaymentOrder.aggregate([
        {
          $match: {
            telegramId,
            type: 'withdrawal',
            status: 'pending',
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      PaymentOrder.aggregate([
        {
          $match: {
            telegramId,
            type: 'withdrawal',
            status: 'paid',
            createdAt: { $gte: monthStart },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const pendingTotal = pending[0]?.total ?? 0;
    const paidThisMonth = paidThisMonthAgg[0]?.total ?? 0;

    // Las reglas (minimos, topes, saldo libre, saldo no retirable) viven en
    // `withdrawal.rules.ts`, sin base de datos y con tests propios. Aqui solo se
    // le pasa lo que hay leido de Mongo.
    //
    // El saldo de lo ya retirado este mes se calcula con el aggregate de abajo:
    // es lo que hace que el tope mensual no sea solo decorativo.
    //
    // Los limites por via (minimo USDT vs minimo CUP) ya se comprueban arriba con
    // mensajes propios, asi que se llama con `skipMinimum: true` para no
    // duplicar esa comprobacion.
    const check = checkWithdrawal(
      amount,
      user.balance,
      pendingTotal,
      provider === 'usdt' ? 'usdt' : 'cup',
      paidThisMonth,
      { skipMinimum: true },
    );

    if (!check.ok) {
      throw new MoneyError(check.message!, 400);
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
   *
   * ------------------------------------------------------------------
   * EL SALDO SE CONSUME AQUI, NO AL SOLICITAR
   *
   * Eso hace que cancelar un retiro no tenga que devolver nada: el dinero nunca
   * salio de la cuenta. Y hace que este sea el punto critico de todo el flujo de
   * retiros, porque es aqui donde se pierde el dinero.
   *
   * ------------------------------------------------------------------
   * EL BUG QUE IMPIDE UN `$INC` A SECO
   *
   * Al solicitar se comprueba que `real - pendientes >= importe`. Pero entre la
   * solicitud y la aprobacion el usuario puede jugar, y `splitBuyIn` consume
   * `play` primero y luego `real`. Asi que puede vaciar su saldo retirable
   * mientras el retiro sigue pendiente.
   *
   * Con un `$inc` sin filtro, la secuencia seria:
   *
   *   1. Usuario deposita 100 USDT, solicita retirarlos. real = 100, pendiente 100.
   *   2. Se sienta a una mesa de 100 USDT. splitBuyIn le vacia `real`. real = 0.
   *   3. El operador paga los 100 USDT a la wallet y aprueba.
   *   4. `$inc: -100` deja real = -100.
   *
   * El usuario tiene 100 USDT en fichas Y 100 USDT cobrados. Un ciclo de eso por
   * retiro es un dreno ilimitado, y el saldo negativo tampoco lo frena: `min: 0`
   * del esquema no se comprueba en un `findOneAndUpdate` salvo que se pida
   * `runValidators`, y aqui no se pide.
   *
   * La comprobacion va EN EL FILTRO, no antes. Si va antes, dos aprobaciones
   * simultaneas pueden pasar ambas el `if` y las dos restar: el saldo vuelve a
   * quedar mal. En el filtro, Mongo lo evalua y lo aplica sobre el documento en
   * una sola operacion, asi que solo una de las dos resta.
   */
  async settleWithdrawal(orderId: string, txHash?: string): Promise<void> {
    const order = await PaymentOrder.findOne({ orderId });
    if (!order) {
      throw new MoneyError('Orden no encontrada.', 404);
    }
    if (order.status === 'paid') {
      throw new MoneyError('El retiro ya fue liquidado.');
    }
    if (order.status !== 'pending') {
      throw new MoneyError(
        `Solo se pueden liquidar retiros pendientes (este está en "${order.status}").`,
      );
    }

    // El filtro es la proteccion: `balance.real >= importe`. Ademas evita el
    // doble cobro, porque el estado de la orden tambien se exige `pending` y solo
    // una de las dos aprobaciones concurrentes lo cumple.
    const debited = await User.findOneAndUpdate(
      {
        telegramId: order.telegramId,
        'balance.real': { $gte: order.amount },
      },
      { $inc: { 'balance.real': -order.amount } },
      { new: false },
    );

    if (!debited) {
      const user = await User.findOne({ telegramId: order.telegramId });
      const available = user?.balance.real ?? 0;

      throw new MoneyError(
        'El retiro no se puede liquidar: el usuario ya no tiene saldo retirable ' +
        `suficiente (necesita ${formatUnits(order.amount)} USDT, ` +
        `tiene ${formatUnits(available)}). ` +
        'Si el pago ya salio de la plataforma, esto es un incidente: anotalo y ' +
        'liquida el saldo a mano. Si no se ha pagado todavia, cancela el retiro, ' +
        'que devuelve el dinero al usuario.',
        409,
      );
    }

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
