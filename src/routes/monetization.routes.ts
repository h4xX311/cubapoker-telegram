import { Router, Request, Response } from 'express';
import { monetizationService } from '../services/monetization.service';
import { User } from '../models/User';
import { VIP } from '../models/VIP';
import { Referral } from '../models/Referral';
import { Achievement } from '../models/Achievement';
import { Streak } from '../models/Achievement';
import { VIP_CONFIG, VIPLevel } from '../models/VIP';
import { rakebackService } from '../services/rakeback.service';
import { monetizationConfig } from '../config/monetization';
import { unitsToUsdt } from '../config/units';
import { requireTelegramAuth, getAuthedTelegramId } from '../middleware/telegramAuth';

const router = Router();

/**
 * Vista publica de un plan VIP.
 *
 * `VIP_CONFIG.price` esta en unidades internas (500 = 0,50 USDT). La interfaz
 * compara precios contra un saldo que ya viene en USDT, asi que la conversion
 * se hace aqui y el cliente recibe `priceUsdt`. Se conserva `price` para los
 * consumidores internos que sigan trabajando en unidades.
 */
const vipPublico = (cfg: any) =>
  cfg ? { ...cfg, priceUsdt: unitsToUsdt(cfg.price ?? 0) } : null;

// Toda la monetizacion exige identidad verificada de Telegram.
router.use(requireTelegramAuth);

// === VIP ===

// Obtener nivel VIP del usuario autenticado
router.get('/vip', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const [estado, arena] = await Promise.all([
      rakebackService.getStatus(telegramId),
      rakebackService.getArenaStatus(telegramId),
    ]);

    res.json({
      success: true,
      level: estado.level,
      active: estado.active,
      endDate: estado.endDate,
      config: vipPublico(estado.level ? VIP_CONFIG[estado.level] : null),
      rakeback: {
        weekKey: estado.weekKey,
        weekStart: estado.weekStart,
        weekEnd: estado.weekEnd,
        percent: estado.rakebackPercent,
        rakeUsdt: unitsToUsdt(estado.rakeUnits),
        estimatedUsdt: unitsToUsdt(estado.estimatedUnits),
        paidUsdt: unitsToUsdt(estado.paidUnits),
        claimableUsdt: unitsToUsdt(estado.claimableUnits),
        currentWeekRakeUsdt: unitsToUsdt(estado.currentWeekRakeUnits),
        payoutStatus: estado.payoutStatus,
        lastPayoutAt: estado.lastPayoutAt,
        nextPayoutAt: estado.nextPayoutAt,
      },
      // VIP Arena es una sala, no una membresía. Va aparte para que la UI no
      // la presente como un plan comprable.
      arena: {
        weekKey: arena.weekKey,
        weekStart: arena.weekStart,
        weekEnd: arena.weekEnd,
        percent: arena.profitSharePercent,
        rakeUsdt: unitsToUsdt(arena.rakeUnits),
        estimatedUsdt: unitsToUsdt(arena.estimatedUnits),
        paidUsdt: unitsToUsdt(arena.paidUnits),
        claimableUsdt: unitsToUsdt(arena.claimableUnits),
        payoutStatus: arena.payoutStatus,
        lastPayoutAt: arena.lastPayoutAt,
        nextPayoutAt: arena.nextPayoutAt,
      },
    });
  } catch (error) {
    console.error('Get VIP error:', error);
    res.status(500).json({ error: 'Error al obtener QVA-Bet Club' });
  }
});

// Activar un plan de QVA-Bet Club (la ruta conserva el nombre por compatibilidad).
router.post('/vip/purchase', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const { level } = req.body;

    if (!['basic', 'premium'].includes(level)) {
      return res.status(400).json({ error: 'Plan QVA-Bet Club inválido' });
    }

    const success = await monetizationService.purchaseVIP(telegramId, level as VIPLevel);
    
    if (success) {
      res.json({
        success: true,
        message: `${
          level === 'premium' ? 'QVA Premium' : 'QVA Member'
        } activado exitosamente`,
      });
    } else {
      res.status(400).json({ error: 'No se pudo activar QVA-Bet Club' });
    }
  } catch (error: any) {
    console.error('Purchase VIP error:', error);
    const esSaldo = /saldo insuficiente/i.test(error?.message ?? '');
    res.status(esSaldo ? 400 : 500).json({
      error: error?.message || 'Error al activar QVA-Bet Club',
    });
  }
});

/**
 * Cobrar el rakeback de la semana cerrada.
 *
 * Es idempotente: si ya se pagó, devuelve 0 y la semana pagada. El job
 * automático usa el mismo camino, así que un clic y el job no pueden pagar
 * dos veces.
 */
router.post('/vip/rakeback/claim', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const resultado = await rakebackService.payWeeklyRakeback(telegramId);

    res.json({
      success: true,
      paidUsdt: unitsToUsdt(resultado.paid),
      weekKey: resultado.weekKey,
      reason: resultado.reason ?? null,
    });
  } catch (error: any) {
    console.error('Claim rakeback error:', error);
    res.status(500).json({
      error: error?.message || 'Error al cobrar el rakeback',
    });
  }
});

