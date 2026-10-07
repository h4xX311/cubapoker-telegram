import { Router, Request, Response } from 'express';
import { tableManager } from '../game/table.manager';
import { seatingService, TableError } from '../game/seating.service';
import { fieldManager, FieldError } from '../game/field.manager';
import { centrollService, CentrollError } from '../game/centroll.service';
import { Field, toPublicField } from '../models/Field';
import { Table } from '../models/Table';
import { requireTelegramAuth, getAuthedTelegramId } from '../middleware/telegramAuth';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import {
  TABLE_TIER_LIST,
  FREEROLL_PRIZES,
  SEATS_PER_TABLE,
  FREEROLL_TARGET_FIELD,
  FREEROLL_MAX_FIELD,
  CENTROLL,
  UNLOCK_RATES,
} from '../config/product';
import {
  WITHDRAWALS,
  CUP_PER_USDT,
  usdtToCup,
} from '../config/currency';
import { unitsToUsdt } from '../config/units';
import { fieldPayout, prizeDisclosure } from '../services/payout.service';
import { unlockService } from '../services/unlock.service';

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
      // El premio sale del bote del campo: sale multiplicando por 300
      // participantes. `fieldPayout` trabaja en unidades internas, asi que se
      // le pasa el buy-in en unidades y se convierte la salida a USDT.
      const full = fieldPayout(t.buyInUnits, t.fieldSize);
      const winner = full.entries.find(e => e.position === 1);

      return {
        id: t.id,
        label: t.label,
        description: t.description,
        fieldSize: t.fieldSize,
        tables: Math.ceil(t.fieldSize / SEATS_PER_TABLE),
        buyIn: t.buyInUsdt,
        blinds: {
          small: unitsToUsdt(t.blinds.small),
          big: unitsToUsdt(t.blinds.big),
        },
        stackInBigBlinds: t.stackInBigBlinds,
        // Todo a USDT para la UI.
        estNetPot: unitsToUsdt(full.netPot),
        estFirstPrize: unitsToUsdt(winner?.amount ?? 0),
        estRake: unitsToUsdt(full.rake),
        payout: full.entries.map(e => ({
          position: e.position,
          percentage: e.percentage,
          amount: unitsToUsdt(e.amount),
        })),
      };
    }),

    // Texto de transparencia. La UI debe mostrarlo junto al premio: decir
    // "premio garantizado" sin explicar que sale del bote es publicidad
    // engañosa.
    prizeDisclosure: prizeDisclosure(),

    freerollTiers: FREEROLL_PRIZES,
    freerollTargetField: FREEROLL_TARGET_FIELD,
    freerollMaxField: FREEROLL_MAX_FIELD,

    // Centroll: buy-in de 1 centavo que consume saldo REAL y da fichas. Es la
    // via por la que el dinero real entra al ciclo del freeroll.
    centroll: {
      buyIn: CENTROLL.buyInUsdt,
      buyInCup: usdtToCup(CENTROLL.buyInUsdt),
      prizeMultiplier: CENTROLL.prizeMultiplier,
      targetField: CENTROLL.targetField,
      maxField: CENTROLL.maxField,
      maxRebuys: CENTROLL.maxRebuys,
    },

    // Mecanismo de Promotional Dollars: como se desbloquea `balance.play`.
    unlock: {
      rate: UNLOCK_RATES.cash,
      ratioLabel: `1:${Math.round(1 / UNLOCK_RATES.cash)}`,
      disclosure: unlockService.disclosure(),
    },

    // Limites de retiro, para que la UI no los tenga duplicados.
    withdrawals: {
      min: WITHDRAWALS.min,
      maxPerTransaction: WITHDRAWALS.maxPerTransaction,
      monthlyWinCap: WITHDRAWALS.monthlyWinCap,
      defaultNetwork: WITHDRAWALS.defaultNetwork,
      networkFees: WITHDRAWALS.networkFees,
    },

    // Equivalente en CUP, para que el usuario cubano razone en su moneda.
    cupPerUsdt: CUP_PER_USDT,
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

// ==========================================================================
// Campos multi-mesa
// ==========================================================================

/**
 * Inscripcion a un campo.
 *
 * A diferencia de `/sit`, aqui el buy-in se cobra UNA vez y las fichas quedan
 * bloqueadas hasta que el jugador es eliminado o gana el campo. El jugador no
 * entra en una mesa concreta: entra en una cola, y el field manager le asigna
 * asiento segun donde haya hueco.
 */
router.post('/fields/:tierId/register', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const user = await User.findOne({ telegramId });
    const result = await fieldManager.register(
      telegramId,
      req.params.tierId as any,
      user?.username,
    );
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof FieldError ? 400 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al registrarse',
    });
  }
});

/** Salir del campo antes de que empiece, con devolucion del buy-in. */
router.post('/fields/:fieldId/leave', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const result = await fieldManager.unregister(telegramId, req.params.fieldId);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof FieldError ? 400 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'No se pudo salir',
    });
  }
});

/** Estado del campo: quien esta sentado, en que mesa, cuantas plazas quedan. */
router.get('/fields/:fieldId', async (req: Request, res: Response) => {
  try {
    const status = await fieldManager.status(req.params.fieldId);
    res.json({ success: true, ...status });
  } catch (error) {
    const status = error instanceof FieldError ? 404 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al leer el campo',
    });
  }
});

