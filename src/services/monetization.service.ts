import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { Referral } from '../models/Referral';
import { VIP, VIP_CONFIG, VIPLevel } from '../models/VIP';
import { Achievement, Streak, ACHIEVEMENTS, STREAK_REWARDS } from '../models/Achievement';
import { monetizationConfig, calculateRake, calculateCommission } from '../config/monetization';

export class MonetizationService {
  
  // === RAKE ===
  
  /**
   * Procesar rake al final de una mano
   */
  async processRake(
    gameId: string,
    pot: number,
    winnerId: number,
    vipLevel?: VIPLevel
  ): Promise<{ rake: number; netPot: number }> {
    const rake = calculateRake(pot, vipLevel);
    const netPot = pot - rake;
    
    // Registrar transacción de rake
    await Transaction.create({
      telegramId: 0, // Sistema
      type: 'rake',
      paymentMethod: 'credits',
      amount: rake,
      currency: 'CUP',
      status: 'completed',
      metadata: { gameId, winnerId },
    });
    
    return { rake, netPot };
  }
  
  // === COMISIONES ===
  
  /**
   * Procesar depósito con comisión
   */
  async processDeposit(
    telegramId: number,
    amount: number,
    method: 'enzona' | 'qvapay' | 'usdt',
    externalId?: string
  ): Promise<{ netAmount: number; commission: number }> {
    const commission = calculateCommission(amount, 'deposit', method);
    const netAmount = amount - commission;
    
    // Actualizar balance del usuario
    await User.findOneAndUpdate(
      { telegramId },
      { $inc: { 'balance.real': netAmount } }
    );
    
    // Registrar transacción
    await Transaction.create({
      telegramId,
      type: 'deposit',
      paymentMethod: method,
      amount: netAmount,
      currency: method === 'usdt' ? 'USDT' : 'CUP',
      status: 'completed',
      commission,
      commissionRate: monetizationConfig.commissions.deposit[method],
      externalId,
    });
    
    return { netAmount, commission };
  }
  
  /**
   * Procesar retiro con comisión
   */
  async processWithdrawal(
    telegramId: number,
    amount: number,
    method: 'enzona' | 'qvapay' | 'usdt',
    address?: string
  ): Promise<{ netAmount: number; commission: number }> {
    const commission = calculateCommission(amount, 'withdrawal', method);
    const netAmount = amount - commission;
    
    // Verificar balance. Solo `real` es retirable.
    const user = await User.findOne({ telegramId });
    if (!user || user.balance.real < amount) {
      throw new Error('Saldo insuficiente');
    }
    
    // Descontar del balance
    await User.findOneAndUpdate(
      { telegramId },
      { $inc: { 'balance.real': -amount } }
    );
    
    // Registrar transacción
    await Transaction.create({
      telegramId,
      type: 'withdrawal',
      paymentMethod: method,
      amount: netAmount,
      currency: method === 'usdt' ? 'USDT' : 'CUP',
      status: 'pending',
      commission,
      commissionRate: monetizationConfig.commissions.withdrawal[method],
      metadata: { address },
    });
    
    return { netAmount, commission };
  }
  
  // === VIP ===
  
  /**
   * Comprar suscripción VIP
   */
  async purchaseVIP(telegramId: number, level: VIPLevel): Promise<boolean> {
    const config = VIP_CONFIG[level];
    if (!config) return false;
    
    const user = await User.findOne({ telegramId });
    if (!user) return false;
    
    if (user.balance.real < config.price) {
      throw new Error('Saldo insuficiente para comprar VIP');
    }
    
    // Descontar del balance
    await User.findOneAndUpdate(
      { telegramId },
      { $inc: { 'balance.real': -config.price } }
    );
    
    // Crear o actualizar suscripción
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + config.duration);
    
