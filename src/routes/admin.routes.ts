import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { User } from '../models/User';
import { PaymentOrder } from '../models/PaymentOrder';
import { Table } from '../models/Table';
import { Field } from '../models/Field';
import { VIP } from '../models/VIP';
import { paymentService, MoneyError } from '../services/payment/payment.service';
import { SIMULATION_ENABLED } from '../services/payment/gateway';
import { logger } from '../utils/logger';
import { unitsToUsdt } from '../config/units';
import { WITHDRAWALS, CUP_PER_USDT } from '../config/currency';

/**
 * Panel de operador.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTO ES UN BLOQUEANTE Y NO UNA MEJORA
 *
 * Sin este panel, si un usuario pide un retiro, el dinero queda retenido sin
 * salida: no hay quien lo apruebe ni quien lo cancele. El saldo del usuario se
 * descuenta al solicitar (no: se descuenta al liquidar, ver
 * `payment.service`), pero la orden queda en `pending` para siempre. En la
 * practica eso significa que la primera persona que intenta retirar su dinero
 * se queda sin respuesta, y la segunda no se atreve a intentarlo.
 *
 * Este panel es la via por la que el operador ejecuta los pagos. Sin el, el
 * producto retiene dinero de usuarios, que es el peor defecto que puede tener
 * una plataforma de pagos.
 *
 * ------------------------------------------------------------------
 * AUTENTICACION
 *
 * `ADMIN_API_KEY` en la cabecera `x-admin-key`. Es lo unico que separa estas
 * rutas del resto: sin la clave, el panel queda deshabilitado (503), no abierto.
 * Es una decision deliberada: un panel de retiros sin clave puesta seria peor que
 * no tenerlo, porque daria falsa confianza.
 *
 * Limitacion que hay que reconocer: la clave es un secreto compartido. Sirve
 * para una operacion de un operador o dos. En cuanto haya varios administradores
 * hace falta autenticacion individual con registro de auditoria, y eso es otro
 * sistema.
 */

const router = Router();

/**
 * Middleware de autorizacion del panel.
 *
 * Comparacion en tiempo constante: con `===` un atacante puede medir el tiempo
 * de respuesta e ir adivinando la clave caracter a caracter. Con
 * `crypto.timingSafeEqual` no.
 */
const requireAdmin = (req: Request, res: Response, next: () => void) => {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    res.status(503).json({
      error:
        'Panel deshabilitado: ADMIN_API_KEY no esta definida. ' +
        'Sin ella estas rutas no se habilitan.',
    });
    return;
  }

  const provided = String(req.headers['x-admin-key'] || '');

  const a = Buffer.from(provided);
  const b = Buffer.from(adminKey);
  const equal = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!equal) {
    // No se registra la clave recibida, por si alguien la pasa por error.
    logger.warn(
      `Acceso denegado al panel desde ${req.ip}: clave incorrecta`,
    );
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  next();
};

router.use(requireAdmin);

// ==========================================================================
// Vista general
// ==========================================================================

/**
 * Resumen operativo: que hay que hacer ahora mismo.
 *
 * La pregunta que el operador se hace al abrir esto es "tengo algo pendiente?",
 * no "cuanto ganamos este mes". Por eso lo primero son las colas de trabajo
 * abierto, y las cifras despues.
 */
router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      pendingWithdrawals,
      pendingDeposits,
      expiredDeposits,
      activeFields,
      pausedFields,
      usersTotal,
      usersWithBalance,
    ] = await Promise.all([
      PaymentOrder.countDocuments({ type: 'withdrawal', status: 'pending' }),
      PaymentOrder.countDocuments({ type: 'deposit', status: 'pending' }),
      PaymentOrder.countDocuments({
        type: 'deposit',
        status: 'pending',
        expiresAt: { $lt: now },
      }),
      Field.countDocuments({ status: { $in: ['filling', 'running', 'final'] } }),
      // Mesas pausadas = reinicio con campo en juego. Requieren decision.
      Table.countDocuments({ status: 'paused' }),
      User.countDocuments({}),
      User.countDocuments({
        $expr: { $gt: [{ $add: ['$balance.real', '$balance.play'] }, 0] },
      }),
    ]);

    res.json({
      success: true,
      accionesPendientes: {
        retirosPorPagar: pendingWithdrawals,
        depositosPorConfirmar: pendingDeposits,
        depositosExpirados: expiredDeposits,
        camposActivos: activeFields,
        mesasPausadas: pausedFields,
      },
      usuarios: {
        total: usersTotal,
        conSaldo: usersWithBalance,
      },
      modoSimulacion: SIMULATION_ENABLED,
      aviso:
        SIMULATION_ENABLED
          ? 'MODO SIMULACION: no se mueve dinero real. ' +
            'Poner SIMULATE_PAYMENTS=false solo cuando las pasarelas reales esten conectadas.'
          : 'Modo produccion: se mueven dinero real.',
    });
  } catch (error) {
    logger.error('GET /api/admin/overview:', error);
    res.status(500).json({ error: 'Error obteniendo el resumen' });
  }
});

