import { Router, Request, Response } from 'express';
import { tableManager } from '../game/table.manager';
import { seatingService, TableError } from '../game/seating.service';
import { requireTelegramAuth, getAuthedTelegramId } from '../middleware/telegramAuth';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import {
  TABLE_TIER_LIST,
  FREEROLL_PRIZES,
  SEATS_PER_TABLE,
  FREEROLL_TARGET_FIELD,
  FREEROLL_MAX_FIELD,
} from '../config/product';
import {
  fieldPayout,
  tierRtp,
  prizeDisclosure,
} from '../services/payout.service';

const router = Router();
router.use(requireTelegramAuth);

/** Configuracion de producto que la UI necesita para pintar el lobby. */
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    success: true,
    // Asientos por mesa fisica. La UI debe mostrar "7-max" como formato, no
    // "500 jugadores por mesa": el 500 es el field completo (multi-mesa).
    seatsPerTable: SEATS_PER_TABLE,

    cashTiers: TABLE_TIER_LIST.map(t => {
      // El premio real depende de cuantos jugadores jueguen: sale del bote.
      // A campo lleno se muestra ese, que es el mejor caso. La UI debe decir
      // "desde" para no prometer una cifra que dependa de la ocupacion.
      const full = fieldPayout(t.defaultBuyIn, t.fieldSize);
      const winner = full.entries.find(e => e.position === 1);

      return {
        id: t.id,
        label: t.label,
        description: t.description,
        fieldSize: t.fieldSize,
        minBuyIn: t.minBuyIn,
        defaultBuyIn: t.defaultBuyIn,
        tables: Math.ceil(t.fieldSize / SEATS_PER_TABLE),
        // Estimacion a campo lleno. El bote real depende de la ocupacion.
        estNetPot: full.netPot,
        estFirstPrize: winner?.amount ?? 0,
        rtp: tierRtp(t.minBuyIn, t.fieldSize),
        payout: full.entries,
      };
    }),

    // Texto de transparencia. La UI debe mostrarlo junto al premio: decir
    // "premio garantizado" sin explicar que sale del bote y no es retirable es
    // publicidad engañosa.
    prizeDisclosure: prizeDisclosure(),

    freerollTiers: FREEROLL_PRIZES,
    freerollTargetField: FREEROLL_TARGET_FIELD,
    freerollMaxField: FREEROLL_MAX_FIELD,
  });
});

/** Lobby: mesas cash disponibles. */
router.get('/list', async (_req: Request, res: Response) => {
  try {
    const tables = await tableManager.listTables();
    const cash = tables.filter(t => t.kind === 'cash');
    res.json({ success: true, tables: cash });
  } catch (error) {
    logger.error('GET /game/list:', error);
    res.status(500).json({ error: 'Error obteniendo las mesas' });
  }
});

/** Sentarse en una mesa. Acepta tableId o tierId. */
router.post('/sit', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const result = await seatingService.sitDown({
      telegramId,
      tableId: req.body.tableId,
      tierId: req.body.tierId,
      buyIn: req.body.buyIn ? Number(req.body.buyIn) : undefined,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof TableError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al sentarse',
    });
  }
});

/** Vista de la mesa para el jugador, incluyendo sus cartas. */
router.get('/view/:tableId', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const view = await tableManager.getPlayerView(req.params.tableId, telegramId);

    if (!view) {
      const publicView = await tableManager.getPublicTable(req.params.tableId, telegramId);
      if (!publicView) {
        return res.status(404).json({ error: 'Mesa no encontrada' });
      }
      return res.json({ success: true, state: publicView, spectator: true });
    }

    res.json({ success: true, state: view, spectator: false });
  } catch (error) {
    logger.error('GET /game/view:', error);
    res.status(500).json({ error: 'Error obteniendo la mesa' });
  }
});

/** Ejecutar una accion en la mano en curso. */
router.post('/action', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const { tableId, action, amount } = req.body;

    const valid = ['fold', 'check', 'call', 'raise', 'all_in'];
    if (!valid.includes(action)) {
      return res.status(400).json({ error: 'Accion no valida' });
    }

    await seatingService.act(telegramId, tableId, action, amount ? Number(amount) : undefined);
    res.json({ success: true });
  } catch (error) {
    const status = error instanceof TableError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al actuar',
    });
  }
});

/** Levantarse de la mesa. */
router.post('/stand', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const { tableId } = req.body;
    const result = await seatingService.standUp(telegramId, tableId);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof TableError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al salir',
    });
  }
});

/** Mesa donde esta sentado el jugador (para reconectar). */
router.get('/my-table', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const user = await User.findOne({ telegramId });
    res.json({ success: true, tableId: user?.activeTableId ?? null });
  } catch (error) {
    res.status(500).json({ error: 'Error' });
  }
});

// ==========================================================================
// Freerolls
// ==========================================================================

/** Lista de freerolls por escalon de premio. */
router.get('/freerolls', async (_req: Request, res: Response) => {
  try {
    const freerolls = await seatingService.listFreerolls();
    res.json({ success: true, freerolls });
  } catch (error) {
    logger.error('GET /game/freerolls:', error);
    res.status(500).json({ error: 'Error obteniendo freerolls' });
  }
});

/** Registrarse en un freeroll. */
router.post('/freerolls/join', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const result = await seatingService.joinFreeroll({
      telegramId,
      prizeTier: req.body.prizeTier ? Number(req.body.prizeTier) : undefined,
      freerollId: req.body.freerollId,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof TableError ? error.status : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al registrarse',
    });
  }
});

export default router;
