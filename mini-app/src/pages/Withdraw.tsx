import { useState, useEffect } from 'react';
import { api, ApiError, type ChainInfo } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

type Provider = 'enzona' | 'qvapay' | 'usdt';

const PROVIDERS: { id: Provider; icon: string; name: string; rate: string }[] = [
  { id: 'enzona', icon: '🇨🇺', name: 'EnZona', rate: '3%' },
  { id: 'qvapay', icon: '💳', name: 'QvaPay', rate: '3%' },
  { id: 'usdt', icon: '₮', name: 'USDT', rate: '1%' },
];

const MINIMUMS: Record<Provider, number> = { enzona: 1000, qvapay: 1000, usdt: 10 };

export function Withdraw({ user, onBack, onBalanceChange }: Props) {
  const [provider, setProvider] = useState<Provider>('usdt');
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [chainId, setChainId] = useState('TRC20');
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ orderId: string; net: number } | null>(null);
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

  const balance = user?.balance?.credits ?? 0;
  const numericAmount = Number(amount) || 0;
  const minimum = MINIMUMS[provider];
  const selectedChain = chains.find(c => c.id === chainId);

  const invalidAddress =
    provider === 'usdt' && address.length > 0 && !validateAddress(chainId, address);

  const validationError = (() => {
    if (!numericAmount) return '';
    if (numericAmount < minimum) return `El mínimo es ${minimum} CUP.`;
    if (numericAmount > balance) return 'No tienes saldo suficiente.';
    if (provider === 'usdt' && !address) return 'Introduce tu dirección.';
    if (invalidAddress) return `Dirección inválida para ${selectedChain?.name}.`;
    return '';
  })();

  const submit = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res = await api.withdraw(
        numericAmount,
        provider,
        provider === 'usdt' ? chainId : undefined,
        provider === 'usdt' ? address : undefined,
      );
      setDone({ orderId: res.orderId, net: res.net });
      await onBalanceChange?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo solicitar el retiro.');
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="p-4 pb-10 text-center animate-fadeIn">
        <div className="w-20 h-20 rounded-full bg-[#ffd700]/20 flex items-center justify-center mx-auto mb-5">
          <span className="text-4xl">🕐</span>
        </div>
        <h1 className="text-xl font-bold text-[#ffd700] mb-2">Retiro solicitado</h1>
        <p className="text-[#a0a0b0] mb-1">Recibirás {done.net} CUP</p>
        <p className="text-xs text-[#6c6c80] mb-6 font-mono">{done.orderId.slice(0, 18)}…</p>

        <div className="card text-left mb-5">
          <p className="text-xs text-[#a0a0b0] leading-relaxed">
            Tu solicitud está en revisión. Verificamos el pago antes de enviarlo, por
            eso el saldo se descuenta al liquidarse, no al solicitarlo.
          </p>
        </div>

        <button onClick={onBack} className="w-full btn btn-primary py-3">
          Volver al inicio
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Retirar" onBack={onBack} />

      <div
        className="rounded-2xl p-4 mb-5"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <p className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-1">Disponible</p>
        <p className="text-3xl font-bold text-[#00d26a]">{balance} CUP</p>
      </div>

      {/* Método */}
      <SectionLabel>Método de retiro</SectionLabel>
      <div className="grid grid-cols-3 gap-2 mb-5">
        {PROVIDERS.map(p => (
          <button
            key={p.id}
            onClick={() => {
              setProvider(p.id);
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
            <span className="text-[10px] text-[#a0a0b0]">{p.rate} com.</span>
          </button>
        ))}
      </div>

      {/* Red (solo USDT) */}
      {provider === 'usdt' && (
        <>
          <SectionLabel>Red de destino</SectionLabel>
          <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
            {chains.map(c => (
              <button
                key={c.id}
                onClick={() => setChainId(c.id)}
                aria-pressed={chainId === c.id}
                className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                  chainId === c.id ? 'btn-primary' : 'btn-outline'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}

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
          className="input text-lg pr-20"
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

      {/* Dirección */}
      {provider === 'usdt' && (
        <>
          <SectionLabel>
            Dirección USDT ({selectedChain?.name ?? chainId})
          </SectionLabel>
          <input
            type="text"
            value={address}
            onChange={e => {
              setAddress(e.target.value);
              setError('');
            }}
            placeholder={selectedChain?.addressExample ?? 'Dirección'}
            className={`input font-mono text-xs ${invalidAddress ? 'border-[#ff4757]' : ''}`}
            aria-label="Dirección USDT"
          />
          <p className="text-[10px] text-[#6c6c80] mt-2 mb-5 leading-relaxed">
            Verifica red y dirección. Los envíos erróneos no se pueden revertir.
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
        {submitting ? 'Enviando…' : 'Solicitar retiro'}
      </button>

      <div className="mt-5 card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Tiempo:</span> 24-48 h. Verificamos
          cada retiro manualmente antes de enviarlo.
        </p>
      </div>
    </div>
  );
}

/**
 * Valida el formato de direccion segun la cadena.
 *
 * El servidor es la autoridad: estas reglas son solo para dar feedback
 * inmediato. El backend vuelve a validar antes de aceptar el retiro, asi que
 * una discrepancia aqui no permitiria mover fondos.
 */
function validateAddress(chainId: string, address: string): boolean {
  const trimmed = address.trim();
  if (chainId === 'SOL') {
    // Base58: 32-44, sin 0/O/I/l. Se rechaza el patron de Tron porque una
    // direccion T+33 tambien es Base58 valido.
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return false;
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
  }
  if (chainId === 'TRC20') {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed);
  }
  // EVM (ERC20 / BEP20 / POL)
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
}