// ==========================================================================
// Retiros
// ==========================================================================

/**
 * Retiros pendientes, del mas antiguo al mas reciente.
 *
 * El orden importa: el primero es el que lleva mas tiempo esperando, y es el que
 * el usuario ya esta mirando el movil. Pagar el mas reciente primero es la
 * forma tipica de hacer que un cliente se vaya.
 */
router.get('/withdrawals', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const orders = await PaymentOrder.find({ type: 'withdrawal', status })
      .sort({ createdAt: 1 })
      .limit(limit);

    const users = await User.find({
      telegramId: { $in: orders.map((o) => o.telegramId) },
    }).select('telegramId firstName username balance stats');

    const byId = new Map(users.map((u) => [u.telegramId, u]));

    res.json({
      success: true,
      count: orders.length,
      withdrawals: orders.map((o) => {
        const user = byId.get(o.telegramId);
        return {
          orderId: o.orderId,
          telegramId: o.telegramId,
          username: user?.username,
          firstName: user?.firstName,
          provider: o.provider,
          // Los importes son unidades internas en el modelo.
          amountUsdt: unitsToUsdt(o.amount),
          commissionUsdt: unitsToUsdt(o.commission),
          netUsdt: unitsToUsdt(o.amount - o.commission),
          amountCup: Math.round(unitsToUsdt(o.amount) * CUP_PER_USDT),
          walletAddress: o.walletAddress,
          chain: o.chain,
          status: o.status,
          simulated: o.simulated,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          /** Saldo retirable actual: para ver si aun puede pagarse. */
          userRealUsdt: user ? unitsToUsdt(user.balance.real) : null,
          userPlayUsdt: user ? unitsToUsdt(user.balance.play) : null,
        };
      }),
    });
  } catch (error) {
    logger.error('GET /api/admin/withdrawals:', error);
    res.status(500).json({ error: 'Error obteniendo los retiros' });
  }
});

/**
 * Aprueba un retiro.
 *
 * IMPORTANTE: este endpoint NO mueve dinero. Marca la orden como pagada y
 * consume el saldo, asumiendo que el operador ya hizo el pago por fuera (a una
 * wallet, por EnZona). Eso es correcto porque el envio lo hace una persona o un
 * sistema externo, y aqui solo queda el registro.
 *
 * El saldo se consume AQUI, no al solicitar. Es lo que hace que cancelar un
 * retiro devuelva el dinero automaticamente.
 */
router.post('/withdrawals/:orderId/approve', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const txHash = req.body?.txHash;

    await paymentService.settleWithdrawal(orderId, txHash);

    const order = await PaymentOrder.findOne({ orderId });

    logger.info(
      `Retiro ${orderId} aprobado: ${unitsToUsdt(order.amount)} USDT ` +
      `(${order.provider}${order.chain ? '/' + order.chain : ''}) por el operador`,
    );

    res.json({
      success: true,
      message:
        'Retiro liquidado y saldo descontado. ' +
        'Recuerda comprobar que el pago se ha realizado de verdad antes de usar este endpoint.',
      orderId,
      txHash: order.txHash,
      amountUsdt: unitsToUsdt(order.amount),
    });
  } catch (error) {
    if (error instanceof MoneyError) {
      res.status(error.status || 400).json({ error: error.message });
      return;
    }
    logger.error('POST /api/admin/withdrawals/approve:', error);
    res.status(500).json({ error: 'Error aprobando el retiro' });
  }
});

/**
 * Cancela un retiro y devuelve el saldo al usuario.
 *
 * Es la operacion que evita el peor escenario: un retiro que el operador no
 * puede pagar. Cancelar devuelve el saldo y avisa al usuario.
 */
router.post('/withdrawals/:orderId/cancel', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const reason =
      req.body?.reason || 'Cancelado por el operador sin especificar motivo';

    await paymentService.cancelWithdrawal(orderId, reason);

    logger.info(`Retiro ${orderId} cancelado: ${reason}`);

    res.json({
      success: true,
      message: 'Retiro cancelado y saldo devuelto al usuario.',
      orderId,
      reason,
    });
  } catch (error) {
    if (error instanceof MoneyError) {
      res.status(error.status || 400).json({ error: error.message });
      return;
    }
    logger.error('POST /api/admin/withdrawals/cancel:', error);
    res.status(500).json({ error: 'Error cancelando el retiro' });
  }
});

