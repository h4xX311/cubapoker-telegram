import { Router, Request, Response } from 'express';
import { paymentService, MoneyError } from '../services/payment/payment.service';
import {
  confirmSimulatedOrder,
  SIMULATION_ENABLED,
  SIMULATION_SECRET,
  getSimulatedOrder,
} from '../services/payment/gateway';
import { isValidChain, CHAIN_LIST } from '../config/chains';
import { requireTelegramAuth, getAuthedTelegramId } from '../middleware/telegramAuth';

const router = Router();

router.use(requireTelegramAuth);

/**
 * Cadenas disponibles para USDT.
 * Publico: el cliente lo necesita para pintar las opciones.
 */
router.get('/chains', (_req: Request, res: Response) => {
  res.json({
    success: true,
    chains: CHAIN_LIST.map(c => ({
      id: c.id,
      name: c.name,
      nativeSymbol: c.nativeSymbol,
      addressExample: c.addressExample,
      avgFeeUsd: c.avgFeeUsd,
      confirmationMinutes: c.confirmationMinutes,
      recommended: !!c.recommended,
    })),
    simulate: SIMULATION_ENABLED,
  });
});

/**
 * Paso 1: crear la orden de deposito.
 * Todavia no se acredita nada; se devuelve donde debe pagar el usuario.
 */
router.post('/deposit/order', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const amount = Number(req.body.amount);
    const provider = req.body.provider;
    const chain = req.body.chain;

    if (!['enzona', 'qvapay', 'usdt'].includes(provider)) {
      throw new MoneyError('Metodo de pago no valido.');
    }
    if (provider === 'usdt' && chain && !isValidChain(chain)) {
      throw new MoneyError('Red no soportada.');
    }

    const order = await paymentService.createDepositOrder({
      telegramId,
      amount,
      provider,
      chain,
    });

    res.json({ success: true, ...order });
  } catch (error) {
    const status = error instanceof MoneyError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error creando la orden',
    });
  }
});

/**
 * Paso 2: confirmar el pago.
 * En modo simulacion se confirma desde la pantalla de pruebas; con pasarela real
 * este endpoint lo invoca el webhook firmado del proveedor.
 */
router.post('/deposit/confirm', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const { orderId, txHash } = req.body;

    if (!orderId) {
      throw new MoneyError('Falta el identificador de la orden.');
    }

    // Un usuario solo puede confirmar sus propias ordenes
    const order = await paymentService.getOrder(orderId);
    if (!order) {
      throw new MoneyError('Orden no encontrada.', 404);
    }
    if (order.telegramId !== telegramId) {
      throw new MoneyError('Esta orden no te pertenece.', 403);
    }

    const result = await paymentService.creditDepositOrder(orderId, txHash);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof MoneyError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error confirmando el pago',
    });
  }
});

/** Solicita un retiro. Queda pendiente hasta que un operador lo apruebe. */
router.post('/withdraw', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const amount = Number(req.body.amount);
    const provider = req.body.provider;
    const chain = req.body.chain;
    const walletAddress = req.body.walletAddress;

    if (!['enzona', 'qvapay', 'usdt'].includes(provider)) {
      throw new MoneyError('Metodo de retiro no valido.');
    }
    if (provider === 'usdt' && chain && !isValidChain(chain)) {
      throw new MoneyError('Red no soportada.');
    }

    const result = await paymentService.createWithdrawalRequest({
      telegramId,
      amount,
      provider,
      chain,
      walletAddress,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof MoneyError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error solicitando el retiro',
    });
  }
});

/** Historial de movimientos del usuario. */
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const type = req.query.type as 'deposit' | 'withdrawal' | undefined;
    const orders = await paymentService.getOrders(telegramId, type);
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Error obteniendo el historial',
    });
  }
});

// ==========================================================================
// Modo simulacion
// ==========================================================================
// Mientras no haya pasarela real, estos endpoints permiten recorrer el flujo
// completo de forma verificable. Se deshabilitan con SIMULATE_PAYMENTS=false.

router.get('/simulate/:orderId', (req: Request, res: Response) => {
  if (!SIMULATION_ENABLED) {
    res.status(404).json({ error: 'Simulacion deshabilitada' });
    return;
  }

  const order = getSimulatedOrder(req.params.orderId);
  if (!order) {
    res.status(404).json({ error: 'Orden no encontrada o expirada' });
    return;
  }

  res.json({
    success: true,
    order: {
      id: order.id,
      provider: order.provider,
      amount: order.amount,
      currency: order.currency,
      chain: order.chain,
      status: order.status,
      instructions: order.instructions,
      expiresAt: order.expiresAt,
    },
  });
});

router.post('/simulate/:orderId/confirm', (req: Request, res: Response) => {
  if (!SIMULATION_ENABLED) {
    res.status(404).json({ error: 'Simulacion deshabilitada' });
    return;
  }

  const result = confirmSimulatedOrder(
    req.params.orderId,
    req.body.secret || SIMULATION_SECRET,
  );

  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ success: true, order: result.order });
});

export default router;
