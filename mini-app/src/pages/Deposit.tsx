import { useState, useEffect } from 'react';
import { api, ApiError, type ChainInfo, type DepositOrder } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onCheckout: (order: DepositOrder) => void;
}
type Provider = 'enzona' | 'qvapay' | 'usdt';

const PROVIDERS: { id: Provider; icon: string; name: string; note: string; min: number; rate: string }[] = [
  { id: 'enzona', icon: '🇨🇺', name: 'EnZona', note: 'Pago móvil', min: 500, rate: '1.5%' },
  { id: 'qvapay', icon: '💳', name: 'QvaPay', note: 'Tarjeta', min: 500, rate: '1.5%' },
  { id: 'usdt', icon: '₮', name: 'USDT', note: '5 redes', min: 5, rate: '0.5%' },
];

const CUP_PER_USDT = 350;

export function Deposit({ user, onBack, onCheckout }: Props) {
  const [provider, setProvider] = useState<Provider>('usdt');
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [chainId, setChainId] = useState<string>('TRC20');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.chains();
        setChains(res.chains || []);
        const recommended = res.chains?.find((c: ChainInfo) => c.recommended);
        if (recommended) setChainId(recommended.id);
      } catch {
        setChains([]);
      }
    })();
  }, []);

  const numericAmount = Number(amount) || 0;
  const config = PROVIDERS.find(p => p.id === provider)!;
  const belowMinimum = numericAmount > 0 && numericAmount < config.min;
  const selectedChain = chains.find(c => c.id === chainId);

  const presets =
    provider === 'usdt' ? [5, 10, 25, 50, 100] : [500, 1000, 2500, 5000, 10000];

  const submit = async () => {
    setError('');

    if (!numericAmount || belowMinimum) {
      setError(`El mínimo es ${config.min} ${provider === 'usdt' ? 'USDT' : 'CUP'}.`);
      return;
    }

    setSubmitting(true);
    try {
      const order = await api.createDepositOrder(
        numericAmount,
        provider,
        provider === 'usdt' ? chainId : undefined,
      );
      onCheckout(order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo generar la orden.');
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Depositar" onBack={onBack} />

      {/* Método */}
      <SectionLabel>Método de pago</SectionLabel>
      <div className="grid grid-cols-3 gap-2 mb-5">
        {PROVIDERS.map(p => (
          <button
            key={p.id}
            onClick={() => {
              setProvider(p.id);
              setAmount('');
              setError('');
            }}
            aria-pressed={provider === p.id}
            className={`card p-3 flex flex-col items-center gap-1 transition-all ${
              provider === p.id
                ? 'border-[#00d26a] bg-[#00d26a]/10'
                : 'hover:border-[#2a2a4a]'
            }`}
          >
            <span className="text-xl">{p.icon}</span>
            <span className="text-xs font-semibold text-white">{p.name}</span>
            <span className="text-[10px] text-[#a0a0b0]">{p.note}</span>
          </button>
        ))}
      </div>

      {/* Red (solo USDT) */}
      {provider === 'usdt' && (
        <>
          <SectionLabel>Red</SectionLabel>
          <div className="space-y-2 mb-2">
            {chains.map(c => (
              <button
                key={c.id}
                onClick={() => setChainId(c.id)}
                aria-pressed={chainId === c.id}
                className={`w-full rounded-xl p-3 flex items-center justify-between transition-all ${
                  chainId === c.id
                    ? 'border-[#00d26a] bg-[#00d26a]/10'
                    : 'hover:border-[#2a2a4a]'
                }`}
                style={{ background: '#16213e', border: '1px solid' }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      chainId === c.id ? 'border-[#00d26a]' : 'border-[#2a2a4a]'
                    }`}
                  >
                    {chainId === c.id && <span className="w-2 h-2 rounded-full bg-[#00d26a]" />}
                  </span>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-white">
                      {c.name}
                      {c.recommended && (
                        <span className="ml-2 text-[10px] text-[#00d26a] font-normal">
                          recomendado
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] text-[#a0a0b0]">
                      {c.nativeSymbol} · ~{c.avgFeeUsd} USD de comisión
                    </p>
                  </div>
                </div>
                <span className="text-[10px] text-[#a0a0b0]">
                  {c.confirmationMinutes} min
                </span>
              </button>
            ))}
          </div>
          {selectedChain && (
            <p className="text-[10px] text-[#6c6c80] mb-5">
              Envía solo por {selectedChain.name}. Otra red puede perder tus fondos.
            </p>
          )}
        </>
      )}

      {/* Monto */}
      <SectionLabel>Monto {provider === 'usdt' ? '(USDT)' : '(CUP)'}</SectionLabel>
      <div className="relative mb-3">
        <input
          type="number"
          inputMode="decimal"
          value={amount}
          onChange={e => {
            setAmount(e.target.value);
            setError('');
          }}
          placeholder={provider === 'usdt' ? '10' : '1000'}
          className="input text-lg pr-16"
          aria-label="Monto a depositar"
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-[#a0a0b0]">
          {provider === 'usdt' ? 'USDT' : 'CUP'}
        </span>
      </div>

      {provider === 'usdt' && numericAmount > 0 && (
        <p className="text-xs text-[#a0a0b0] mb-3">
          ≈ {(numericAmount * CUP_PER_USDT).toLocaleString('es-CU')} CUP
        </p>
      )}

      {belowMinimum && (
        <p className="text-xs text-[#ff8a94] mb-3">
          Mínimo {config.min} {provider === 'usdt' ? 'USDT' : 'CUP'}
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
        {submitting ? 'Generando orden…' : `Continuar · ${numericAmount || 0}`}
      </button>

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Comisión:</span> {config.rate}. El
          saldo se acredita cuando el pago se confirme, no antes.
        </p>
        <p className="text-xs text-[#a0a0b0] leading-relaxed mt-2">
          <span className="text-white font-semibold">Tu saldo retirable:</span>{' '}
          {user?.balance?.real ?? 0} CUP
          {(user?.balance?.play ?? 0) > 0 && (
            <> · depósito de {user?.balance?.play ?? 0} CUP de promoción</>
          )}
        </p>
      </div>
    </div>
  );
}
