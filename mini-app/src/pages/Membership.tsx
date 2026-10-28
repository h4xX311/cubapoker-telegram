import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';
import { fmtUsdt } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

/**
 * MEMBRESÍA QVA-BET CLUB
 * ======================
 *
 * Esta pantalla es SOLO de la membresía. La sala VIP Arena tiene su propia
 * pantalla (`VipArena.tsx`) porque no es un plan: es una mesa de cash a la que
 * se entra con el buy-in y cuyo profit share se cobra allí.
 *
 * QVA-Bet Club funciona como el 3-Bet Club de CoinPoker: el club no se compra,
 * se activa un plan (mensual o trimestral). La membresía no descuenta rake:
 * devuelve un porcentaje del rake generado en las mesas cash normales.
 */

const LEVELS: Record<string, { icon: string; gradient: string; accent: string }> = {
  basic: {
    icon: '🥉',
    gradient: 'from-[#3498db] to-[#2980b9]',
    accent: 'text-[#3498db]',
  },
  premium: {
    icon: '🥈',
    gradient: 'from-[#ffd700] to-[#e6a800]',
    accent: 'text-[#ffd700]',
  },
};

const ORDER = ['basic', 'premium'];

const fechaCorta = (iso: string | null | undefined) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
  });
};

export function Membership({ user, onBack, onBalanceChange }: Props) {
  const [status, setStatus] = useState<any>(null);
  const [currentLevel, setCurrentLevel] = useState<string | null>(null);
  const [configs, setConfigs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [statusRes, configRes] = await Promise.all([
        api.vip(),
        api.vipConfig(),
      ]);
      setStatus(statusRes);
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

  const claim = async () => {
    setClaiming(true);
    setError('');
    try {
      const res = await api.claimVipRakeback();
      await onBalanceChange?.();
      await load();
      if (!res?.paidUsdt && res?.reason) {
        setError(res.reason);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo cobrar el rakeback.',
      );
    } finally {
      setClaiming(false);
    }
  };

  const realBalance = user?.balance?.real ?? 0;
  const rb = status?.rakeback;
  const available = rb?.claimableUsdt ?? 0;
  const percent = rb?.percent ?? 0;
  const payoutPending = rb?.payoutStatus === 'pending';

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Membresía QVA-Bet Club" onBack={onBack} />

      <div
        className="rounded-2xl p-4 mb-5"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <p className="text-[10px] uppercase tracking-[0.18em] text-[#ffd700] font-bold">
          CubaPoker Rewards · Membresía
        </p>
        <h2 className="text-xl font-bold text-white mt-1">
          Recupera tu rake cada semana
        </h2>
        <p className="text-xs text-[#a0a0b0] mt-1 leading-relaxed">
          QVA-Bet Club es el programa de membresía, como el 3-Bet Club de
          CoinPoker. El club no se compra: se activa un plan mensual o trimestral
          y el 10% del rake de tus mesas cash normales vuelve a tu saldo
          retirable.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto" />
        </div>
      ) : (
        <>
          {currentLevel && status?.active && (
            <div
              className="rounded-2xl p-4 mb-5"
              style={{ background: '#12241c', border: '1px solid #00d26a' }}
            >
              <div className="flex items-start gap-3">
                <span className="text-3xl">{LEVELS[currentLevel]?.icon ?? '★'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
                    Tu membresía QVA-Bet Club
                  </p>
                  <p className="font-bold text-white">
                    {configs[currentLevel]?.name ?? status?.config?.name ?? 'Membresía activa'}
                  </p>
                  <p className="text-[10px] text-[#a0a0b0] mt-0.5">
                    Activa hasta {fechaCorta(status.endDate)}
                  </p>
                </div>
                <span className="badge badge-success">Activa</span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-4">
                <div className="rounded-xl p-3" style={{ background: '#0d1a14' }}>
                  <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide">
                    Rake de la semana
                  </p>
                  <p className="text-lg font-bold text-white mt-1">
                    {fmtUsdt(rb?.rakeUsdt ?? 0)}
                    <span className="text-[10px] font-normal text-[#a0a0b0] ml-1">
                      USDT
                    </span>
                  </p>
                  <p className="text-[9px] text-[#a0a0b0] mt-1">
                    {fechaCorta(rb?.weekStart)} – {fechaCorta(rb?.weekEnd)}
                  </p>
                </div>
                <div className="rounded-xl p-3" style={{ background: '#0d1a14' }}>
                  <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide">
                    Tu rakeback ({percent}%)
                  </p>
                  <p className="text-lg font-bold text-[#00d26a] mt-1">
                    {fmtUsdt(rb?.estimatedUsdt ?? 0)}
                    <span className="text-[10px] font-normal text-[#a0a0b0] ml-1">
                      USDT
                    </span>
                  </p>
                  <p className="text-[9px] text-[#a0a0b0] mt-1">
                    {rb?.payoutStatus === 'paid'
                      ? 'Pagado'
                      : payoutPending
                        ? 'En revisión'
                        : available > 0
                          ? 'Disponible'
                          : 'En curso'}
                  </p>
                </div>
              </div>

              {available > 0 && !payoutPending ? (
                <button
                  onClick={claim}
                  disabled={claiming}
                  className="w-full btn btn-primary py-2.5 text-sm mt-3 disabled:opacity-50"
                >
                  {claiming
                    ? 'Cobrando…'
                    : `Cobrar ${fmtUsdt(available)} USDT`}
                </button>
              ) : (
                <p className="text-[10px] text-[#a0a0b0] mt-3">
                  {payoutPending
                    ? 'Tu pago está en revisión. No hace falta volver a cobrarlo.'
                    : `Próximo pago: ${fechaCorta(rb?.nextPayoutAt)}. El rake de esta semana se paga al cerrar la semana.`}
                </p>
              )}

              {(rb?.currentWeekRakeUsdt ?? 0) > 0 && (
                <p className="text-[10px] text-[#a0a0b0] mt-2">
                  Rake acumulado esta semana:{' '}
                  <span className="text-white font-semibold">
                    {fmtUsdt(rb.currentWeekRakeUsdt)} USDT
                  </span>
                </p>
              )}
            </div>
          )}

          {!currentLevel && (
            <div
              className="rounded-2xl p-4 mb-5"
              style={{ background: '#151525', border: '1px solid #2a2a4a' }}
            >
              <p className="text-sm font-semibold text-white">
                Empieza a recuperar tu rake
              </p>
              <p className="text-xs text-[#a0a0b0] mt-1 leading-relaxed">
                Con el plan mensual recuperas el 10% del rake de tus mesas cash
                normales. Si generas 1.000 USDT de rake al mes, recuperas 100
                USDT. El rake de la sala VIP Arena no entra aquí: esa sala paga
                su propio profit share y no requiere membresía.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
              <p className="text-sm text-[#ff8a94]">{error}</p>
            </div>
          )}

          <SectionLabel>Planes de membresía</SectionLabel>
          <p className="text-[10px] text-[#a0a0b0] mb-3 leading-relaxed">
            El club no se compra: lo que se activa es un plan. El plan mensual
            dura 30 días y el trimestral 90 días.
          </p>
          <div className="space-y-3">
            {ORDER.filter((l) => configs[l]).map((level) => {
              const cfg = configs[level];
              const meta = LEVELS[level];
              const owned = currentLevel === level && status?.active;
              const price = cfg.priceUsdt ?? (cfg.price ?? 0) / 1000;
              const canAfford = realBalance >= price;

              return (
                <article
                  key={level}
                  className="card relative overflow-hidden animate-slideUp"
                  style={owned ? { borderColor: '#00d26a' } : undefined}
                >
                  <div
                    className={`absolute -top-6 -right-6 w-24 h-24 bg-gradient-to-br ${meta.gradient} opacity-20 rounded-full`}
                  />

                  <header className="flex items-center gap-3 mb-3 relative">
                    <span className="text-2xl">{meta.icon}</span>
                    <div className="min-w-0">
                      <h3 className="font-bold text-white">{cfg.name}</h3>
                      <p className={`text-xs ${meta.accent}`}>
                        Rakeback {cfg.rakebackPercent}% semanal
                        {cfg.tournamentDiscount > 0 &&
                          ` · Torneos -${cfg.tournamentDiscount}%`}
                      </p>
                    </div>
                  </header>

                  <p className="text-2xl font-bold text-white mb-3 relative">
                    {fmtUsdt(price)}{' '}
                    <span className="text-xs font-normal text-[#a0a0b0]">
                      USDT / {cfg.duration} días
                    </span>
                  </p>

                  <ul className="space-y-1.5 mb-4 relative">
                    {(cfg.benefits ?? []).map((b: string, i: number) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-xs text-[#a0a0b0]"
                      >
                        <span className="text-[#00d26a] mt-0.5">✓</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    onClick={() => purchase(level)}
                    disabled={busy === level || !canAfford}
                    className={`w-full btn py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                      owned ? 'btn-outline' : 'btn-primary'
                    }`}
                  >
                    {busy === level
                      ? 'Procesando…'
                      : !canAfford
                        ? `Te faltan ${fmtUsdt(price - realBalance)} USDT`
                        : owned
                          ? `Añadir ${cfg.duration} días`
                          : 'Activar plan'}
                  </button>
                </article>
              );
            })}
          </div>

          <p className="text-[10px] text-[#a0a0b0] mt-4 leading-relaxed">
            El rakeback se calcula solo sobre mesas cash normales y se paga en
            USDT a tu saldo retirable. La sala VIP Arena queda fuera porque su
            rake se reparte como profit share entre los participantes de la
            sala. Los torneos no generan rakeback porque no cobran rake por
            mano.
          </p>
        </>
      )}
    </div>
  );
}
