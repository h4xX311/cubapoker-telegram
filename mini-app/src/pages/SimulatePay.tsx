import { useState, useEffect } from 'react';
import { api, ApiError, type DepositOrder } from '../lib/api';

/**
 * Pantalla de pago en modo simulacion.
 *
 * Sustituye a EnZona / QvaPay / epusdt mientras no haya integracion real.
 * Reproduce fielmente los tres pasos del flujo (crear orden -> pagar ->
 * confirmar) para que el resto de la aplicacion se pueda probar completo.
 */

interface Props {
  order: DepositOrder;
  onDone: (credited: number) => void;
  onCancel: () => void;
  onBack: () => void;
}

const EXPIRY_LABEL: Record<string, string> = {
  enzona: 'EnZona · Transferencia móvil',
  qvapay: 'QvaPay · Tarjeta o pasarela',
  usdt: 'USDT · Blockchain',
};

export function SimulatePay({ order, onDone, onCancel, onBack }: Props) {
  const [status, setStatus] = useState<'pending' | 'confirming' | 'paid' | 'error'>('pending');
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, Math.floor((new Date(order.expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(
        Math.max(0, Math.floor((new Date(order.expiresAt).getTime() - Date.now()) / 1000)),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [order.expiresAt]);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  const simulatePayment = async () => {
    setStatus('confirming');
    setError('');
    try {
      // Paso 1: el "banco" confirma el pago
      await api.confirmSimulated(order.orderId);
      // Paso 2: la aplicacion acredita el saldo al detectar la orden pagada
      const result = await api.confirmDeposit(order.orderId);
      setStatus('paid');
      setTimeout(() => onDone(result.credited ?? order.amount), 1400);
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'No se pudo procesar el pago.');
    }
  };

  if (status === 'paid') {
    return (
      <div className="p-4 pb-10 text-center animate-fadeIn">
        <div className="w-20 h-20 rounded-full bg-[#00d26a]/20 flex items-center justify-center mx-auto mb-5 animate-pulse">
          <span className="text-4xl">✓</span>
        </div>
        <h1 className="text-xl font-bold text-[#00d26a] mb-2">Pago confirmado</h1>
        <p className="text-[#a0a0b0] mb-1">Saldo acreditado correctamente</p>
        <p className="text-lg font-bold text-white mt-3">
          +{order.amount} {order.currency}
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      {/* Cabecera simulacion */}
      <div
        className="rounded-xl p-3 mb-4 flex items-center gap-2"
        style={{ background: 'rgba(255,215,0,0.1)', border: '1px solid rgba(255,215,0,0.3)' }}
      >
        <span className="text-lg">🧪</span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#ffd700]">Modo simulación</p>
          <p className="text-[10px] text-[#a0a0b0]">
            No se mueve dinero real. Al conectar la pasarela, esta pantalla desaparece.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-xl bg-[#16213e] flex items-center justify-center hover:bg-[#1f2b4d] transition-colors"
          aria-label="Volver"
        >
          ←
        </button>
        <div>
          <h1 className="text-lg font-bold text-white">Completar pago</h1>
          <p className="text-xs text-[#a0a0b0]">
            {EXPIRY_LABEL[order.simulated ? providerOf(order) : 'usdt']}
          </p>
        </div>
      </div>

      {/* Monto */}
      <div className="rounded-2xl p-5 mb-4 text-center" style={{ background: '#16213e', border: '1px solid #2a2a4a' }}>
        <p className="text-xs text-[#a0a0b0] uppercase tracking-wide mb-1">Monto a pagar</p>
        <p className="text-3xl font-bold text-white">
          {order.amount}
          <span className="text-base text-[#a0a0b0] ml-2">{order.currency}</span>
        </p>
      </div>

      {/* Instrucciones */}
      <div className="card mb-4">
        <p className="text-xs text-[#a0a0b0] uppercase tracking-wide mb-3">
          Instrucciones
        </p>
        <dl className="space-y-2.5">
          {Object.entries(order.instructions ?? {}).map(([key, value]) => (
            <div key={key} className="flex flex-col gap-1">
              <dt className="text-[10px] text-[#6c6c80] uppercase tracking-wide">
                {key}
              </dt>
              <dd className="text-sm text-white font-mono break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Caducidad */}
      <div className="flex items-center justify-between mb-4 px-1">
        <span className="text-xs text-[#a0a0b0]">La orden expira en</span>
        <span className={`text-sm font-bold tabular ${remaining < 300 ? 'text-[#ff8a94]' : 'text-[#ffd700]'}`}>
          {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
        </span>
      </div>

      {status === 'error' && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {remaining === 0 ? (
        <div className="card text-center">
          <p className="text-sm text-[#ff8a94] mb-4">La orden expiró.</p>
          <button onClick={onCancel} className="w-full btn btn-primary py-3">
            Generar una nueva
          </button>
        </div>
      ) : (
        <button
          onClick={simulatePayment}
          disabled={status === 'confirming'}
          className="w-full btn btn-primary py-3.5 text-base disabled:opacity-60"
        >
          {status === 'confirming' ? 'Procesando…' : 'Simular pago'}
        </button>
      )}

      <button
        onClick={onCancel}
        className="w-full mt-3 text-sm text-[#a0a0b0] py-2"
        disabled={status === 'confirming'}
      >
        Cancelar orden
      </button>
    </div>
  );
}

/** La orden guarda el metodo en las instrucciones; lo derivamos de la red. */
function providerOf(order: DepositOrder): string {
  if (order.chain) return 'usdt';
  if (order.instructions?.metodo?.includes('EnZona')) return 'enzona';
  return 'qvapay';
}
