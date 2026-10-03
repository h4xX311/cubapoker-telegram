import React from 'react';

interface HomeProps {
  user: any;
  onNavigate: (page: 'home' | 'deposit' | 'withdraw' | 'game' | 'tournaments' | 'vip' | 'referrals' | 'achievements') => void;
}

export const Home: React.FC<HomeProps> = ({ user, onNavigate }) => {
  return (
    <div className="p-4 animate-fadeIn">
      {/* Header con gradiente */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] mb-4 shadow-lg">
          <span className="text-4xl">🃏</span>
        </div>
        <h1 className="text-3xl font-bold text-gradient mb-2">CubaPoker</h1>
        <p className="text-[#a0a0b0]">
          Bienvenido, <span className="text-white font-semibold">{user?.firstName || 'Jugador'}</span>
        </p>
      </div>

      {/* Balance Card con efecto glass */}
      <div className="glass rounded-2xl p-5 mb-6 animate-slideUp">
        <div className="flex items-center justify-between mb-4">
          <span className="text-[#a0a0b0] text-sm">Tu Balance</span>
          <span className="badge badge-success">Activo</span>
        </div>
        <div className="flex justify-between items-end">
          <div>
            <p className="text-4xl font-bold text-[#00d26a] mb-1">
              {user?.balance?.credits || 0}
              <span className="text-lg text-[#a0a0b0] ml-1">CUP</span>
            </p>
            <p className="text-sm text-[#a0a0b0]">
              ≈ {((user?.balance?.credits || 0) / 350).toFixed(2)} USDT
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-[#ffd700]">
              {user?.balance?.usdt?.toFixed(2) || '0.00'}
              <span className="text-sm text-[#a0a0b0] ml-1">USDT</span>
            </p>
          </div>
        </div>
      </div>

      {/* Actions Grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <button
          onClick={() => onNavigate('game')}
          className="card flex flex-col items-center justify-center p-6 hover:border-[#00d26a] transition-all"
        >
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mb-3 shadow-lg">
            <span className="text-2xl">🎮</span>
          </div>
          <span className="font-semibold text-white">Jugar</span>
          <span className="text-xs text-[#a0a0b0] mt-1">Texas Hold'em</span>
        </button>

        <button
          onClick={() => onNavigate('tournaments')}
          className="card flex flex-col items-center justify-center p-6 hover:border-[#ffd700] transition-all"
        >
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#ffd700] to-[#ffb700] flex items-center justify-center mb-3 shadow-lg">
            <span className="text-2xl">🏆</span>
          </div>
          <span className="font-semibold text-white">Torneos</span>
          <span className="text-xs text-[#a0a0b0] mt-1">Gana premios</span>
        </button>

        <button
          onClick={() => onNavigate('deposit')}
          className="card flex flex-col items-center justify-center p-6 hover:border-[#00d26a] transition-all"
        >
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#3498db] to-[#2980b9] flex items-center justify-center mb-3 shadow-lg">
            <span className="text-2xl">💰</span>
          </div>
          <span className="font-semibold text-white">Depositar</span>
          <span className="text-xs text-[#a0a0b0] mt-1">EnZona, QvaPay, USDT</span>
        </button>

        <button
          onClick={() => onNavigate('withdraw')}
          className="card flex flex-col items-center justify-center p-6 hover:border-[#ff4757] transition-all"
        >
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#ff4757] to-[#c0392b] flex items-center justify-center mb-3 shadow-lg">
            <span className="text-2xl">💸</span>
          </div>
          <span className="font-semibold text-white">Retirar</span>
          <span className="text-xs text-[#a0a0b0] mt-1">Retira tus ganancias</span>
        </button>
      </div>

      {/* Monetization Section */}
      <div className="mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Gana más con CubaPoker</h3>
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => onNavigate('vip')}
            className="card flex flex-col items-center p-4 hover:border-[#ffd700] transition-all"
          >
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#ffd700] to-[#ffb700] flex items-center justify-center mb-2">
              <span className="text-lg">👑</span>
            </div>
            <span className="text-xs font-semibold text-white">VIP</span>
            <span className="text-[10px] text-[#a0a0b0]">Rake reducido</span>
          </button>

          <button
            onClick={() => onNavigate('referrals')}
            className="card flex flex-col items-center p-4 hover:border-[#00d26a] transition-all"
          >
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mb-2">
              <span className="text-lg">👥</span>
            </div>
            <span className="text-xs font-semibold text-white">Referidos</span>
            <span className="text-[10px] text-[#a0a0b0]">Gana comisiones</span>
          </button>

          <button
            onClick={() => onNavigate('achievements')}
            className="card flex flex-col items-center p-4 hover:border-[#9b59b6] transition-all"
          >
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#9b59b6] to-[#8e44ad] flex items-center justify-center mb-2">
              <span className="text-lg">🏆</span>
            </div>
            <span className="text-xs font-semibold text-white">Logros</span>
            <span className="text-[10px] text-[#a0a0b0]">Recompensas</span>
          </button>
        </div>
      </div>

      {/* Payment Methods */}
      <div className="card mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Métodos de Pago</h3>
        <div className="flex justify-around">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mb-2 mx-auto">
              <span className="text-xl">🇨🇺</span>
            </div>
            <p className="text-xs text-[#a0a0b0]">EnZona</p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#3498db] to-[#2980b9] flex items-center justify-center mb-2 mx-auto">
              <span className="text-xl">💳</span>
            </div>
            <p className="text-xs text-[#a0a0b0]">QvaPay</p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#ffd700] to-[#ffb700] flex items-center justify-center mb-2 mx-auto">
              <span className="text-xl">₮</span>
            </div>
            <p className="text-xs text-[#a0a0b0]">USDT</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="card text-center p-4">
          <p className="text-2xl font-bold text-[#00d26a]">0</p>
          <p className="text-xs text-[#a0a0b0]">Jugadas</p>
        </div>
        <div className="card text-center p-4">
          <p className="text-2xl font-bold text-[#ffd700]">0</p>
          <p className="text-xs text-[#a0a0b0]">Ganadas</p>
        </div>
        <div className="card text-center p-4">
          <p className="text-2xl font-bold text-[#3498db]">0</p>
          <p className="text-xs text-[#a0a0b0]">Torneos</p>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-[#6c6c80] text-sm">
        <p>Powered by Blockchain</p>
        <p className="mt-1">Soporte: @CubaPokerSupport</p>
      </div>
    </div>
  );
};
