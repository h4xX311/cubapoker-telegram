import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { FreerollSummary } from '../lib/types';
import { PageHeader } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
}

export function Freeroll({ onBack, onBalanceChange, onPlay }: Props) {
  const [freerolls, setFreerolls] = useState<FreerollSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await api.freerolls();
      setFreerolls(res.freerolls || []);
    } catch {
      setFreerolls([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, []);

  const join = async (tier: FreerollSummary) => {
    setBusy(tier.prizeTier);
    setError('');
    try {
      const res = await api.joinFreeroll(tier.prizeTier, tier.tableId);
      await onBalanceChange?.();
      if (res.tableId) onPlay(res.tableId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo entrar al freeroll.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Freerolls" onBack={onBack} />

      {/* Aviso de saldo no retirable */}
      <div
        className="rounded-2xl p-4 mb-5"
        style={{ background: 'rgba(255,215,0,0.08)', border: '1px solid rgba(255,215,0,0.3)' }}
      >
        <div className="flex items-start gap-3">
          <span className="text-xl">⚠️</span>
          <div>
            <p className="text-sm font-bold text-[#ffd700] mb-1">
              El saldo que ganes aquí no se puede retirar
            </p>
            <p className="text-xs text-[#a0a0b0] leading-relaxed">
              Los premios de freeroll son CUP de promoción. Sirven para jugar en
              cualquier mesa cash de CubaPoker, pero para retirar dinero necesitas
              depositar con EnZona, QvaPay o USDT.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto" />
        </div>
      ) : (
        <div className="space-y-3">
          {freerolls.map((f, i) => {
            const payout = f.payout ?? [50, 30, 20];
            const isFull = f.players >= f.maxPlayers;

            return (
              <article
                key={f.prizeTier}
                className="card relative overflow-hidden animate-slideUp"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div
                  className="absolute -top-8 -right-8 w-28 h-28 rounded-full opacity-15"
                  style={{ background: '#ffd700' }}
                />

                <header className="flex items-start justify-between mb-3 relative">
                  <div>
                    <h3 className="font-bold text-white flex items-center gap-2">
                      <span>🎁</span> Freeroll {f.prizeTier} CUP
                    </h3>
                    <p className="text-xs text-[#a0a0b0] mt-1">
                      Sin buy-in · {f.players}/{f.maxPlayers} jugadores
                    </p>
                  </div>
                  <span className="badge badge-warning text-[10px]">
                    {isFull ? 'Completo' : f.phase === 'running' ? 'En curso' : 'Abierto'}
                  </span>
                </header>

                {/* Reparto */}
                <div className="flex gap-2 mb-3">
                  {payout.map((pct, idx) => (
                    <div
                      key={idx}
                      className="flex-1 text-center p-2 rounded-xl"
                      style={{ background: '#0f0f1a' }}
                    >
                      <p className="text-[10px] text-[#a0a0b0]">
                        {['1º', '2º', '3º'][idx] ?? `${idx + 1}º`}
                      </p>
                      <p className="text-sm font-bold text-[#ffd700]">
                        {Math.floor((f.pot * pct) / 100)}
                      </p>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => join(f)}
                  disabled={busy === f.prizeTier || isFull}
                  className="w-full btn btn-gold py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy === f.prizeTier
                    ? 'Registrando…'
                    : isFull
                    ? 'Completo'
                    : 'Participar gratis'}
                </button>
              </article>
            );
          })}
        </div>
      )}

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Sin buy-in:</span> no pagas para
          entrar. Si ganas, el premio va directo a tu saldo de promoción y ya puedes
          usarlo en las mesas cash.
        </p>
      </div>
    </div>
  );
}
