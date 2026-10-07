import { User } from '../../models/User';
import { Transaction } from '../../models/Transaction';
import { PaymentOrder } from '../../models/PaymentOrder';
import {
  gateways,
  SIMULATION_ENABLED,
  fakeTxHash,
  type PaymentProvider,
} from './gateway';
import { formatUnits, unitsToUsdt, usdtToUnits, UNITS_PER_USDT } from '../../config/units';
import { logger } from '../../utils/logger';
import { checkWithdrawal } from './withdrawal.rules';
import { calculateCommission } from '../../config/monetization';
import { validateAddress, CHAINS, isValidChain, type ChainId } from '../../config/chains';

/**
 * Permite liquidar retiros mientras el sistema esta en modo simulacion.
 *
 * En OFF (lo normal), `settleWithdrawal` RECHAZA liquidar un retiro: marcar una orden
 * simulada como pagada hace que el operador entienda que el sistema ha procesado un
 * pago que no ha procesado nadie, y pague USDT real a cambio de nada.
 *
 * Ponerlo a ON es una decision deliberada y por peticion, no un efecto secundario de
 * arrancar el sistema. Aun asi, por si sola no basta: tambien hay que mandar
 * `confirmarSimulado: true` en la peticion.
 */
const ALLOW_SIMULATED_WITHDRAWALS =
  process.env.ALLOW_SIMULATED_WITHDRAWALS === 'true';

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

    // ------------------------------------------------------------------
    // LA CONVERSION, UNA SOLA VEZ Y EN UN SOLO SITIO
    //
    // `order.amount` es lo que el jugador pidio, en USDT (5 significa 5 USDT, porque es lo
    // que vino del cuerpo de la peticion y lo que el panel de retiros muestra).
    //
    // `balance.real` esta en UNIDADES INTERNAS, donde 1 USDT = 1000. Antes el_importe en
    // USDT se sumaba tal cual a un saldo en unidades: un deposito de 5 USDT anadia 5
    // unidades, o sea 0,005 USDT. Mil veces menos de lo debido.
    //
    // Y la comision se calculaba sobre el importe en USDT con topes en unidades, lo que la
    // llegaba a superar al propio deposito y dejaba el saldo en negativo (medido: -5).
    //
    // Aqui se convierte UNA vez, y todo lo de abajo (comision, acreditado, `$inc`, libro de
    // movimientos) trabaja en la misma unidad. Convertir en la frontera y no en cada
    // operacion es lo que evita que vuelvan a mezclarse: no hay dos sitios donde decidir.
    // ------------------------------------------------------------------
    const orderUnits = usdtToUnits(order.amount);

    if (orderUnits <= 0) {
      throw new MoneyError('El importe del deposito no es valido.');
    }

    const commission = calculateCommission(orderUnits, 'deposit', order.provider);

    // Nunca mas que el deposito: si la comision igualara o superara el importe, el
    // acreditado seria <= 0 y el jugador perderia dinero por depositar. Con los topes en
    // unidades ya no ocurre, pero la garantia se escribe: el dinero del jugador no puede
    // bajar por depositar.
    const credited = orderUnits - commission;

    if (credited <= 0) {
      throw new MoneyError(
        'El deposito es demasiado pequeno: la comision se comería todo. Minimo ' +
          `${formatUnits(orderUnits)} USDT.`,
      );
    }

    await User.findOneAndUpdate(
      { telegramId: order.telegramId },
      { $inc: { 'balance.real': credited } },
    );

    order.status = 'paid';
    // `creditedAmount` y `commission` van en UNIDADES, no en USDT como `amount`. Es el
    // unico campo de la orden que no comparte unidad con `amount`, y por eso queda dicho
    // aqui: leerlo como USDT es el error que se acaba de corregir, en otra forma.
    order.creditedAmount = credited;
    order.commission = commission;
    order.txHash = txHash ?? fakeTxHash(order.chain || 'TRC20');
    await order.save();

    await Transaction.create({
      telegramId: order.telegramId,
      type: 'deposit',
      paymentMethod: order.provider,
      // En unidades, como el saldo al que se suma. El libro de movimientos tiene que
      // sumar con la misma aritmetica que el saldo.
      amount: credited,
      currency: order.currency,
      status: 'completed',
      commission,
      commissionRate: orderUnits > 0 ? commission / orderUnits : 0,
      externalId: order.orderId,
      metadata: {
        simulated: order.simulated,
        chain: order.chain,
        txHash: order.txHash,
        // Lo pedido por el jugador, en USDT, junto alcredited en unidades. Los dos, para
        // que el panel pueda mostrar ambos sin tener que adivinar la escala.
        requestedUsdt: order.amount,
        creditedUnits: credited,
      },
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

    // ------------------------------------------------------------------
    // LA MISMA CONVERSION, Y AQUI EL ERROR ERA MUCHO PEOR
    //
    // `amount` es lo que el jugador pidio, en USDT. El saldo esta en unidades internas.
    // Antes se comparaban sin convertir:
    //
    //     if (user.balance.real < amount)   // 5000 unidades contra 100 USDT
    //
    // Con 5 USDT (5000 unidades) se podia pedir 100 USDT, porque `5000 < 100` es falso: la
    // comprobacion pasaba. Y luego se descontaban 100 unidades, dejando 4900 (= 4,9 USDT)
    // tras haber pedido 100 USDT. O sea, **se podia retirar mil veces el saldo propio** y
    // vaciar la plataforma.
    //
    // Y el mismo `amount` se comparaba contra dos escalas en el mismo bloque:
    //
    //     if (amount < 10)         'El minimo de retiro es 10 USDT'
    //     else if (amount < 1000)  'El minimo por este metodo es 1000 CUP'
    //
    // Un numero, dos unidades, dos mensajes. El minimo de CUP salia 1000 veces mas alto que
    // el de USDT, porque 1000 CUP no son 1000 USDT.
    //
    // Los minimos por via NO se comprueban aqui a proposito: los comprueba
    // `checkWithdrawal`, que ya los tiene en unidades (`LIMITS.minUsdt`,
    // `LIMITS.minCupUnits`) y que es la unica funcion del proyecto con contrato de unidades
    // escrito. Este codigo los duplicaba, en otra escala, con otros mensajes.
    // ------------------------------------------------------------------
    const amountUnits = usdtToUnits(amount);

    if (amountUnits <= 0) {
      throw new MoneyError('El monto debe ser mayor que cero.');
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
    }

    // REGLA CRITICA: el saldo de promocion (`play`) NO es retirable.
    // Un retiro solo puede consumir `balance.real`. Si se permitiera usar `play`,
    // el usuario vaciaria la plataforma sin haber depositado nunca.
    //
    // Los dos lados en la MISMA unidad. Y se comprueba antes de nada, para que un retiro
    // imposible no llegue ni a tocar el saldo.
    if (user.balance.real < amountUnits) {
      throw new MoneyError(
        `Solo puedes retirar saldo real. Tienes ${formatUnits(user.balance.real)} USDT ` +
        `retirables (tu saldo de promocion de ${formatUnits(user.balance.play)} USDT no ` +
        'es retirable).',
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

    // ------------------------------------------------------------------
    // ESTOS DOS AGREGADOS TAMBIEN NECESITAN LA CONVERSION
    //
    // `order.amount` esta en USDT (es lo que el jugador pidio, y lo que ve el panel). Se
    // suman y se comparan contra `user.balance` y contra los topes, que estan en unidades.
    //
    // Antes se comparaban sin convertir, que es el mismo error del exploit: los topes de
    // transaccion y el tope mensual (que estan en unidades y son de 10.000 y 25.000.000)
    // se comparaban contra sumas en USDT, o sea mil veces mas pequenas de lo que el
    // jugador realmente tiene. El tope mensual no limitaba nada.
    //
    // Se convierte en la propia consulta con `$floor`, que es lo mismo que hace
    // `usdtToUnits`: truncar, no redondear. Redondear aqui y truncar alla haria que las
    // cifras no cuadraran ni entre si.
    // ------------------------------------------------------------------
    const EN_UNIDADES = [
      { $group: { _id: null, total: { $sum: { $floor: { $multiply: ['$amount', UNITS_PER_USDT] } } } } },
    ];

    const [pending, paidThisMonthAgg] = await Promise.all([
      PaymentOrder.aggregate([
        {
          $match: {
            telegramId,
            type: 'withdrawal',
            status: 'pending',
          },
        },
        ...EN_UNIDADES,
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
        ...EN_UNIDADES,
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
    // Los limites por via (minimo USDT vs minimo CUP) los comprueba esta misma funcion, que
    // los tiene en unidades y con los mensajes correctos. Antes se comprobaban aqui otra
    // vez, en USDT, y con un minimo de CUP mil veces mayor del que debia; ahora solo se
    // comprueban en un sitio.
    const check = checkWithdrawal(
      amountUnits,
      user.balance,
      pendingTotal,
      provider === 'usdt' ? 'usdt' : 'cup',
      paidThisMonth,
    );

    if (!check.ok) {
      throw new MoneyError(check.message!, 400);
    }

    const commission = calculateCommission(amountUnits, 'withdrawal', provider);
    const net = amountUnits - commission;

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
      // `amount` es lo que el jugador PIDIO, en USDT. Se deja en USDT a proposito: es lo
      // que ve el panel del operador y lo que el jugador reconoce como su operacion.
      amount,
      currency: provider === 'usdt' ? 'USDT' : 'CUP',
      chain: order.chain,
      status: 'pending',
      simulated: SIMULATION_ENABLED,
      walletAddress,
      // En UNIDADES, como el saldo. Antes se guardaba el neto en el campo `amount`, que es
      // USDT, asi que una sola orden mezclaba las dos escalas y la aprobacion posterior
      // descontaba un numero en unidades de un campo que se leia como USDT.
      creditedAmount: net,
      commission,
      instructions: order.instructions,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await Transaction.create({
      telegramId,
      type: 'withdrawal',
      paymentMethod: provider,
      // El neto que SALE del saldo, en unidades, como `balance.real`.
      amount: net,
      currency: provider === 'usdt' ? 'USDT' : 'CUP',
      status: 'pending',
      commission,
      externalId: saved.orderId,
      metadata: {
        walletAddress,
        chain: order.chain,
        simulated: order.simulated,
        // Lo pedido, en USDT, junto al neto en unidades. Los dos, para no tener que
        // adivinar la escala al leer el movimiento.
        requestedUsdt: amount,
        netUnits: net,
      },
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
  async settleWithdrawal(
    orderId: string,
    txHash?: string,
    opciones: { confirmarSimulado?: boolean } = {},
  ): Promise<void> {
    const order = await PaymentOrder.findOne({ orderId });
    if (!order) {
      throw new MoneyError('Orden no encontrada.', 404);
    }

    // ------------------------------------------------------------------
    // EN SIMULACION, ESTE RETIRO NO SE PUEDE MARCAR COMO PAGADO
    //
    // Este endpoint no mueve dinero: solo marca la orden y descuenta el saldo, porque
    // el envio lo hace el operador por fuera. En simulacion no hay envio que hacer, y
    // marcar la orden como pagada deja el panel diciendo que el sistema ha procesado un
    // pago. El operador, que ve "aprobado", manda el USDT de verdad.
    //
    // O sea: la combinacion de "dinero de prueba" y "pago real fuera del sistema" es
    // la unica forma de perder dinero aqui, y es la que el endpoint dejaba abierta.
    //
    // Por eso hacen falta DOS cosas para pasar: el flag de entorno, que es
    // deliberado, y la confirmacion en la peticion, que es por peticion. Con una sola,
    // un clic de mas en el panel bastaria para pagarlo todo.
    // ------------------------------------------------------------------
    if (SIMULATION_ENABLED && !(ALLOW_SIMULATED_WITHDRAWALS && opciones.confirmarSimulado)) {
      const falta = [];
      if (!ALLOW_SIMULATED_WITHDRAWALS) {
        falta.push('ALLOW_SIMULATED_WITHDRAWALS=true en el entorno');
      }
      if (!opciones.confirmarSimulado) {
        falta.push('confirmarSimulado: true en la peticion');
      }

      throw new MoneyError(
        'El sistema esta en MODO SIMULACION y este retiro no se puede liquidar. ' +
        'Marcarlo como pagado haria que el panel dijera que el sistema ha procesado un ' +
        'pago, y ese dinero no sale de ningun sitio: el operador lo pagaria de su ' +
        'bolsillo. Faltaria: ' + falta.join(' y ') + '.',
        409,
      );
    }
    if (order.status === 'paid') {
      throw new MoneyError('El retiro ya fue liquidado.');
    }
    if (order.status !== 'pending') {
      throw new MoneyError(
        `Solo se pueden liquidar retiros pendientes (este está en "${order.status}").`,
      );
    }

    // ------------------------------------------------------------------
    // LO QUE SE DESCUENTA
    //
    // Se descuenta `creditedAmount` (el neto, en UNIDADES), no `amount` (lo pedido, en
    // USDT).
    //
    // Antes se descontaba `order.amount`, que es USDT, de un saldo en unidades: liquidar un
    // retiro de 100 USDT cobraba 100 unidades, o sea 0,1 USDT. Y el filtro `>=` comparaba
    // 5000 unidades contra 100, que pasaba siempre. Con la orden creada ahora, `amount` en
    // USDT, el descuento habria sido mil veces menor de lo debido.
    //
    // Se usa `creditedAmount`, que es el neto en unidades, con un respaldo a `amount`
    // convertido para las ordenes antiguas creadas antes de esta correccion. Sin el
    // respaldo, liquidar una orden vieja descontaria `undefined` y dejaria el saldo entero.
    // ------------------------------------------------------------------
    const debitUnits = Number.isFinite(order.creditedAmount) && order.creditedAmount > 0
      ? order.creditedAmount
      : usdtToUnits(order.amount);

    if (!Number.isFinite(debitUnits) || debitUnits <= 0) {
      throw new MoneyError(
        'El retiro no se puede liquidar: el importe de la orden no es valido. ' +
          'Revisala a mano antes de aprobarla.',
        409,
      );
    }

    // ------------------------------------------------------------------
    // LA PARTE MARCADA COMO PREMIO TAMBIEN BAJA
    //
    // Desde el 7 de octubre el premio de torneo entra al saldo retirable pero MARCADO, en
    // `balance.realFromPrizes` (decision B, `DECISIONES.md`). Es la unica manera de que un AML
    // pueda distinguir premio de deposito en el mismo saldo.
    //
    // Un retiro consume saldo real, asi que consume su parte marcada en la MISMA proporcion.
    // Si solo bajara `real`, con el tiempo el campo acabaria marcando dinero que ya no esta en
    // la cuenta, y por encima del saldo.
    //
    // El filtro sigue siendo la proteccion (`balance.real >= importe`), y `new: false` devuelve
    // el documento ANTES de la actualizacion, que es justo el saldo sobre el que se calcula la
    // proporcion. Una sola lectura y una sola escritura.
    // ------------------------------------------------------------------
    // Que parte del saldo era premio, ANTES de descontar. `premioQueSale` nunca es mas de lo que
    // hay marcado, aunque la orden y el saldo no cuadren por lo que sea.
    const saldoPrevio = await User.findOne({ telegramId: order.telegramId });
    const marcadoPrevio = saldoPrevio?.balance?.realFromPrizes ?? 0;
    const realPrevio = saldoPrevio?.balance?.real ?? 0;
    const premioQueSale = Math.min(
      marcadoPrevio,
      Math.round((marcadoPrevio * debitUnits) / Math.max(1, realPrevio)),
    );

    // El filtro es la proteccion: `balance.real >= importe`. Ademas evita el
    // doble cobro, porque el estado de la orden tambien se exige `pending` y solo
    // una de las dos aprobaciones concurrentes lo cumple.
    const debited = await User.findOneAndUpdate(
      {
        telegramId: order.telegramId,
        'balance.real': { $gte: debitUnits },
      },
      {
        $inc: {
          'balance.real': -debitUnits,
          'balance.realFromPrizes': -premioQueSale,
        },
      },
      { new: false },
    );

    if (!debited) {
      const user = await User.findOne({ telegramId: order.telegramId });
      const available = user?.balance.real ?? 0;

      throw new MoneyError(
        'El retiro no se puede liquidar: el usuario ya no tiene saldo retirable ' +
        `suficiente (necesita ${formatUnits(debitUnits)} USDT, ` +
        `tiene ${formatUnits(available)}). ` +
        'Si el pago ya salio de la plataforma, esto es un incidente: anotalo y ' +
        'liquida el saldo a mano. Si no se ha pagado todavia, cancela el retiro, ' +
        'que devuelve el dinero al usuario.',
        409,
      );
    }

    if (SIMULATION_ENABLED) {
      // Aviso aparte y con nivel error a proposito: si alguna vez se liquida un retiro
      // en simulacion, tiene que saltar en el log del operador aunque todo lo demas
      // parezca correcto.
      logger.error(
        'RETIRO LIQUIDADO EN MODO SIMULACION: ' +
          `${unitsToUsdt(order.amount)} USDT del usuario ${order.telegramId} ` +
          `(${order.provider}${order.chain ? '/' + order.chain : ''}). ` +
          'Si has pagado esto de verdad, hay que responder por ello.',
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
