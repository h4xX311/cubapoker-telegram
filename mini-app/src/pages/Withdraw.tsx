import React, { useState } from 'react';

interface WithdrawProps {
  user: any;
  onBack: () => void;
}

export const Withdraw: React.FC<WithdrawProps> = ({ user, onBack }) => {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'enzona' | 'qvapay' | 'usdt'>('enzona');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleWithdraw = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: user?.id,
          amount: parseFloat(amount),
          method,
          address: method === 'usdt' ? address : undefined,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setSuccess(true);
      }
    } catch (error) {
      console.error('Withdraw error:', error);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="p-4 text-center animate-fadeIn">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mx-auto mb-4">
          <span className="text-4xl">✅</span>
        </div>
        <h2 className="text-2xl font-bold text-[#00d26a] mb-2">¡Retiro Exitoso!</h2>
        <p className="text-[#a0a0b0] mb-6">Tu retiro ha sido procesado</p>
        <button onClick={onBack} className="w-full btn btn-primary">
          Volver al Inicio
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
        <h1 className="text-xl font-bold text-[#ffd700]">💸 Retirar</h1>
      </div>

      {/* Balance */}
      <div className="glass rounded-2xl p-5 mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-2">Balance Disponible</h3>
        <p className="text-3xl font-bold text-[#00d26a]">
          {user?.balance?.credits || 0} CUP
        </p>
      </div>

      {/* Payment Method */}
      <div className="mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Método de Retiro</h3>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setMethod('enzona')}
            className={`card flex flex-col items-center p-4 transition-all ${
              method === 'enzona' ? 'border-[#00d26a] bg-[#00d26a]/10' : ''
            }`}
          >
            <span className="text-2xl mb-2">🇨🇺</span>
            <span className="text-sm font-semibold">EnZona</span>
          </button>
          <button
            onClick={() => setMethod('qvapay')}
            className={`card flex flex-col items-center p-4 transition-all ${
              method === 'qvapay' ? 'border-[#00d26a] bg-[#00d26a]/10' : ''
            }`}
          >
            <span className="text-2xl mb-2">💳</span>
            <span className="text-sm font-semibold">QvaPay</span>
          </button>
          <button
            onClick={() => setMethod('usdt')}
            className={`card flex flex-col items-center p-4 transition-all ${
              method === 'usdt' ? 'border-[#00d26a] bg-[#00d26a]/10' : ''
            }`}
          >
            <span className="text-2xl mb-2">₮</span>
            <span className="text-sm font-semibold">USDT</span>
          </button>
        </div>
      </div>

      {/* Amount */}
      <div className="mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Monto (CUP)</h3>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="1000"
          max={user?.balance?.credits}
          className="input text-lg"
        />
        <button
          onClick={() => setAmount(user?.balance?.credits?.toString() || '0')}
          className="text-sm text-[#00d26a] mt-2"
        >
          Retirar todo
        </button>
      </div>

      {/* USDT Address */}
      {method === 'usdt' && (
        <div className="mb-6">
          <h3 className="text-[#a0a0b0] text-sm mb-3">Dirección USDT (TRC20)</h3>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="T..."
            className="input"
          />
        </div>
      )}

      {/* Withdraw Button */}
      <button
        onClick={handleWithdraw}
        disabled={loading || !amount || (method === 'usdt' && !address)}
        className="w-full btn btn-primary text-lg"
      >
        {loading ? 'Procesando...' : 'Retirar'}
      </button>

      {/* Info */}
      <div className="mt-6 card">
        <h3 className="text-[#a0a0b0] text-sm mb-2">Información</h3>
        <ul className="text-sm text-[#a0a0b0] space-y-1">
          <li>• Los retiros se procesan en 24-48 horas</li>
          <li>• USDT: Retiros automáticos en TRC20</li>
          <li>• EnZona/QvaPay: Verificación manual</li>
        </ul>
      </div>
    </div>
  );
};
