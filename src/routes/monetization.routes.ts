import { Router, Request, Response } from 'express';
import { monetizationService } from '../services/monetization.service';
import { User } from '../models/User';
import { VIP } from '../models/VIP';
import { Referral } from '../models/Referral';
import { Achievement } from '../models/Achievement';
import { Streak } from '../models/Achievement';
import { VIP_CONFIG, VIPLevel } from '../models/VIP';
import { monetizationConfig } from '../config/monetization';

const router = Router();

// === VIP ===

// Obtener nivel VIP del usuario
router.get('/vip/:telegramId', async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    const level = await monetizationService.getVIPLevel(parseInt(telegramId));
    
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
    const { telegramId, level } = req.body;
    
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

// Obtener estadísticas de referidos
router.get('/referrals/:telegramId', async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    const stats = await monetizationService.getReferralStats(parseInt(telegramId));
    
    res.json({
      success: true,
      ...stats,
    });
  } catch (error) {
    console.error('Get referrals error:', error);
    res.status(500).json({ error: 'Error al obtener referidos' });
  }
});

// Registrar referido
router.post('/referrals/register', async (req: Request, res: Response) => {
  try {
    const { referrerId, referredId } = req.body;
    
    const success = await monetizationService.registerReferral(referrerId, referredId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Referido registrado exitosamente',
      });
    } else {
      res.status(400).json({ error: 'No se pudo registrar referido' });
    }
  } catch (error) {
    console.error('Register referral error:', error);
    res.status(500).json({ error: 'Error al registrar referido' });
  }
});

// === LOGROS ===

// Obtener logros del usuario
router.get('/achievements/:telegramId', async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    const achievements = await monetizationService.getUserAchievements(parseInt(telegramId));
    
    res.json({
      success: true,
      achievements,
    });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ error: 'Error al obtener logros' });
  }
});

// Desbloquear logro
router.post('/achievements/unlock', async (req: Request, res: Response) => {
  try {
    const { telegramId, achievementId } = req.body;
    
    const success = await monetizationService.unlockAchievement(telegramId, achievementId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Logro desbloqueado',
      });
    } else {
      res.status(400).json({ error: 'No se pudo desbloquear logro' });
    }
  } catch (error) {
    console.error('Unlock achievement error:', error);
    res.status(500).json({ error: 'Error al desbloquear logro' });
  }
});

// === RACHAS ===

// Obtener racha del usuario
router.get('/streaks/:telegramId', async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    const streak = await monetizationService.getStreak(parseInt(telegramId));
    
    res.json({
      success: true,
      ...streak,
    });
  } catch (error) {
    console.error('Get streak error:', error);
    res.status(500).json({ error: 'Error al obtener racha' });
  }
});

// Actualizar racha
router.post('/streaks/update', async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.body;
    
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

// Obtener estadísticas de monetización (solo admin)
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await monetizationService.getMonetizationStats();
    
    res.json({
      success: true,
      ...stats,
    });
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
