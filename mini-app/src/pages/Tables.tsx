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
  const [seatsPerTable, setSeatsPerTable] = useState(7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [listRes, cfgRes] = await Promise.all([api.listTables(), api.gameConfig()]);
      setTables(listRes.tables || []);
      setTiers(cfgRes.cashTiers || []);
      if (cfgRes.seatsPerTable) setSeatsPerTable(cfgRes.seatsPerTable);
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

  const sit = async (tableId: string, tierId: string) => {
    if (!tableId) return;
    setBusy(tierId);
    setError('');
    try {
      await api.sit({ tableId });
      await onBalanceChange?.();
      onPlay(tableId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo entrar al campo.');
      setBusy(null);
    }
  };

  const balance = user?.balance?.total ?? 0;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Campos cash" onBack={onBack} />

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
      ) : tiers.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-4xl mb-3">🃏</div>
          <p className="text-sm text-white font-semibold mb-1">No hay campos abiertos</p>
          <p className="text-xs text-[#a0a0b0]">Se abriran en un momento.</p>
        </div>
      ) : (
        <>
          <SectionLabel>Elige tu campo</SectionLabel>
          <div className="space-y-3">
            {tiers.map((tier, i) => {
              // Mesas vivas de este campo. El backend agrupa por fieldId.
              const fieldTables = tables.filter(t => t.tierId === tier.id);
              const registered = fieldTables.reduce((n, t) => n + t.occupied, 0);
              const canAfford = balance >= tier.minBuyIn;
              const pct = Math.min(100, Math.round((registered / tier.fieldSize) * 100));

              return (
                <article
                  key={tier.id}
                  className="card animate-slideUp"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <header className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-bold text-white">{tier.label}</h3>
                      <p className="text-xs text-[#a0a0b0] mt-0.5">
                        {seatsPerTable}-max · {Math.ceil(tier.fieldSize / seatsPerTable)} mesas
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
                        Premio
                      </p>
                      <p className="text-lg font-bold text-[#ffd700]">
                        {tier.guaranteedPrize} CUP
                      </p>
                    </div>
                  </header>

                  {/* Inscripcion al campo */}
                  <div className="mb-3">
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="text-[#a0a0b0]">
                        Inscritos <strong className="text-white">{registered}</strong> /{' '}
                        {tier.fieldSize}
                      </span>
                      <span className="text-[#a0a0b0]">{pct}%</span>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                    <Metric label="Mesas" value={String(fieldTables.length)} />
                    <Metric label="Botín" value={String(tier.defaultBuyIn)} unit="CUP" />
                    <Metric label="Tu saldo" value={String(balance)} unit="CUP" gold />
                  </div>

                  {tier.payout && tier.payout.length > 0 && (
                    <div className="mb-3">
                      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide mb-1.5">
                        Reparto
                      </p>
                      <div className="flex gap-1.5">
                        {tier.payout.slice(0, 4).map((pctShare, idx) => (
                          <div
                            key={idx}
                            className="flex-1 text-center p-1.5 rounded-lg"
                            style={{ background: '#0f0f1a' }}
                          >
                            <p className="text-[9px] text-[#a0a0b0]">{idx + 1}º</p>
                            <p className="text-[11px] font-bold text-[#ffd700]">
                              {Math.floor((tier.guaranteedPrize * pctShare) / 100)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => sit(fieldTables[0]?.tableId, tier.id)}
                    disabled={busy === tier.id || !fieldTables.length || !canAfford}
                    className="w-full btn btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy === tier.id
                      ? 'Registrando…'
                      : !canAfford
                      ? `Necesitas ${tier.minBuyIn} CUP`
                      : `Participar · ${tier.defaultBuyIn} CUP`}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Cómo funciona:</span> un campo de{' '}
          {tiers[0]?.fieldSize ?? 500} participantes son{' '}
          {tiers[0] ? Math.ceil(tiers[0].fieldSize / seatsPerTable) : 72} mesas de{' '}
          {seatsPerTable}. Las mesas se fusionan mano a mano hasta que queda una
          mesa final, y el premio se reparte entre las primeras posiciones.
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
