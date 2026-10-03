import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  onBack: () => void;
}

const ACHIEVEMENT_META: Record<string, { name: string; icon: string }> = {
  first_win: { name: 'Primera victoria', icon: '🎯' },
  win_streak_3: { name: 'Racha de 3', icon: '🔥' },
  win_streak_5: { name: 'Racha de 5', icon: '🔥' },
  win_streak_10: { name: 'Racha de 10', icon: '🔥' },
  royal_flush: { name: 'Escalera real', icon: '👑' },
  four_of_a_kind: { name: 'Póker', icon: '🎴' },
  full_house: { name: 'Full house', icon: '🏠' },
  hands_played_10: { name: '10 manos', icon: '🃏' },
  hands_played_50: { name: '50 manos', icon: '🃏' },
  hands_played_100: { name: '100 manos', icon: '🃏' },
  hands_played_500: { name: '500 manos', icon: '🃏' },
  tournament_win: { name: 'Campeón de torneo', icon: '🏆' },
  tournament_finalist: { name: 'Finalista', icon: '🥈' },
  referral_1: { name: '1 referido', icon: '👥' },
  referral_5: { name: '5 referidos', icon: '👥' },
  referral_10: { name: '10 referidos', icon: '👥' },
  first_deposit: { name: 'Primer depósito', icon: '💰' },
  deposit_1000: { name: 'Depósito 1000', icon: '💰' },
  deposit_10000: { name: 'Depósito 10000', icon: '💰' },
};

const STREAK_MILESTONES = [
  { days: 3, reward: 50 },
  { days: 7, reward: 200 },
  { days: 14, reward: 500 },
  { days: 30, reward: 1500 },
];

export function Achievements({ onBack }: Props) {
  const [achievements, setAchievements] = useState<any[]>([]);
  const [streak, setStreak] = useState({ current: 0, best: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [achRes, streakRes] = await Promise.all([api.achievements(), api.streaks()]);
        setAchievements(achRes.achievements || []);
        setStreak({ current: streakRes.current ?? 0, best: streakRes.best ?? 0 });
      } catch {
        setAchievements([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totalRewards = achievements.reduce((sum, a) => sum + (a.reward ?? 0), 0);

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Logros" onBack={onBack} />

      {/* Racha */}
      <div
        className="rounded-2xl p-4 mb-5"
        style={{
          background: 'linear-gradient(135deg, #3b2d0d 0%, #0f3460 100%)',
          border: '1px solid rgba(255,215,0,0.25)',
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs text-[#a0a0b0] uppercase tracking-wide">Racha actual</p>
            <p className="text-3xl font-bold text-[#ffd700] leading-tight">
              {streak.current}
              <span className="text-base font-normal text-[#a0a0b0] ml-1.5">días</span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-[#a0a0b0] uppercase tracking-wide">Mejor</p>
            <p className="text-xl font-bold text-white">{streak.best}</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {STREAK_MILESTONES.map(m => {
            const reached = streak.current >= m.days;
            return (
              <div
                key={m.days}
                className={`text-center p-2 rounded-xl ${
                  reached ? 'bg-[#ffd700]/20' : 'bg-black/30'
                }`}
              >
                <p className="text-[10px] text-[#a0a0b0]">{m.days}d</p>
                <p className={`text-xs font-bold ${reached ? 'text-[#ffd700]' : 'text-[#a0a0b0]'}`}>
                  {m.reward}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="card text-center p-4">
          <p className="text-2xl font-bold text-[#00d26a]">{achievements.length}</p>
          <p className="text-[10px] text-[#a0a0b0]">Desbloqueados</p>
        </div>
        <div className="card text-center p-4">
          <p className="text-2xl font-bold text-[#ffd700]">{totalRewards}</p>
          <p className="text-[10px] text-[#a0a0b0]">CUP ganados</p>
        </div>
      </div>

      <SectionLabel>Tu colección</SectionLabel>

      {loading ? (
        <div className="text-center py-8">
          <div className="spinner mx-auto" />
        </div>
      ) : achievements.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-3xl mb-2">🎖️</div>
          <p className="text-sm text-white font-semibold mb-1">Sin logros aún</p>
          <p className="text-xs text-[#a0a0b0]">
            Juega, gana manos y mantén tu racha para desbloquearlos.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {achievements.map((a, i) => {
            const meta = ACHIEVEMENT_META[a.achievementId] ?? {
              name: a.achievementId,
              icon: '🎖️',
            };
            const progress = Math.min(100, (a.progress / a.maxProgress) * 100);
            return (
              <div
                key={a._id ?? i}
                className="card flex items-center gap-3 p-3 animate-slideUp"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-[#ffd700] to-[#ffb700] flex items-center justify-center text-xl flex-shrink-0">
                  {meta.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{meta.name}</p>
                  <div className="progress-bar mt-1.5">
                    <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <p className="text-sm font-bold text-[#ffd700] flex-shrink-0">
                  +{a.reward}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