// ==========================================================================
// Depositos
// ==========================================================================

/**
 * Depositos por confirmar.
 *
 * En simulacion, confirmar aqui equivale a la pantalla de prueba del cliente.
 * Con pasarelas reales, estos depositos los confirma el webhook del proveedor y
 * esta lista sirve para ver que no se ha colado ninguno, no para aprobarlo a
 * mano: hacerlo permitiria acreditar saldo sin pago.
 */
router.get('/deposits', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const orders = await PaymentOrder.find({ type: 'deposit', status })
      .sort({ createdAt: -1 })
      .limit(limit);

    const now = new Date();

    res.json({
      success: true,
      count: orders.length,
      deposits: orders.map((o) => ({
        orderId: o.orderId,
        telegramId: o.telegramId,
        provider: o.provider,
        chain: o.chain,
        amountUsdt: unitsToUsdt(o.amount),
        status: o.status,
        simulated: o.simulated,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
        expired: now > o.expiresAt,
        txHash: o.txHash,
      })),
    });
  } catch (error) {
    logger.error('GET /api/admin/deposits:', error);
    res.status(500).json({ error: 'Error obteniendo los depositos' });
  }
});

// ==========================================================================
// Usuarios
// ==========================================================================

/** Busca un usuario por id de Telegram. */
router.get('/users/:telegramId', async (req: Request, res: Response) => {
  try {
    const telegramId = Number(req.params.telegramId);
    const user = await User.findOne({ telegramId });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    const [deposits, withdrawals, vip] = await Promise.all([
      PaymentOrder.find({ telegramId, type: 'deposit', status: 'paid' })
        .sort({ createdAt: -1 })
        .limit(20),
      PaymentOrder.find({ telegramId, type: 'withdrawal' })
        .sort({ createdAt: -1 })
        .limit(20),
      VIP.findOne({ telegramId }),
    ]);

    res.json({
      success: true,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        balance: {
          realUsdt: unitsToUsdt(user.balance.real),
          playUsdt: unitsToUsdt(user.balance.play),
          totalUsdt: unitsToUsdt(user.balance.real + user.balance.play),
        },
        stats: user.stats,
        vip: vip
          ? {
              level: vip.level,
              startDate: vip.startDate,
              endDate: vip.endDate,
              rakeDiscount: vip.rakeDiscount,
              /** Caducado: el descuento ya no aplica aunque el documento exista. */
              activo: vip.endDate > new Date(),
            }
          : null,
        activeTableId: user.activeTableId,
        createdAt: (user as any).createdAt,
      },
      deposits: deposits.map((d) => ({
        orderId: d.orderId,
        provider: d.provider,
        chain: d.chain,
        amountUsdt: unitsToUsdt(d.amount),
        status: d.status,
        createdAt: d.createdAt,
      })),
      withdrawals: withdrawals.map((w) => ({
        orderId: w.orderId,
        provider: w.provider,
        chain: w.chain,
        amountUsdt: unitsToUsdt(w.amount),
        status: w.status,
        walletAddress: w.walletAddress,
        txHash: w.txHash,
        createdAt: w.createdAt,
      })),
    });
  } catch (error) {
    logger.error('GET /api/admin/users:', error);
    res.status(500).json({ error: 'Error obteniendo el usuario' });
  }
});

// ==========================================================================
// Campos
// ==========================================================================

/** Estado de los campos, para seguir uno que esta en juego. */
router.get('/fields', async (_req: Request, res: Response) => {
  try {
    const fields = await Field.find({
      status: { $in: ['filling', 'running', 'final'] },
    })
      .sort({ createdAt: -1 })
      .limit(30);

    res.json({
      success: true,
      count: fields.length,
      fields: fields.map((f) => ({
        fieldId: f.fieldId,
        kind: f.kind,
        tierId: f.tierId,
        prizeTier: f.prizeTier,
        status: f.status,
        buyInUsdt: unitsToUsdt(f.buyIn),
        targetField: f.targetField,
        seated: f.seated,
        waiting: f.waiting,
        playersRemaining: f.playersRemaining,
        eliminated: f.eliminated,
        paidPositionsLeft: f.paidPositionsLeft,
        rakeUsdt: unitsToUsdt(f.rakeCollected),
        buyInsUsdt: unitsToUsdt(f.buyInsCollected),
        netPotUsdt: unitsToUsdt(f.buyInsCollected - f.rakeCollected),
        tables: f.tables.length,
        plannedTables: f.plannedTables,
        startedAt: f.startedAt,
        finishedAt: f.finishedAt,
      })),
    });
  } catch (error) {
    logger.error('GET /api/admin/fields:', error);
    res.status(500).json({ error: 'Error obteniendo los campos' });
  }
});

