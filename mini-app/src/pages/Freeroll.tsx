import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { FreerollSummary } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { fmtUsdt } from '../components/Balance';

interface Props {
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
  120?: number;
}

/**
 * Freerolls: entrada gratis, premio en saldo de promocion.
 *
 * No recibe `user` porque la pantalla no muestra saldo: la unica accion es
 * apuntarse, y el estado de la cuenta ya esta en la cabecera.
 */
export function Freeroll({
  onBack,
  onBalanceChange,
  onPlay,
}: Props) {
  const [freerolls, setFreerolls] = useState<FreerollSummary[]>([]);
  const [targetField, setTargetField] = useState(300);
  const [maxField, setMaxField] = useState(900);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await api.freerolls();
      setFreerolls(res.freerolls || []);
      if (res.targetField) setTargetField(res.targetField);
      if (res.maxField) setMaxField(res.maxField);
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
      setError(
        err instanceof ApiError ? err.message : 'No se pudo entrar al freeroll.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Freerolls" onBack={onBack} />

      {/* El mecanismo del ratio. Sin esto el jugador no entiende su saldo. */}
      <div
        className="rounded-2xl p-4 mb-5"
        style={{
          background: 'rgba(255,215,0,0.08)',
          border: '1px solid rgba(255,215,0,0.3)',
        }}
      >
        <div className="flex items-start gap-3">
          <span className="text-xl">🎁</span>
          <div>
            <p className="text-sm font-bold text-[#ffd700] mb-1">
              Entrada gratis, premio en saldo de promoción
            </p>
            <p className="text-xs text-[#a0a0b0] leading-relaxed">
              No pagas nada por entrar. Lo que ganas es saldo de promoción: sirve
              para jugar en cualquier campo, y al usarlo se desbloquea{' '}
              <strong className="text-white">1 de cada 10</strong> a saldo
              retirable. El resto se consume jugando.
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
            const target = f.fieldTarget || targetField;
            const isFull = f.players >= target;
            const pct = Math.min(100, Math.round((f.players / target) * 100));

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
                      <span>🎁</span> Freeroll {fmtUsdt(f.prizeTier)} USDT
                    </h3>
                    <p className="text-xs text-[#a0a0b0] mt-1"> USDT de premio · sin buy-in
                    </p>
                  </div>
                  <span className="badge badge-warning text-[10px]">
                    {isFull ? 'Cerrado' : f.phase === 'running' ? 'En curso' : 'Abierto'}
                  </span>
                </header>

                {/* Progreso de inscripcion */}
                <div className="mb-3 relative">
                  <div className="flex justify-between text-[10px] mb-1">
                    <span className="text-[#a0a0b0]">
                      Campo: <strong className="text-white">{f.players}</strong> de {target}
                    </span>
                    <span className="text-[#a0a0b0]">{pct}%</span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${pct}%`, background: '#ffd700' }}
                    />
                  </div>
                  <p className="text-[10px] text-[#6c6c80] mt-1">
                    Arranca al completarse. Tope de {maxField} inscritos.
                  </p>
                </div>

                {/* Reparto */}
                <div className="flex gap-2 mb-3 relative">
                  {f.payout.map((pctShare, idx) => (
                    <div
                      key={idx}
                      className="flex-1 text-center p-2 rounded-xl"
                      style={{ background: '#0f0f1a' }}
                    >
                      <p className="text-[9px] text-[#a0a0b0]">
                        {['1º', '2º', '3º'][idx] ?? `${idx + 1}º`}
                      </p>
                      <p className="text-sm font-bold text-[#ffd700]">
                        {fmtUsdt(Math.floor((f.pot * pctShare) / 100))}
                      </p>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => join(f)}
                  disabled={busy === f.prizeTier || isFull}
                  className="w-full btn btn-gold py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed relative"
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
    </div>
  );
}
