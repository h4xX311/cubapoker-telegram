import React, { useState, useEffect } from 'react';

interface VIPProps {
  user: any;
  onBack: () => void;
}

interface VIPConfig {
  name: string;
  price: number;
  duration: number;
  rakeDiscount: number;
  tournamentDiscount: number;
  benefits: string[];
}

export const VIP: React.FC<VIPProps> = ({ user, onBack }) => {
  const [vipLevel, setVipLevel] = useState<string | null>(null);
  const [configs, setConfigs] = useState<Record<string, VIPConfig>>({});
  const [loading, setLoading] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);

  useEffect(() => {
    fetchVIPData();
  }, []);

  const fetchVIPData = async () => {
    try {
      const [levelRes, configRes] = await Promise.all([
        fetch(`/api/monetization/vip/${user?.id}`),
        fetch('/api/monetization/vip/config'),
      ]);

      const levelData = await levelRes.json();
      const configData = await configRes.json();

      if (levelData.success) {
        setVipLevel(levelData.level);
      }
      if (configData.success) {
        setConfigs(configData.config);
      }
    } catch (error) {
      console.error('Error fetching VIP data:', error);
    }
  };

  const purchaseVIP = async (level: string) => {
    setPurchasing(level);
    try {
      const response = await fetch('/api/monetization/vip/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramId: user?.id, level }),
      });

      const data = await response.json();
      if (data.success) {
        alert('¡VIP comprado exitosamente!');
        fetchVIPData();
      } else {
        alert(data.error || 'Error al comprar VIP');
      }
    } catch (error) {
      console.error('Error purchasing VIP:', error);
    } finally {
      setPurchasing(null);
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'basic': return 'from-blue-500 to-blue-600';
      case 'premium': return 'from-yellow-500 to-yellow-600';
      case 'elite': return 'from-purple-500 to-purple-600';
      default: return 'from-gray-500 to-gray-600';
    }
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'basic': return '🥉';
      case 'premium': return '🥈';
      case 'elite': return '🥇';
      default: return '👑';
    }
  };

  return (
    <div className="p-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
        <h1 className="text-xl font-bold text-[#ffd700]">👑 VIP</h1>
      </div>

      {/* Current VIP Status */}
      {vipLevel && (
        <div className="glass rounded-2xl p-5 mb-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-3xl">{getLevelIcon(vipLevel)}</span>
            <div>
              <p className="text-[#a0a0b0] text-sm">Tu nivel actual</p>
              <p className="text-xl font-bold text-white">{configs[vipLevel]?.name}</p>
            </div>
          </div>
          <div className="badge badge-success">Activo</div>
        </div>
      )}

      {/* VIP Plans */}
      <div className="space-y-4">
        {Object.entries(configs).map(([level, config]) => (
          <div
            key={level}
            className={`card relative overflow-hidden ${
              vipLevel === level ? 'border-2 border-[#ffd700]' : ''
            }`}
          >
            {/* Level Badge */}
            <div className={`absolute top-0 right-0 w-20 h-20 bg-gradient-to-br ${getLevelColor(level)} rounded-bl-full flex items-center justify-center`}>
              <span className="text-2xl">{getLevelIcon(level)}</span>
            </div>

            <div className="pr-16">
              <h3 className="text-xl font-bold text-white mb-1">{config.name}</h3>
              <p className="text-2xl font-bold text-[#ffd700] mb-3">
                {config.price} CUP<span className="text-sm text-[#a0a0b0]">/mes</span>
              </p>

              <div className="space-y-2 mb-4">
                {config.benefits.map((benefit, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="text-[#00d26a]">✓</span>
                    <span className="text-sm text-[#a0a0b0]">{benefit}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => purchaseVIP(level)}
                disabled={purchasing === level || vipLevel === level || (user?.balance?.credits || 0) < config.price}
                className={`w-full btn ${
                  vipLevel === level
                    ? 'bg-gray-600 cursor-not-allowed'
                    : 'btn-primary'
                }`}
              >
                {purchasing === level
                  ? 'Procesando...'
                  : vipLevel === level
                  ? 'Ya tienes este nivel'
                  : (user?.balance?.credits || 0) < config.price
                  ? 'Balance insuficiente'
                  : 'Comprar'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Info */}
      <div className="mt-6 card">
        <h3 className="text-[#a0a0b0] text-sm mb-3">¿Por qué ser VIP?</h3>
        <ul className="text-sm text-[#a0a0b0] space-y-2">
          <li>• <strong className="text-white">Rake reducido:</strong> Paga menos comisión por mano</li>
          <li>• <strong className="text-white">Torneos exclusivos:</strong> Accede a torneos con mejores premios</li>
          <li>• <strong className="text-white">Badge especial:</strong> Destaca entre otros jugadores</li>
          <li>• <strong className="text-white">Soporte prioritario:</strong> Atención personalizada</li>
        </ul>
      </div>
    </div>
  );
};