    await VIP.findOneAndUpdate(
      { telegramId },
      {
        telegramId,
        level,
        startDate: new Date(),
        endDate,
        rakeDiscount: config.rakeDiscount,
        tournamentDiscount: config.tournamentDiscount,
      },
      { upsert: true, new: true }
    );
    
    // Registrar transacción
    await Transaction.create({
      telegramId,
      type: 'vip_purchase',
      paymentMethod: 'credits',
      amount: config.price,
      currency: 'CUP',
      status: 'completed',
      metadata: { level, duration: config.duration },
    });
    
    return true;
  }
  
  /**
   * Obtener nivel VIP del usuario
   */
  async getVIPLevel(telegramId: number): Promise<VIPLevel | null> {
    const vip = await VIP.findOne({ telegramId });
    if (!vip) return null;
    
    // Verificar si está activo
    if (new Date() > vip.endDate) {
      await VIP.deleteOne({ telegramId });
      return null;
    }
    
    return vip.level;
  }
  
  // === REFERIDOS ===
  
  /**
   * Registrar referido
   */
  async registerReferral(referrerId: number, referredId: number): Promise<boolean> {
    // Verificar que no exista
    const existing = await Referral.findOne({ referredId });
    if (existing) return false;
    
    // Determinar nivel
    const referrerReferral = await Referral.findOne({ referredId: referrerId });
    const level = referrerReferral ? Math.min(referrerReferral.level + 1, 3) : 1;
    
    await Referral.create({
      referrerId,
      referredId,
      level,
    });
    
    // Dar bonus al referidor.
    // Es saldo promocional: va a `play` (NO retirable). Si fuera a `real`,
    // un usuario podria invitar amigos, sacar el bonus y vaciar la plataforma
    // sin depositar nunca.
    const bonus = monetizationConfig.referrals.bonus;
    await User.findOneAndUpdate(
      { telegramId: referrerId },
      { $inc: { 'balance.play': bonus } }
    );
    
    return true;
  }
  
  /**
   * Procesar comisión de referido
   */
  async processReferralCommission(
    referredId: number,
    rakeAmount: number
  ): Promise<void> {
    const referral = await Referral.findOne({ referredId });
    if (!referral) return;
    
    const { level } = referral;
    const rates = monetizationConfig.referrals;
    const rate = level === 1 ? rates.level1 : level === 2 ? rates.level2 : rates.level3;
    
    const commission = Math.floor((rakeAmount * rate) / 100);
    
    // Actualizar comisión del referido
    await Referral.findOneAndUpdate(
      { referredId },
      {
        $inc: {
          totalRake: rakeAmount,
          commission,
        },
      }
    );
    
    // La comision de referido es ganancia por rake de jugadores reales, asi que
    // es saldo real (retirable).
    await User.findOneAndUpdate(
      { telegramId: referral.referrerId },
      { $inc: { 'balance.real': commission } }
    );
    
    // Registrar transacción
    await Transaction.create({
      telegramId: referral.referrerId,
      type: 'referral_commission',
      paymentMethod: 'credits',
      amount: commission,
      currency: 'CUP',
      status: 'completed',
      metadata: { referredId, rakeAmount, level },
    });
  }
  
  /**
   * Obtener estadísticas de referidos
   */
  async getReferralStats(telegramId: number): Promise<{
    totalReferrals: number;
    activeReferrals: number;
    totalCommission: number;
    referrals: any[];
  }> {
    const referrals = await Referral.find({ referrerId: telegramId });
    
    return {
      totalReferrals: referrals.length,
      activeReferrals: referrals.filter(r => r.totalRake > 0).length,
      totalCommission: referrals.reduce((sum, r) => sum + r.commission, 0),
      referrals,
    };
  }
  
  // === LOGROS ===
  
  /**
   * Desbloquear logro
   */
  async unlockAchievement(telegramId: number, achievementId: string): Promise<boolean> {
    const achievement = ACHIEVEMENTS[achievementId as keyof typeof ACHIEVEMENTS];
    if (!achievement) return false;
    
    // Verificar si ya existe
    const existing = await Achievement.findOne({ telegramId, achievementId });
    if (existing) return false;
    
    // Crear logro
    await Achievement.create({
      telegramId,
      achievementId,
      progress: achievement.maxProgress,
      maxProgress: achievement.maxProgress,
      reward: achievement.reward,
    });
    
    // Dar recompensa. Logros son promocionales: saldo `play`, no retirable.
    await User.findOneAndUpdate(
      { telegramId },
      { $inc: { 'balance.play': achievement.reward } }
    );
    
    return true;
  }
  
  /**
   * Actualizar progreso de logro
   */
  async updateAchievementProgress(
    telegramId: number,
    achievementId: string,
    progress: number
  ): Promise<void> {
    await Achievement.findOneAndUpdate(
      { telegramId, achievementId },
      { $set: { progress } }
    );
  }
  
  /**
   * Obtener logros del usuario
   */
  async getUserAchievements(telegramId: number): Promise<any[]> {
    return Achievement.find({ telegramId });
  }
  
  // === RACHAS ===
  
  /**
   * Actualizar racha de victorias
   */
  async updateWinStreak(telegramId: number): Promise<{ streak: number; reward: number }> {
    let streak = await Streak.findOne({ telegramId });
    
    if (!streak) {
      streak = await Streak.create({
        telegramId,
        currentStreak: 1,
        bestStreak: 1,
        lastWinAt: new Date(),
      });
    } else {
      // Verificar si es consecutivo (menos de 24 horas)
      const lastWin = new Date(streak.lastWinAt);
      const now = new Date();
      const hoursDiff = (now.getTime() - lastWin.getTime()) / (1000 * 60 * 60);
      
      if (hoursDiff < 24) {
        streak.currentStreak += 1;
      } else {
        streak.currentStreak = 1;
      }
      
      streak.bestStreak = Math.max(streak.bestStreak, streak.currentStreak);
      streak.lastWinAt = now;
      await streak.save();
    }
    
    // Verificar recompensa
    const reward = STREAK_REWARDS[streak.currentStreak as keyof typeof STREAK_REWARDS] || 0;
    
    if (reward > 0) {
      // Recompensa por racha: promocional, saldo `play` (no retirable).
      await User.findOneAndUpdate(
        { telegramId },
        { $inc: { 'balance.play': reward } }
      );
    }
    
    return { streak: streak.currentStreak, reward };
  }
  
  /**
   * Obtener racha del usuario
   */
  async getStreak(telegramId: number): Promise<{ current: number; best: number }> {
    const streak = await Streak.findOne({ telegramId });
    return {
      current: streak?.currentStreak || 0,
      best: streak?.bestStreak || 0,
    };
  }
  
  // === ESTADÍSTICAS ===
  
  /**
   * Obtener estadísticas de monetización
   */
  async getMonetizationStats(): Promise<{
    totalRake: number;
    totalCommissions: number;
    totalVIPRevenue: number;
    totalReferralCommissions: number;
    totalTournamentRake: number;
  }> {
    const rakeResult = await Transaction.aggregate([
      { $match: { type: 'rake', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    
    const commissionResult = await Transaction.aggregate([
      { $match: { type: 'commission', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    
    const vipResult = await Transaction.aggregate([
      { $match: { type: 'vip_purchase', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    
    const referralResult = await Transaction.aggregate([
      { $match: { type: 'referral_commission', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    
    const tournamentResult = await Transaction.aggregate([
      { $match: { type: 'tournament_buyin', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    
    return {
      totalRake: rakeResult[0]?.total || 0,
      totalCommissions: commissionResult[0]?.total || 0,
      totalVIPRevenue: vipResult[0]?.total || 0,
      totalReferralCommissions: referralResult[0]?.total || 0,
      totalTournamentRake: tournamentResult[0]?.total || 0,
    };
  }
}

export const monetizationService = new MonetizationService();
