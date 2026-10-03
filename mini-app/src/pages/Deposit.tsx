import { useState } from 'react';
import { api, ApiError } from '../lib/api';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

type Method = 'enzona' | 'qvapay' | 'usdt';
type Network = 'TRC20' | 'ERC20' | 'BEP20';

const METHODS: { id: Method; flag: string; name: string; note: string; rate: string }[] = [
  { id: 'enzona', flag: '🇨🇺', name: 'EnZona', note: 'Pago móvil cubano', rate: '1.5% comisión' },
  { id: 'qvapay', flag: '💳', name: 'QvaPay', note: 'Tarjeta / online', rate: '1.5% comisión' },
  { id: 'usdt', flag: '₮', name: 'USDT', note: 'Cripto', rate: '0.5% comisión' },
];

const NETWORKS: Network[] = ['TRC20', 'ERC20', 'BEP20'];
const CUP_PER_USDT = 350;

const MINIMUMS: Record<Method, number> = { enzona: 500, qvapay: 500, usdt: 5 };

export function Deposit({ user, onBack, onBalanceChange }: Props) {
  const [method, setMethod] = useState<Method>('enzona');
  const [network, setNetwork] = useState<Network>('TRC20');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const numericAmount = Number(amount) || 0;
  const minimum = MINIMUMS[method];
  const belowMinimum = numericAmount > 0 && numericAmount < minimum;

  const presets = method === 'usdt' ? [5, 10, 25, 50, 100] : [500, 1000, 2500, 5000, 10000];

  const submit = async () => {
    setError('');

    if (!numericAmount || numericAmount < minimum) {
      setError(`El mínimo es ${minimum} ${method === 'usdt' ? 'USDT' : 'CUP'}.`);
      return;
    }

    setSubmitting(true);
    try {
      await api.deposit(numericAmount, method);
      await onBalanceChange?.();
      // Recargamos para que el usuario vea el saldo real ya acreditado
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo procesar el depósito.');
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Depositar" onBack={onBack} />

      {/* Método */}
      <SectionLabel>Método de pago</SectionLabel>
      <div className="grid grid-cols-3 gap-2 mb-5">
        {METHODS.map(m => (
          <button
            key={m.id}
            onClick={() => {
              setMethod(m.id);
              setAmount('');
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
            <span className="text-[10px] text-[#a0a0b0] text-center leading-tight">{m.note}</span>
          </button>
        ))}
      </div>

      {/* Red (solo USDT) */}
      {method === 'usdt' && (
        <>
          <SectionLabel>Red</SectionLabel>
          <div className="grid grid-cols-3 gap-2 mb-5">
            {NETWORKS.map(n => (
              <button
                key={n}
                onClick={() => setNetwork(n)}
                aria-pressed={network === n}
                className={`card p-3 text-center transition-all ${
                  network === n ? 'border-[#00d26a] bg-[#00d26a]/10' : 'hover:border-[#2a2a4a]'
                }`}
              >
                <span className="text-sm font-semibold text-white block">{n}</span>
                {n === 'TRC20' && (
                  <span className="text-[10px] text-[#00d26a]">Más barato</span>
                )}
              </button>
            ))}
          </div>
          <p className="text-xs text-[#a0a0b0] mb-5 -mt-3">
            Envía únicamente {network}. Enviar por otra red puede perder tus fondos.
          </p>
        </>
      )}

      {/* Monto */}
      <SectionLabel>
        Monto {method === 'usdt' ? '(USDT)' : '(CUP)'}
      </SectionLabel>
      <div className="relative mb-3">
        <input
          type="number"
          inputMode="decimal"
          value={amount}
          onChange={e => {
            setAmount(e.target.value);
            setError('');
          }}
          placeholder={method === 'usdt' ? '10' : '1000'}
          className="input text-lg pr-16"
          aria-label="Monto a depositar"
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[#a0a0b0]">
          {method === 'usdt' ? 'USDT' : 'CUP'}
        </span>
      </div>

      {method === 'usdt' && numericAmount > 0 && (
        <p className="text-xs text-[#a0a0b0] mb-3">
          ≈ {(numericAmount * CUP_PER_USDT).toLocaleString('es-CU')} CUP
        </p>
      )}

      {belowMinimum && (
        <p className="text-xs text-[#ff4757] mb-3">
          Mínimo {minimum} {method === 'usdt' ? 'USDT' : 'CUP'}
        </p>
      )}

      {/* Presets */}
      <div className="grid grid-cols-5 gap-2 mb-5">
        {presets.map(p => (
          <button
            key={p}
            onClick={() => setAmount(String(p))}
            className="card py-2.5 text-xs font-semibold text-white hover:border-[#00d26a] transition-all"
          >
            {p >= 1000 ? `${p / 1000}k` : p}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting || !numericAmount || belowMinimum}
        className="w-full btn btn-primary py-3.5 text-base disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Procesando…' : `Depositar ${numericAmount || 0}`}
      </button>

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Comisión:</span>{' '}
          {METHODS.find(m => m.id === method)?.rate}. El saldo se acredita{' '}
          {method === 'usdt' ? 'tras la confirmación en blockchain' : 'al confirmarse el pago'}.
        </p>
        <p className="text-xs text-[#a0a0b0] leading-relaxed mt-2">
          <span className="text-white font-semibold">Saldo actual:</span>{' '}
          {user?.balance?.credits ?? 0} CUP
        </p>
      </div>
    </div>
  );
}

export function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3 mb-5 pt-1">
      <button
        onClick={onBack}
        className="w-9 h-9 rounded-xl bg-[#16213e] flex items-center justify-center text-white hover:bg-[#1f2b4d] transition-colors"
        aria-label="Volver"
      >
        ←
      </button>
      <h1 className="text-xl font-bold text-white">{title}</h1>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-2.5">
      {children}
    </h2>
  );
}
