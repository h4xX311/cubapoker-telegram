import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { CashTier, TableSummary } from '../lib/types';
import { PageHeader, SectionLabel } from '../components/Layout';
import { fmtUsdt, fmtCup } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
  /** Tipo de cambio de referencia para mostrar el equivalente en CUP. */
  cupPerUsdt?: number;
}

export function Tables({
  user,
  onBack,
  onBalanceChange,
  onPlay,
  cupPerUsdt = 120,
}: Props) {
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [tiers, setTiers] = useState<CashTier[]>([]);
  const [seatsPerTable, setSeatsPerTable] = useState(7);
  const [disclosure, setDisclosure] = useState('');
  const [unlockRatio, setUnlockRatio] = useState('1:10');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [listRes, cfg] = await Promise.all([
        api.listTables(),
        api.gameConfig(),
      ]);
      setTables(listRes.tables || []);
      setTiers(cfg.cashTiers || []);
      if (cfg.seatsPerTable) setSeatsPerTable(cfg.seatsPerTable);
      if (cfg.prizeDisclosure) setDisclosure(cfg.prizeDisclosure);
      if (cfg.unlock?.ratioLabel) setUnlockRatio(cfg.unlock.ratioLabel);
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

  const register = async (tableId: string, tierId: string) => {
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

      <div
        className="rounded-2xl p-4 mb-5 flex items-center justify-between"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <div>
          <p className="text-[#a0a0b0] text-xs">Tu saldo</p>
          <p className="text-2xl font-bold text-[#00d26a]">{fmtUsdt(balance)} USDT</p>
          <p className="text-[10px] text-[#a0a0b0] mt-0.5">
            {fmtCup(balance, cupPerUsdt)} CUP
          </p>
        </div>
        <div className="text-right text-[10px] text-[#a0a0b0] leading-relaxed">
          <p>Retirable: {fmtUsdt(user?.balance?.real ?? 0)}</p>
          <p>Promoción: {fmtUsdt(user?.balance?.play ?? 0)}</p>
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
          <p className="text-xs text-[#a0a0b0]">Se abrirán en un momento.</p>
        </div>
      ) : (
        <>
          <SectionLabel>Elige tu nivel</SectionLabel>
          <div className="space-y-3">
            {tiers.map((tier, i) => {
              const fieldTables = tables.filter(t => t.tierId === tier.id);
              const registered = fieldTables.reduce((n, t) => n + t.occupied, 0);
              const canAfford = balance >= tier.buyIn;
              const pct = Math.min(
                100,
                Math.round((registered / tier.fieldSize) * 100),
              );

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
                        {tier.buyIn} USDT · {tier.stackInBigBlinds} BB · ciegas{' '}
                        {fmtUsdt(tier.blinds.small)}/{fmtUsdt(tier.blinds.big)}
                      </p>
                      <p className="text-[10px] text-[#6c6c80] mt-0.5">
                        {fmtCup(tier.buyIn, cupPerUsdt)} CUP · {tier.tables} mesas
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
                        1º lugar
                      </p>
                      <p className="text-lg font-bold text-[#ffd700] leading-none">
                        {fmtUsdt(tier.estFirstPrize)}
                      </p>
                      <p className="text-[9px] text-[#a0a0b0] mt-0.5">USDT</p>
                    </div>
                  </header>

                  {/* Inscripcion */}
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
                    <Metric label="Bote" value={fmtUsdt(tier.estNetPot)} unit="USDT" gold />
                    <Metric label="Rake" value={fmtUsdt(tier.estRake)} unit="USDT" />
                    <Metric label="Jugadores" value={String(tier.fieldSize)} />
                  </div>

                  {tier.payout.length > 0 && (
                    <div className="mb-3">
                      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide mb-1.5">
                        Reparto del bote
                      </p>
                      <div className="flex gap-1.5">
                        {tier.payout.map((e) => (
                          <div
                            key={e.position}
                            className="flex-1 text-center p-1.5 rounded-lg"
                            style={{ background: '#0f0f1a' }}
                          >
                            <p className="text-[9px] text-[#a0a0b0]">{e.position}º</p>
                            <p className="text-[11px] font-bold text-[#ffd700]">
                              {fmtUsdt(e.amount)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => register(fieldTables[0]?.tableId, tier.id)}
                    disabled={busy === tier.id || !fieldTables.length || !canAfford}
                    className="w-full btn btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy === tier.id
                      ? 'Registrando…'
                      : !canAfford
                      ? `Necesitas ${tier.buyIn} USDT`
                      : `Jugar · ${tier.buyIn} USDT`}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}

      {disclosure && (
        <div
          className="mt-5 rounded-2xl p-4"
          style={{ background: 'rgba(255,215,0,0.07)', border: '1px solid rgba(255,215,0,0.25)' }}
        >
          <div className="flex items-start gap-2.5">
            <span className="text-sm">💡</span>
            <p className="text-[11px] text-[#a0a0b0] leading-relaxed">{disclosure}</p>
          </div>
        </div>
      )}

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Cómo funciona:</span> cada campo es de{' '}
          {tiers[0]?.fieldSize ?? 300} jugadores repartidos en {seatsPerTable} mesas de{' '}
          {seatsPerTable}. Las mesas se fusionan mano a mano hasta que queda una mesa
          final, y el bote se reparte entre las primeras posiciones. Tu saldo de
          promoción se desbloquea {unlockRatio} al usarlo.
        </p>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  gold,
}: {
  label: string;
  value: string;
  unit?: string;
  gold?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-bold ${gold ? 'text-[#ffd700]' : 'text-white'}`}>
        {value}
        {unit && <span className="text-[9px] text-[#a0a0b0] ml-0.5">{unit}</span>}
      </p>
    </div>
  );
}
