import React, { useState } from 'react';

interface DepositProps {
  user: any;
  onBack: () => void;
}

export const Deposit: React.FC<DepositProps> = ({ user, onBack }) => {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'enzona' | 'qvapay' | 'usdt'>('enzona');
  const [network, setNetwork] = useState<'TRC20' | 'ERC20' | 'BEP20'>('TRC20');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleDeposit = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: user?.id,
          amount: parseFloat(amount),
          method,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setSuccess(true);
      }
    } catch (error) {
      console.error('Deposit error:', error);
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
        <h2 className="text-2xl font-bold text-[#00d26a] mb-2">¡Depósito Exitoso!</h2>
        <p className="text-[#a0a0b0] mb-6">Tu balance ha sido actualizado</p>
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
        <h1 className="text-xl font-bold text-[#ffd700]">💰 Depositar</h1>
      </div>

      {/* Payment Method */}
      <div className="mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Método de Pago</h3>
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

      {/* Network Selection (solo USDT) */}
      {method === 'usdt' && (
        <div className="mb-6">
          <h3 className="text-[#a0a0b0] text-sm mb-3">Red</h3>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setNetwork('TRC20')}
              className={`card p-3 text-center transition-all ${
                network === 'TRC20' ? 'border-[#00d26a] bg-[#00d26a]/10' : ''
              }`}
            >
              <p className="font-semibold text-sm">TRC20</p>
              <p className="text-xs text-[#a0a0b0]">Tron</p>
            </button>
            <button
              onClick={() => setNetwork('ERC20')}
              className={`card p-3 text-center transition-all ${
                network === 'ERC20' ? 'border-[#00d26a] bg-[#00d26a]/10' : ''
              }`}
            >
              <p className="font-semibold text-sm">ERC20</p>
              <p className="text-xs text-[#a0a0b0]">Ethereum</p>
            </button>
            <button
              onClick={() => setNetwork('BEP20')}
              className={`card p-3 text-center transition-all ${
                network === 'BEP20' ? 'border-[#00d26a] bg-[#00d26a]/10' : ''
              }`}
            >
              <p className="font-semibold text-sm">BEP20</p>
              <p className="text-xs text-[#a0a0b0]">BSC</p>
            </button>
          </div>
        </div>
      )}

      {/* Amount */}
      <div className="mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">
          Monto ({method === 'usdt' ? 'USDT' : 'CUP'})
        </h3>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={method === 'usdt' ? '10.00' : '1000'}
          className="input text-lg"
        />
        {method === 'usdt' && amount && (
          <p className="text-sm text-[#a0a0b0] mt-2">
            ≈ {parseFloat(amount || '0') * 350} CUP
          </p>
        )}
      </div>

      {/* Quick Amounts */}
      <div className="mb-6">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Montos Rápidos</h3>
        <div className="grid grid-cols-3 gap-2">
          {(method === 'usdt' ? [5, 10, 25, 50, 100, 200] : [500, 1000, 2500, 5000, 10000, 25000]).map((value) => (
            <button
              key={value}
              onClick={() => setAmount(value.toString())}
              className="card p-3 text-center hover:border-[#00d26a] transition-all"
            >
              <span className="font-semibold">{value}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Deposit Button */}
      <button
        onClick={handleDeposit}
        disabled={loading || !amount}
        className="w-full btn btn-primary text-lg"
      >
        {loading ? 'Procesando...' : 'Depositar'}
      </button>

      {/* Info */}
      <div className="mt-6 card">
        <h3 className="text-[#a0a0b0] text-sm mb-2">Información</h3>
        <ul className="text-sm text-[#a0a0b0] space-y-1">
          <li>• EnZona: Pagos móviles cubanos</li>
          <li>• QvaPay: Pagos online</li>
          <li>• USDT: TRC20 (Tron) - Recomendado</li>
        </ul>
      </div>
    </div>
  );
};
