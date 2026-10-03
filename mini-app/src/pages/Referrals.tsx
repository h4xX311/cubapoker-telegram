import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
}

const TIERS = [
  { level: 1, rate: '10%', label: 'Directos', color: '#00d26a' },
  { level: 2, rate: '5%', label: 'Segundo nivel', color: '#3498db' },
  { level: 3, rate: '2%', label: 'Tercer nivel', color: '#9b59b6' },
];

export function Referrals({ user, onBack }: Props) {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const link = `https://t.me/CubaPokerBot?start=ref_${user?.telegramId ?? ''}`;

  useEffect(() => {
    (async () => {
      try {
        const res = await api.referrals();
        setStats(res);
      } catch {
        setStats({ totalReferrals: 0, activeReferrals: 0, totalCommission: 0, referrals: [] });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Referidos" onBack={onBack} />

      {/* Enlace */}
      <div className="rounded-2xl p-4 mb-5" style={{ background: '#16213e', border: '1px solid #2a2a4a' }}>
        <SectionLabel>Tu enlace</SectionLabel>
        <div className="flex gap-2">
          <input
            readOnly
            value={link}
            className="input flex-1 text-xs font-mono"
            onFocus={e => e.currentTarget.select()}
            aria-label="Tu enlace de referido"
          />
          <button onClick={copy} className={`btn px-4 ${copied ? 'btn-primary' : 'btn-outline'}`}>
            {copied ? '✓' : 'Copiar'}
          </button>
        </div>
        <p className="text-[10px] text-[#a0a0b0] mt-2">
          Ganas 50 CUP de bienvenida por cada amigo que se registra.
        </p>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-3 gap-2 mb-5">
        <Metric label="Total" value={stats?.totalReferrals ?? 0} color="#ffffff" />
        <Metric label="Activos" value={stats?.activeReferrals ?? 0} color="#ffd700" />
        <Metric label="Ganado" value={stats?.totalCommission ?? 0} unit="CUP" color="#00d26a" />
      </div>

      {/* Estructura */}
      <SectionLabel>Estructura de comisiones</SectionLabel>
      <div className="card mb-5">
        <div className="space-y-3">
          {TIERS.map(tier => (
            <div key={tier.level} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                  style={{ background: tier.color }}
                >
                  {tier.level}
                </div>
                <span className="text-sm text-white">{tier.label}</span>
              </div>
              <span className="text-lg font-bold" style={{ color: tier.color }}>
                {tier.rate}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-[#a0a0b0] mt-4 pt-3 border-t border-[#2a2a4a]">
          Las comisiones se calculan sobre el rake generado por tus referidos y se
          abonan a tu saldo automáticamente.
        </p>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="text-center py-8">
          <div className="spinner mx-auto" />
        </div>
      ) : stats?.referrals?.length > 0 ? (
        <>
          <SectionLabel>Tus referidos</SectionLabel>
          <div className="space-y-2">
            {stats.referrals.slice(0, 10).map((r: any, i: number) => (
              <div
                key={i}
                className="rounded-xl p-3 flex items-center justify-between"
                style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-[#0f3460] flex items-center justify-center text-xs font-bold text-white">
                    {r.level}
                  </div>
                  <span className="text-sm text-white">Nivel {r.level}</span>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-[#00d26a]">{r.commission} CUP</p>
                  <p className="text-[10px] text-[#a0a0b0]">{r.totalRake} CUP rake</p>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="card text-center py-8">
          <div className="text-3xl mb-2">👥</div>
          <p className="text-sm text-white font-semibold mb-1">Aún sin referidos</p>
          <p className="text-xs text-[#a0a0b0]">
            Comparte tu enlace. Empiezas a ganar en cuanto jueguen.
          </p>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, unit, color }: { label: string; value: number; unit?: string; color: string }) {
  return (
    <div className="card text-center p-3">
      <p className="text-2xl font-bold" style={{ color }}>
        {value}
      </p>
      <p className="text-[10px] text-[#a0a0b0]">
        {label}
        {unit && ` (${unit})`}
      </p>
    </div>
  );
}
