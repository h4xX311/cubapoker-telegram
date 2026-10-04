import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { CashTier, TableSummary } from '../lib/types';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
}

export function Tables({ user, onBack, onBalanceChange, onPlay }: Props) {
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [tiers, setTiers] = useState<CashTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [listRes, cfgRes] = await Promise.all([api.listTables(), api.gameConfig()]);
      setTables(listRes.tables || []);
      setTiers(cfgRes.cashTiers || []);
    } catch {
      setTables([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const sit = async (tableId: string) => {
    setBusy(tableId);
    setError('');
    try {
      await api.sit({ tableId });
      await onBalanceChange?.();
      onPlay(tableId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo entrar a la mesa.');
      setBusy(null);
    }
  };

  const balance = user?.balance?.total ?? 0;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Mesas cash" onBack={onBack} />

      {/* Saldo */}
      <div
        className="rounded-2xl p-4 mb-5 flex items-center justify-between"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <div>
          <p className="text-[#a0a0b0] text-xs">Tu saldo total</p>
          <p className="text-2xl font-bold text-[#00d26a]">{balance} CUP</p>
        </div>
        <div className="text-right text-[10px] text-[#a0a0b0] leading-relaxed">
          <p>Real: {user?.balance?.real ?? 0}</p>
          <p>Promo: {user?.balance?.play ?? 0}</p>
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
      ) : tables.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-4xl mb-3">🃏</div>
          <p className="text-sm text-white font-semibold mb-1">No hay mesas abiertas</p>
          <p className="text-xs text-[#a0a0b0]">Se abriran en un momento.</p>
        </div>
      ) : (
        <>
          {tiers.length > 0 && <SectionLabel>Elige tu mesa</SectionLabel>}
          <div className="space-y-3">
            {tables.map((t, i) => {
              const tier = tiers.find(x => x.id === t.tierId);
              const full = t.occupied >= t.maxSeats;
              const canAfford = balance >= t.minBuyIn;
              const occupancy = Math.round((t.occupied / t.maxSeats) * 100);

              return (
                <article
                  key={t.tableId}
                  className="card animate-slideUp"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <header className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-bold text-white">
                        {tier?.label ?? `Mesa ${t.maxSeats}`}
                      </h3>
                      <p className="text-xs text-[#a0a0b0]">
                        Ciegas {t.smallBlind}/{t.bigBlind} · mín. {t.minBuyIn} CUP
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
                        Premio
                      </p>
                      <p className="text-lg font-bold text-[#ffd700]">
                        {t.guaranteedPrize} CUP
                      </p>
                    </div>
                  </header>

                  <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                    <Metric label="Ocupación" value={`${t.occupied}/${t.maxSeats}`} />
                    <Metric label="Bots" value={String(t.bots)} />
                    <Metric label="Bote" value={String(t.pot)} unit="CUP" gold />
                  </div>

                  <div className="progress-bar mb-3">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${Math.min(100, occupancy)}%` }}
                    />
                  </div>

                  <button
                    onClick={() => sit(t.tableId)}
                    disabled={busy === t.tableId || full || !canAfford}
                    className="w-full btn btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy === t.tableId
                      ? 'Sentando…'
                      : full
                      ? 'Mesa llena'
                      : !canAfford
                      ? `Necesitas ${t.minBuyIn} CUP`
                      : `Sentarse · ${tier?.defaultBuyIn ?? t.minBuyIn} CUP`}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Premio garantizado:</span> se
          entrega al ganador de la mesa completa. El rake del 5% se descuenta del
          bote de cada mano.
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value, unit, gold }: { label: string; value: string; unit?: string; gold?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-bold ${gold ? 'text-[#ffd700]' : 'text-white'}`}>
        {value}
        {unit && <span className="text-[10px] text-[#a0a0b0] ml-0.5">{unit}</span>}
      </p>
    </div>
  );
}