/**
 * Mesas pausadas.
 *
 * Una mesa pausada es una mesa de campo que el proceso encontro a medias al
 * arrancar. Sus fichas NO se reembolsa automaticamente: el dinero es del campo y
 * hay que decidir si el campo se continua o se cancela devolviendo a cada
 * jugador. Este listado es donde se ve cuales son.
 */
router.get('/paused-tables', async (_req: Request, res: Response) => {
  try {
    const tables = await Table.find({ status: 'paused' }).limit(50);

    res.json({
      success: true,
      count: tables.length,
      tables: tables.map((t) => ({
        tableId: t.tableId,
        tierId: t.tierId,
        fieldId: t.field?.fieldId,
        fieldStatus: t.field?.fieldStatus,
        seated: t.seats.filter((s) => s.kind === 'human').length,
        totalSeated: t.seats.length,
        chipsInPlay: t.seats.reduce((sum, s) => sum + s.chips, 0),
        chipsInPlayUsdt: unitsToUsdt(
          t.seats.reduce((sum, s) => sum + s.chips, 0),
        ),
        handNumber: t.hand.handNumber,
      })),
      aviso:
        'Estas mesas tienen fichas de jugadores bloqueadas. Hay que decidir ' +
        'por cada una si se reanuda el campo o se devuelve el dinero.',
    });
  } catch (error) {
    logger.error('GET /api/admin/paused-tables:', error);
    res.status(500).json({ error: 'Error obteniendo las mesas pausadas' });
  }
});

// ==========================================================================
// Finanzas
// ==========================================================================

/**
 * Cifras de negocio.
 *
 * En USDT, que es la unidad de la cuenta. El equivalente en CUP se calcula con el
 * tipo de referencia, que es una estimacion: el CUP se deprecia y el tipo de
 * cambio es una decision del operador, no un dato de mercado en tiempo real.
 */
router.get('/finance', async (req: Request, res: Response) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [deposits, withdrawals, rake, activeUsers, fees] = await Promise.all([
      PaymentOrder.aggregate([
        { $match: { type: 'deposit', status: 'paid', createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      PaymentOrder.aggregate([
        { $match: { type: 'withdrawal', status: 'paid', createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Field.aggregate([
        { $match: { status: 'finished' } },
        { $group: { _id: null, total: { $sum: '$rakeCollected' } } },
      ]),
      User.countDocuments({
        $expr: { $gt: [{ $add: ['$balance.real', '$balance.play'] }, 0] },
      }),
      PaymentOrder.aggregate([
        { $match: { status: 'paid', createdAt: { $gte: since } } },
        { $group: { _id: '$type', fees: { $sum: '$commission' } } },
      ]),
    ]);

    const deposited = deposits[0]?.total ?? 0;
    const withdrawn = withdrawals[0]?.total ?? 0;
    const rakeCollected = rake[0]?.total ?? 0;

    const toUsdt = (units: number) => unitsToUsdt(units);

    res.json({
      success: true,
      periodoDias: days,
      desde: since,
      nota:
        'Las cifras estan en UNIDADES INTERNAS en la base de datos y se ' +
        'convierten a USDT aqui. El equivalente en CUP usa un tipo de cambio de ' +
        `referencia de ${CUP_PER_USDT} CUP por USDT, que es una estimacion ` +
        'administrativa, no un tipo de mercado.',
      ingresos: {
        rake: {
          usdt: toUsdt(rakeCollected),
          cup: Math.round(toUsdt(rakeCollected) * CUP_PER_USDT),
        },
        comisiones: fees.reduce(
          (acc: Record<string, number>, f: any) => ({
            ...acc,
            [f._id]: toUsdt(f.fees),
          }),
          {},
        ),
      },
      volumen: {
        depositado: { usdt: toUsdt(deposited), count: deposits[0]?.count ?? 0 },
        retirado: { usdt: toUsdt(withdrawn), count: withdrawals[0]?.count ?? 0 },
        /** Depositado menos lo retirado: el saldo que el operador tiene en el banco. */
        neto: { usdt: toUsdt(deposited - withdrawn) },
      },
      usuariosActivos: activeUsers,
      limitesRetiro: {
        minUsdt: WITHDRAWALS.min,
        maxPerTransactionUsdt: WITHDRAWALS.maxPerTransaction,
        monthlyWinCapUsdt: WITHDRAWALS.monthlyWinCap,
        redPorDefecto: WITHDRAWALS.defaultNetwork,
      },
    });
  } catch (error) {
    logger.error('GET /api/admin/finance:', error);
    res.status(500).json({ error: 'Error obteniendo las finanzas' });
  }
});

export default router;
