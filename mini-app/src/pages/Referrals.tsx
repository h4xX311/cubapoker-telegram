import React, { useState, useEffect } from 'react';

interface ReferralsProps {
  user: any;
  onBack: () => void;
}

interface ReferralStats {
  totalReferrals: number;
  activeReferrals: number;
  totalCommission: number;
  referrals: any[];
}

export const Referrals: React.FC<ReferralsProps> = ({ user, onBack }) => {
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchReferralStats();
  }, []);

  const fetchReferralStats = async () => {
    try {
      const response = await fetch(`/api/monetization/referrals/${user?.id}`);
      const data = await response.json();
      if (data.success) {
        setStats(data);
      }
    } catch (error) {
      console.error('Error fetching referral stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const copyReferralLink = () => {
    const link = `https://t.me/CubaPokerBot?start=ref_${user?.id}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="p-4">
        <div className="flex items-center mb-6">
          <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
          <h1 className="text-xl font-bold text-[#ffd700]">👥 Referidos</h1>
        </div>
        <div className="text-center py-12">
          <div className="spinner mx-auto mb-4"></div>
          <p className="text-[#a0a0b0]">Cargando...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
        <h1 className="text-xl font-bold text-[#ffd700]">👥 Referidos</h1>
      </div>

      {/* Referral Link */}
      <div className="glass rounded-2xl p-5 mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Tu enlace de referido</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={`https://t.me/CubaPokerBot?start=ref_${user?.id}`}
            readOnly
            className="flex-1 bg-[#0f0f1a] border border-[#2a2a4a] rounded-xl px-4 py-3 text-white text-sm"
          />
          <button
            onClick={copyReferralLink}
            className={`btn ${copied ? 'btn-primary' : 'btn-outline'}`}
          >
            {copied ? '✓' : '📋'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="card text-center p-4">
          <p className="text-3xl font-bold text-[#00d26a]">{stats?.totalReferrals || 0}</p>
          <p className="text-xs text-[#a0a0b0]">Total</p>
        </div>
        <div className="card text-center p-4">
          <p className="text-3xl font-bold text-[#ffd700]">{stats?.activeReferrals || 0}</p>
          <p className="text-xs text-[#a0a0b0]">Activos</p>
        </div>
        <div className="card text-center p-4">
          <p className="text-3xl font-bold text-[#3498db]">{stats?.totalCommission || 0}</p>
          <p className="text-xs text-[#a0a0b0]">CUP ganados</p>
        </div>
      </div>

      {/* Commission Structure */}
      <div className="card mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-4">Estructura de comisiones</h3>
        <div className="space-y-3">
          <div className="flex justify-between items-center p-3 bg-[#0f0f1a] rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center">
                <span className="text-white font-bold">1</span>
              </div>
              <div>
                <p className="font-semibold text-white">Referidos directos</p>
                <p className="text-xs text-[#a0a0b0]">Tus invitados</p>
              </div>
            </div>
            <span className="text-xl font-bold text-[#00d26a]">10%</span>
          </div>

          <div className="flex justify-between items-center p-3 bg-[#0f0f1a] rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#3498db] to-[#2980b9] flex items-center justify-center">
                <span className="text-white font-bold">2</span>
              </div>
              <div>
                <p className="font-semibold text-white">Segundo nivel</p>
                <p className="text-xs text-[#a0a0b0]">Referidos de referidos</p>
              </div>
            </div>
            <span className="text-xl font-bold text-[#3498db]">5%</span>
          </div>

          <div className="flex justify-between items-center p-3 bg-[#0f0f1a] rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#9b59b6] to-[#8e44ad] flex items-center justify-center">
                <span className="text-white font-bold">3</span>
              </div>
              <div>
                <p className="font-semibold text-white">Tercer nivel</p>
                <p className="text-xs text-[#a0a0b0]">Red extendida</p>
              </div>
            </div>
            <span className="text-xl font-bold text-[#9b59b6]">2%</span>
          </div>
        </div>
      </div>

      {/* Referral List */}
      {stats && stats.referrals.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-[#a0a0b0] text-sm mb-4">Tus referidos</h3>
          <div className="space-y-2">
            {stats.referrals.slice(0, 10).map((referral, index) => (
              <div key={index} className="flex justify-between items-center p-3 bg-[#0f0f1a] rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center text-white text-sm font-bold">
                    {referral.level}
                  </div>
                  <div>
                    <p className="font-semibold text-white">Usuario #{referral.referredId}</p>
                    <p className="text-xs text-[#a0a0b0]">Nivel {referral.level}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[#00d26a] font-bold">{referral.commission} CUP</p>
                  <p className="text-xs text-[#a0a0b0]">{referral.totalRake} CUP rake</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="card">
        <h3 className="text-[#a0a0b0] text-sm mb-3">¿Cómo funciona?</h3>
        <ol className="text-sm text-[#a0a0b0] space-y-2">
          <li className="flex gap-2">
            <span className="text-[#00d26a] font-bold">1.</span>
            Comparte tu enlace de referido
          </li>
          <li className="flex gap-2">
            <span className="text-[#00d26a] font-bold">2.</span>
            Tus amigos se registran y juegan
          </li>
          <li className="flex gap-2">
            <span className="text-[#00d26a] font-bold">3.</span>
            Ganas comisiones por cada mano que jueguen
          </li>
          <li className="flex gap-2">
            <span className="text-[#00d26a] font-bold">4.</span>
            Retira tus comisiones cuando quieras
          </li>
        </ol>
      </div>
    </div>
  );
};
