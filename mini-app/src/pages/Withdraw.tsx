import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader, SectionLabel } from './Deposit';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

type Method = 'enzona' | 'qvapay' | 'usdt';

const METHODS: { id: Method; flag: string; name: string; rate: string }[] = [
  { id: 'enzona', flag: '🇨🇺', name: 'EnZona', rate: '3% comisión' },
  { id: 'qvapay', flag: '💳', name: 'QvaPay', rate: '3% comisión' },
  { id: 'usdt', flag: '₮', name: 'USDT', rate: '1% comisión' },
];

const MINIMUMS: Record<Method, number> = { enzona: 1000, qvapay: 1000, usdt: 10 };

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function Withdraw({ user, onBack, onBalanceChange }: Props) {
  const [method, setMethod] = useState<Method>('enzona');
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const balance = user?.balance?.credits ?? 0;
  const numericAmount = Number(amount) || 0;
  const minimum = MINIMUMS[method];

  const invalidAddress = method === 'usdt' && address.length > 0 && !TRON_ADDRESS.test(address);

  const getError = (): string => {
    if (!numericAmount) return '';
    if (numericAmount < minimum) return `El mínimo es ${minimum} CUP.`;
    if (numericAmount > balance) return 'No tienes saldo suficiente.';
    if (method === 'usdt' && !address) return 'Introduce tu dirección USDT.';
    if (invalidAddress) return 'Esa dirección TRC20 no parece válida.';
    return '';
  };

  const validationError = getError();

  const submit = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      await api.withdraw(numericAmount, method, method === 'usdt' ? address : undefined);
      await onBalanceChange?.();
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo procesar el retiro.');
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Retirar" onBack={onBack} />

      {/* Saldo */}
      <div className="rounded-2xl p-4 mb-5" style={{ background: '#16213e', border: '1px solid #2a2a4a' }}>
        <p className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-1">
          Disponible para retirar
        </p>
        <p className="text-3xl font-bold text-[#00d26a]">{balance} CUP</p>
      </div>

      {/* Método */}
      <SectionLabel>Método de retiro</SectionLabel>
      <div className="grid grid-cols-3 gap-2 mb-5">
        {METHODS.map(m => (
          <button
            key={m.id}
            onClick={() => {
              setMethod(m.id);
              setError('');
            }}
            aria-pressed={method === m.id}
            className={`card p-3 flex flex-col items-center gap-1 transition-all ${
              method === m.id
                ? 'border-[#00d26a] bg-[#00d26a]/10'
                : 'hover:border-[#2a2a4a]'
            }`}
          >
            <span className="text-xl">{m.flag}</span>
            <span className="text-xs font-semibold text-white">{m.name}</span>
            <span className="text-[10px] text-[#a0a0b0]">{m.rate}</span>
          </button>
        ))}
      </div>

      {/* Monto */}
      <SectionLabel>Monto (CUP)</SectionLabel>
      <div className="relative mb-2">
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={e => {
            setAmount(e.target.value);
            setError('');
          }}
          placeholder="1000"
          className="input text-lg pr-24"
          aria-label="Monto a retirar"
        />
        <button
          onClick={() => setAmount(String(balance))}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#00d26a]"
        >
          MÁX
        </button>
      </div>
      <p className="text-xs text-[#a0a0b0] mb-5">Mínimo {minimum} CUP</p>

      {/* Dirección USDT */}
      {method === 'usdt' && (
        <>
          <SectionLabel>Dirección USDT (TRC20)</SectionLabel>
          <input
            type="text"
            value={address}
            onChange={e => {
              setAddress(e.target.value);
              setError('');
            }}
            placeholder="T..."
            className={`input font-mono text-xs ${invalidAddress ? 'border-[#ff4757]' : ''}`}
            aria-label="Dirección USDT"
          />
          <p className="text-xs text-[#a0a0b0] mt-2 mb-5">
            Verifica la red (TRC20) y la dirección. Los envíos erróneos no se pueden
            revertir.
          </p>
        </>
      )}

      {(error || validationError) && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error || validationError}</p>
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting || !!validationError || !numericAmount}
        className="w-full btn btn-primary py-3.5 text-base disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Procesando…' : 'Solicitar retiro'}
      </button>

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Tiempo estimado:</span> 24-48 horas
          hábiles. USDT se procesa automáticamente; los demás métodos se validan a mano.
        </p>
      </div>
    </div>
  );
}
