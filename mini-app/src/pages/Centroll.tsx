import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader } from '../components/Layout';
import { fmtUsdt, fmtCup } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
  cupPerUsdt?: number;
}

/**
 * Centroll: buy-in de pago, premio en fichas de promocion.
 *
 * Es la pieza que hace el freeroll sostenible: por 1 USDT el jugador entra en
 * un campo de 100 y compite por 30 USDT de fichas. El operador cobra entrada
 * y paga fichas; el jugador compra con dinero real lo que en el freeroll
 * ganaba gratis.
 *
 * Modelo de CoinPoker: "CoinPoker Centrolls: $0.01 Buy-Ins... require you to
 * have a real money balance of at least $0.01".
 */
export function Centroll({
  user,
  onBack,
  onBalanceChange,
  onPlay,
  cupPerUsdt = 120,
}: Props) {
  const [info, setInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await api.centroll();
      setInfo(res);
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, []);

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.joinCentroll();
      await onBalanceChange?.();
      if (res.tableId) onPlay(res.tableId);
      else await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo entrar al centroll.',
      );
    } finally {
      setBusy(false);
    }
  };

  const real = user?.balance?.real ?? 0;
  const canAfford = real >= (info?.buyIn ?? 1);
  const registered = info?.registered ?? 0;
  const target = info?.targetField ?? 100;
  const pct = Math.min(100, Math.round((registered / target) * 100));

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Centroll" onBack={onBack} />

      {/* Que es y por que existe */}
      <div
        className="rounded-2xl p-4 mb-5"
        style={{
          background: 'rgba(230,126,34,0.1)',
          border: '1px solid rgba(230,126,34,0.35)',
        }}
      >
        <div className="flex items-start gap-3">
          <span className="text-xl">⚡</span>
          <div>
            <p className="text-sm font-bold text-[#e67e22] mb-1">
              Entrada de pago, premio en fichas
            </p>
            <p className="text-xs text-[#a0a0b0] leading-relaxed">
              Pagas {fmtUsdt(info?.buyIn ?? 1)} USDT de tu saldo real y compites en
              un campo de {target} jugadores. El premio son fichas de promoción:
              sirven para jugar en cualquier campo y desbloquean{' '}
              <strong className="text-white">1 de cada 10</strong> a saldo
              retirable, pero no se retiran directo.
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
        <>
          {/* Bote y premio */}
          <div className="card mb-4">
            <div className="grid grid-cols-2 gap-3 text-center mb-3">
              <div>
                <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
                  Bote del campo
                </p>
                <p className="text-xl font-bold text-white">
                  {fmtUsdt(info?.potUsdt ?? 0)}
                </p>
                <p className="text-[9px] text-[#a0a0b0]">USDT</p>
              </div>
              <div>
                <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
                  Premio en fichas
                </p>
                <p className="text-xl font-bold text-[#ffd700]">
                  {fmtUsdt(info?.prizeUsdt ?? 0)}
                </p>
                <p className="text-[9px] text-[#a0a0b0]">
                  {info?.prizeMultiplier}x la entrada
                </p>
              </div>
            </div>

            {/* Reparto por posicion */}
            {info?.payout && (
              <div className="flex gap-2">
                {info.payout.map((p: any) => (
                  <div
                    key={p.position}
                    className="flex-1 text-center p-2 rounded-xl"
                    style={{ background: '#0f0f1a' }}
                  >
                    <p className="text-[9px] text-[#a0a0b0]">{p.position}º</p>
                    <p className="text-sm font-bold text-[#ffd700]">
                      {fmtUsdt(p.amountUsdt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Progreso */}
          <div className="card mb-4">
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-[#a0a0b0]">
                Inscritos <strong className="text-white">{registered}</strong> / {target}
              </span>
              <span className="text-[#a0a0b0]">{pct}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[10px] text-[#6c6c80] mt-2">
              Arranca al completarse. {info?.queueLength ?? 0} en cola. Hasta{' '}
              {info?.maxRebuys ?? 0} reentradas.
            </p>
          </div>

          <button
            onClick={join}
            disabled={busy || !canAfford}
            className="w-full btn btn-primary py-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy
              ? 'Entrando…'
              : !canAfford
              ? `Necesitas ${fmtUsdt(info?.buyIn ?? 1)} USDT reales`
              : `Entrar · ${fmtUsdt(info?.buyIn ?? 1)} USDT (${fmtCup(
                  info?.buyInCup ?? 120,
                  cupPerUsdt,
                )} CUP)`}
          </button>

          {/* Por que exige saldo real */}
          <div className="mt-5 card">
            <p className="text-xs text-[#a0a0b0] leading-relaxed">
              <span className="text-white font-semibold">Por qué saldo real:</span> el
              centroll solo acepta saldo retirable, igual que en CoinPoker. El saldo
              de promoción sirve para jugar, no para comprar entradas: si pudiera,
              un jugador podría conseguir fichas jugando al centroll, gastarlas en
              otra entrada y convertirlas poco a poco en saldo retirable, y el
              freeroll dejaría de ser un giveaway.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