/**
 * Cobrar el profit share de VIP Arena.
 *
 * Es una sala, no una membresía: no se compra nada. Solo se cobra el 15 % del
 * rake generado en las mesas de Arena durante la semana cerrada.
 */
router.post('/vip/arena/claim', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const resultado = await rakebackService.payArenaWeekly(telegramId);

    res.json({
      success: true,
      paidUsdt: unitsToUsdt(resultado.paid),
      weekKey: resultado.weekKey,
      reason: resultado.reason ?? null,
    });
  } catch (error: any) {
    console.error('Claim Arena profit share error:', error);
    res.status(500).json({
      error: error?.message || 'Error al cobrar el profit share de VIP Arena',
    });
  }
});

// Obtener configuración VIP
router.get('/vip/config', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      config: Object.fromEntries(
        Object.entries(VIP_CONFIG).map(([nivel, cfg]) => [nivel, vipPublico(cfg)]),
      ),
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// === REFERIDOS ===

// Obtener estadísticas de referidos del usuario autenticado
router.get('/referrals', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const stats = await monetizationService.getReferralStats(telegramId);

    res.json({
      success: true,
      ...stats,
      // Las comisiones se acumulan en unidades porque nacen del rake, que tambien
      // esta en unidades. La interfaz solo necesita USDT.
      totalCommissionUsdt: unitsToUsdt(stats.totalCommission ?? 0),
      bonusUsdt: unitsToUsdt(monetizationConfig.referrals.bonus ?? 0),
      referrals: stats.referrals.map((r: any) => {
        const referral = typeof r.toObject === 'function' ? r.toObject() : r;
        return {
          ...referral,
          commissionUsdt: unitsToUsdt(referral.commission ?? 0),
          totalRakeUsdt: unitsToUsdt(referral.totalRake ?? 0),
        };
      }),
    });
  } catch (error) {
    console.error('Get referrals error:', error);
    res.status(500).json({ error: 'Error al obtener referidos' });
  }
});

// Registrar referido: ambos usuarios deben venir autenticados desde Telegram
router.post('/referrals/register', async (req: Request, res: Response) => {
  try {
    const referredId = getAuthedTelegramId(req);
    const { referrerId } = req.body;

    const referrer = Number(referrerId);
    if (!Number.isFinite(referrer) || referrer <= 0) {
      return res.status(400).json({ error: 'Referidor inválido' });
    }
    if (referrer === referredId) {
      return res.status(400).json({ error: 'No puedes referirte a ti mismo' });
    }

    const exists = await User.findOne({ telegramId: referrer });
    if (!exists) {
      return res.status(404).json({ error: 'El referidor no existe' });
    }

    const success = await monetizationService.registerReferral(referrer, referredId);

    if (success) {
      res.json({ success: true, message: 'Referido registrado exitosamente' });
    } else {
      res.status(400).json({ error: 'Ya tienes un referidor registrado' });
    }
  } catch (error) {
    console.error('Register referral error:', error);
    res.status(500).json({ error: 'Error al registrar referido' });
  }
});

// === LOGROS ===

// Obtener logros del usuario autenticado
router.get('/achievements', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const achievements = await monetizationService.getUserAchievements(telegramId);

    res.json({
      success: true,
      achievements: achievements.map((a: any) => {
        const logro = typeof a.toObject === 'function' ? a.toObject() : a;
        return {
          ...logro,
          rewardUsdt: unitsToUsdt(logro.reward ?? 0),
        };
      }),
    });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ error: 'Error al obtener logros' });
  }
});

// Desbloquear logro (identidad verificada)
router.post('/achievements/unlock', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const { achievementId } = req.body;

    const success = await monetizationService.unlockAchievement(telegramId, achievementId);

    if (success) {
      res.json({ success: true, message: 'Logro desbloqueado' });
    } else {
      res.status(400).json({ error: 'Logro no disponible o ya desbloqueado' });
    }
  } catch (error) {
    console.error('Unlock achievement error:', error);
    res.status(500).json({ error: 'Error al desbloquear logro' });
  }
});

// === RACHAS ===

// Obtener racha del usuario autenticado
router.get('/streaks', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const streak = await monetizationService.getStreak(telegramId);

    res.json({
      success: true,
      ...streak,
    });
  } catch (error) {
    console.error('Get streak error:', error);
    res.status(500).json({ error: 'Error al obtener racha' });
  }
});

// Actualizar racha (identidad verificada)
router.post('/streaks/update', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);

    const result = await monetizationService.updateWinStreak(telegramId);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Update streak error:', error);
    res.status(500).json({ error: 'Error al actualizar racha' });
  }
});

// === ESTADÍSTICAS ===

// Estadísticas globales de la plataforma.
// Datos financieros internos: requieren clave de administrador.
// Nunca deben quedar expuestos al publico.
router.get('/stats', async (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    res.status(503).json({ error: 'Estadísticas deshabilitadas: falta ADMIN_API_KEY' });
    return;
  }

  if (req.headers['x-admin-key'] !== adminKey) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  try {
    const stats = await monetizationService.getMonetizationStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Obtener configuración de monetización
router.get('/config', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      config: monetizationConfig,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

export default router;
