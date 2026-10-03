import React, { useState, useEffect } from 'react';

interface AchievementsProps {
  user: any;
  onBack: () => void;
}

interface Achievement {
  _id: string;
  achievementId: string;
  progress: number;
  maxProgress: number;
  reward: number;
  claimed: boolean;
  unlockedAt: string;
}

interface Streak {
  current: number;
  best: number;
}

export const Achievements: React.FC<AchievementsProps> = ({ user, onBack }) => {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [streak, setStreak] = useState<Streak>({ current: 0, best: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAchievements();
  }, []);

  const fetchAchievements = async () => {
    try {
      const [achievementsRes, streakRes] = await Promise.all([
        fetch(`/api/monetization/achievements/${user?.id}`),
        fetch(`/api/monetization/streaks/${user?.id}`),
      ]);

      const achievementsData = await achievementsRes.json();
      const streakData = await streakRes.json();

      if (achievementsData.success) {
        setAchievements(achievementsData.achievements);
      }
      if (streakData.success) {
        setStreak(streakData);
      }
    } catch (error) {
      console.error('Error fetching achievements:', error);
    } finally {
      setLoading(false);
    }
  };

  const getAchievementName = (id: string) => {
    const names: Record<string, string> = {
      first_win: 'Primera Victoria',
      win_streak_3: 'Racha de 3',
      win_streak_5: 'Racha de 5',
      win_streak_10: 'Racha de 10',
      royal_flush: 'Escalera Real',
      four_of_a_kind: 'Póker',
      full_house: 'Full House',
      hands_played_10: '10 Manos',
      hands_played_50: '50 Manos',
      hands_played_100: '100 Manos',
      hands_played_500: '500 Manos',
      tournament_win: 'Campeón',
      tournament_finalist: 'Finalista',
      referral_1: 'Reclutador',
      referral_5: 'Embajador',
      referral_10: 'Leyenda',
      first_deposit: 'Primer Depósito',
      deposit_1000: 'Depósito 1000',
      deposit_10000: 'Depósito 10000',
    };
    return names[id] || id;
  };

  const getAchievementIcon = (id: string) => {
    if (id.includes('win')) return '🏆';
    if (id.includes('streak')) return '🔥';
    if (id.includes('flush')) return '👑';
    if (id.includes('poker')) return '🎴';
    if (id.includes('house')) return '🏠';
    if (id.includes('hands')) return '🃏';
    if (id.includes('tournament')) return '🏆';
    if (id.includes('referral')) return '👥';
    if (id.includes('deposit')) return '💰';
    return '🎖️';
  };

  const getStreakReward = (days: number) => {
    if (days >= 30) return 1500;
    if (days >= 14) return 500;
    if (days >= 7) return 200;
    if (days >= 3) return 50;
    return 0;
  };

  if (loading) {
    return (
      <div className="p-4">
        <div className="flex items-center mb-6">
          <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
          <h1 className="text-xl font-bold text-[#ffd700]">🏆 Logros</h1>
        </div>
        <div className="text-center py-12">
          <div className="spinner mx-auto mb-4"></div>
          <p className="text-[#a0a0b0]">Cargando...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
        <h1 className="text-xl font-bold text-[#ffd700]">🏆 Logros</h1>
      </div>

      {/* Streak Card */}
      <div className="glass rounded-2xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[#a0a0b0] text-sm">Tu racha actual</p>
            <p className="text-4xl font-bold text-[#ffd700]">{streak.current} días</p>
          </div>
          <div className="text-right">
            <p className="text-[#a0a0b0] text-sm">Mejor racha</p>
            <p className="text-2xl font-bold text-white">{streak.best} días</p>
          </div>
        </div>

        {/* Streak Rewards */}
        <div className="grid grid-cols-4 gap-2">
          {[3, 7, 14, 30].map((days) => (
            <div
              key={days}
              className={`text-center p-2 rounded-xl ${
                streak.current >= days
                  ? 'bg-[#ffd700]/20 border border-[#ffd700]'
                  : 'bg-[#0f0f1a]'
              }`}
            >
              <p className="text-xs text-[#a0a0b0]">{days} días</p>
              <p className={`text-sm font-bold ${streak.current >= days ? 'text-[#ffd700]' : 'text-[#a0a0b0]'}`}>
                {getStreakReward(days)} CUP
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="card text-center p-4">
          <p className="text-3xl font-bold text-[#00d26a]">{achievements.length}</p>
          <p className="text-xs text-[#a0a0b0]">Logros desbloqueados</p>
        </div>
        <div className="card text-center p-4">
          <p className="text-3xl font-bold text-[#ffd700]">
            {achievements.reduce((sum, a) => sum + a.reward, 0)}
          </p>
          <p className="text-xs text-[#a0a0b0]">CUP ganados</p>
        </div>
      </div>

      {/* Achievements List */}
      <div className="space-y-3">
        {achievements.length === 0 ? (
          <div className="card text-center py-8">
            <div className="text-4xl mb-3">🎖️</div>
            <p className="text-[#a0a0b0]">Aún no has desbloqueado logros</p>
            <p className="text-sm text-[#6c6c80] mt-1">¡Juega para ganar recompensas!</p>
          </div>
        ) : (
          achievements.map((achievement) => (
            <div
              key={achievement._id}
              className={`card flex items-center gap-4 ${
                achievement.claimed ? 'opacity-60' : ''
              }`}
            >
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#ffd700] to-[#ffb700] flex items-center justify-center text-2xl">
                {getAchievementIcon(achievement.achievementId)}
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-white">
                  {getAchievementName(achievement.achievementId)}
                </h3>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-2 bg-[#0f0f1a] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#00d26a] to-[#00b894] rounded-full"
                      style={{
                        width: `${(achievement.progress / achievement.maxProgress) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs text-[#a0a0b0]">
                    {achievement.progress}/{achievement.maxProgress}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[#ffd700] font-bold">+{achievement.reward} CUP</p>
                {achievement.claimed && (
                  <span className="badge badge-success text-xs">Reclamado</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Info */}
      <div className="mt-6 card">
        <h3 className="text-[#a0a0b0] text-sm mb-3">¿Cómo ganar logros?</h3>
        <ul className="text-sm text-[#a0a0b0] space-y-2">
          <li>• Juega manos y gana partidas</li>
          <li>• Mantén rachas de victorias</li>
          <li>• Participa en torneos</li>
          <li>• Invita amigos a la plataforma</li>
          <li>• Deposita fondos regularmente</li>
        </ul>
      </div>
    </div>
  );
};
