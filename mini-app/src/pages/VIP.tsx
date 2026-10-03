import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

const LEVELS: Record<string, { icon: string; gradient: string; accent: string }> = {
  basic: { icon: '🥉', gradient: 'from-[#3498db] to-[#2980b9]', accent: 'text-[#3498db]' },
  premium: { icon: '🥈', gradient: 'from-[#ffd700] to-[#e6a800]', accent: 'text-[#ffd700]' },
  elite: { icon: '🥇', gradient: 'from-[#9b59b6] to-[#8e44ad]', accent: 'text-[#9b59b6]' },
};

const ORDER = ['basic', 'premium', 'elite'];

export function VIP({ user, onBack, onBalanceChange }: Props) {
  const [currentLevel, setCurrentLevel] = useState<string | null>(user?.vip ?? null);
  const [configs, setConfigs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [statusRes, configRes] = await Promise.all([api.vip(), api.vipConfig()]);
      setCurrentLevel(statusRes.level ?? null);
      setConfigs(configRes.config || {});
    } catch {
      setConfigs({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const purchase = async (level: string) => {
    setBusy(level);
    setError('');
    try {
      await api.purchaseVip(level);
      await onBalanceChange?.();
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo completar la compra.',
      );
    } finally {
      setBusy(null);
    }
  };

  const balance = user?.balance?.credits ?? 0;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="CubaPoker VIP" onBack={onBack} />

      {loading ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto" />
        </div>
      ) : (
        <>
          {currentLevel && (
            <div
              className="rounded-2xl p-4 mb-5 flex items-center gap-3"
              style={{ background: '#16213e', border: '1px solid #ffd700' }}
            >
              <span className="text-3xl">{LEVELS[currentLevel]?.icon}</span>
              <div>
                <p className="text-xs text-[#a0a0b0] uppercase tracking-wide">
                  Tu nivel actual
                </p>
                <p className="font-bold text-white">{configs[currentLevel]?.name}</p>
              </div>
              <span className="badge badge-success ml-auto">Activo</span>
            </div>
          )}

          {error && (
            <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
              <p className="text-sm text-[#ff8a94]">{error}</p>
            </div>
          )}

          <SectionLabel>Planes</SectionLabel>
          <div className="space-y-3">
            {ORDER.filter(l => configs[l]).map(level => {
              const cfg = configs[level];
              const meta = LEVELS[level];
              const owned = currentLevel === level;
              const canAfford = balance >= cfg.price;

              return (
                <article
                  key={level}
                  className="card relative overflow-hidden animate-slideUp"
                  style={owned ? { borderColor: '#ffd700' } : undefined}
                >
                  <div
                    className={`absolute -top-6 -right-6 w-24 h-24 bg-gradient-to-br ${meta.gradient} opacity-20 rounded-full`}
                  />

                  <header className="flex items-center gap-3 mb-3 relative">
                    <span className="text-2xl">{meta.icon}</span>
                    <div className="min-w-0">
                      <h3 className="font-bold text-white">{cfg.name}</h3>
                      <p className={`text-xs ${meta.accent}`}>
                        Rake {cfg.rakeDiscount === 0 ? '0%' : `${Math.max(0, 5 - cfg.rakeDiscount)}%`}
                        {cfg.tournamentDiscount > 0 && ` · Torneos -${cfg.tournamentDiscount}%`}
                      </p>
                    </div>
                  </header>

                  <p className="text-2xl font-bold text-white mb-3 relative">
                    {cfg.price}{' '}
                    <span className="text-xs font-normal text-[#a0a0b0]">
                      CUP / {cfg.duration} días
                    </span>
                  </p>

                  <ul className="space-y-1.5 mb-4 relative">
                    {cfg.benefits.map((b: string, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-[#a0a0b0]">
                        <span className="text-[#00d26a] mt-0.5">✓</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    onClick={() => purchase(level)}
                    disabled={owned || busy === level || !canAfford}
                    className={`w-full btn py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                      owned ? 'btn-outline' : 'btn-primary'
                    }`}
                  >
                    {owned
                      ? 'Tu plan actual'
                      : busy === level
                      ? 'Procesando…'
                      : !canAfford
                      ? `Te faltan ${cfg.price - balance} CUP`
                      : 'Activar'}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
