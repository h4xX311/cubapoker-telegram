import { Router, Request, Response } from 'express';
import { monetizationService } from '../services/monetization.service';
import { User } from '../models/User';
import { VIP } from '../models/VIP';
import { Referral } from '../models/Referral';
import { Achievement } from '../models/Achievement';
import { Streak } from '../models/Achievement';
import { VIP_CONFIG, VIPLevel } from '../models/VIP';
import { monetizationConfig } from '../config/monetization';
import { requireTelegramAuth, getAuthedTelegramId } from '../middleware/telegramAuth';

const router = Router();

// Toda la monetizacion exige identidad verificada de Telegram.
router.use(requireTelegramAuth);

// === VIP ===

// Obtener nivel VIP del usuario autenticado
router.get('/vip', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const level = await monetizationService.getVIPLevel(telegramId);

    res.json({
      success: true,
      level,
      config: level ? VIP_CONFIG[level] : null,
    });
  } catch (error) {
    console.error('Get VIP error:', error);
    res.status(500).json({ error: 'Error al obtener VIP' });
  }
});

// Comprar VIP
router.post('/vip/purchase', async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);
    const { level } = req.body;

    if (!['basic', 'premium', 'elite'].includes(level)) {
      return res.status(400).json({ error: 'Nivel VIP inválido' });
    }
    
    const success = await monetizationService.purchaseVIP(telegramId, level as VIPLevel);
    
    if (success) {
      res.json({
        success: true,
        message: `VIP ${level} comprado exitosamente`,
      });
    } else {
      res.status(400).json({ error: 'No se pudo comprar VIP' });
    }
  } catch (error: any) {
    console.error('Purchase VIP error:', error);
    res.status(500).json({ error: error.message || 'Error al comprar VIP' });
  }
});

// Obtener configuración VIP
router.get('/vip/config', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      config: VIP_CONFIG,
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
      achievements,
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