/**
 * Campos abiertos ahora mismo, y EN CUAL DE ELLOS ESTA EL QUE PREGUNTA.
 *
 * ------------------------------------------------------------------
 * POR QUE hace falta `miCampo`
 *
 * La lista de campos decia cuantos hay y cuantos faltan, pero no si el que pregunta esta
 * sentado en alguno. Sin eso, la interfaz no puede ni avisar de que ya estas dentro ni
 * ofrecerte salir.
 *
 * Y quedarse dentro sin poder salir es el peor estado posible en un campo: el buy-in esta
 * cobrado, estas sentado, y no hay ninguna accion posible. Con poca liquidez, que es como
 * empieza todo producto, es lo que le pasa al primer usuario que entra.
 *
 * Por eso la ruta lleva autenticacion: sin ella no se puede saber de quien se trata.
 *
 * `puedeSalir` solo es true en `filling`. Una vez que el campo ha arrancado no se puede
 * salir (seria Steiner sus fichas al bote y quedarse con el premio sin jugar), y el boton
 * tiene que decirlo en vez de fallar.
 * ------------------------------------------------------------------
 */
router.get('/fields', requireTelegramAuth, async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);

    const fields = await Field.find({
      status: { $in: ['filling', 'running', 'final'] },
    })
      .sort({ createdAt: -1 })
      .limit(20);

    // Que campo de estos tiene a este usuario sentado, y en que mesa.
    const tableIds = fields.flatMap((f) => f.tables.map((t) => t.tableId));
    const mio = new Map<string, { fieldId: string; tableId: string; status: string }>();

    if (tableIds.length > 0) {
      const mesas = await Table.find({
        tableId: { $in: tableIds },
        seats: { $elemMatch: { playerId: String(telegramId) } },
      }).select('tableId field.fieldId');

      for (const mesa of mesas) {
        const fieldId = mesa.field?.fieldId;
        if (fieldId && !mio.has(fieldId)) {
          mio.set(fieldId, {
            fieldId,
            tableId: mesa.tableId,
            status: mesa.field?.fieldStatus ?? 'filling',
          });
        }
      }
    }

    res.json({
      success: true,
      fields: fields.map((f) => ({
        ...toPublicField(f),
        miCampo: mio.get(f.fieldId) ?? null,
      })),
      // El mismo dato en la raiz, para que la interfaz no tenga que recorrer la lista.
      miCampo: [...mio.values()][0] ?? null,
    });
  } catch (error) {
    logger.error('GET /game/fields:', error);
    res.status(500).json({ error: 'Error obteniendo los campos' });
  }
});

/** Estado del centroll: buy-in, premio, cuantos inscritos. */
router.get('/centroll', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, ...(await centrollService.status()) });
  } catch (error) {
    logger.error('GET /game/centroll:', error);
    res.status(500).json({ error: 'Error obteniendo el centroll' });
  }
});

/**
 * Entrada a un centroll.
 *
 * Consume saldo REAL (no el de promoción), que es el requisito explícito de
 * CoinPoker. El premio va a fichas de promoción.
 */
router.post('/centroll/join', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const user = await User.findOne({ telegramId });
    const result = await centrollService.register(telegramId, user?.username);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof CentrollError ? 400 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'No se pudo entrar al centroll',
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
/**
 * En que mesa esta sentado el usuario, o null.
 *
 * ------------------------------------------------------------------
 * POR QUE NO SE USA `activeTableId`
 *
 * Porque ese campo solo lo escribe `seating.service.sitDown`, que es el camino de las mesas
 * CASH SUELTAS. En un CAMPO no lo escribe nadie: `fieldManager.register` mete al jugador en
 * una cola y le asigna asiento con su propio codigo.
 *
 * Asi que si estas sentado en un campo, `activeTableId` es `null`, esta ruta decia que no
 * estas en ninguna parte, y el boton "Jugar ahora" creia que estaba libre y llamaba a
 * `sit`, que respondia "Ya estas sentado en otra mesa. Sal de ella primero."
 *
 * Un mensaje imposible: la aplicacion no encuentra tu mesa y a la vez te dice que estas
 * sentado en una.
 *
 * ------------------------------------------------------------------
 * LA FUENTE DE VERDAD SON LOS ASIENTOS
 *
 * Se pregunta a las mesas con el mismo criterio que `fieldManager.isSeated`: un asiento con
 * tu `playerId` que no sea `out`. Y se devuelve tambien si la mesa es de un campo, que es
 * justo el caso que fallaba.
 */
router.get('/my-table', requireTelegramAuth, async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);

    const mesa = await Table.findOne({
      seats: { $elemMatch: { playerId: String(telegramId), status: { $ne: 'out' } } },
    })
      .select('tableId field.fieldId')
      .lean();

    if (!mesa) {
      // Sin asiento: el usuario esta limpio. Se limpia tambien el campo del usuario, que
      // puede haberse quedado apuntando a una mesa en la que ya no esta.
      await User.updateOne(
        { telegramId, activeTableId: { $ne: null } },
        { $set: { activeTableId: null } },
      );
      res.json({ success: true, tableId: null, fieldId: null });
      return;
    }

    res.json({
      success: true,
      tableId: mesa.tableId,
      fieldId: mesa.field?.fieldId ?? null,
    });
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
