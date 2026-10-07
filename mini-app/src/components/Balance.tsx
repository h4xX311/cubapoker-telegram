import type { ReactNode } from 'react';
import type { Session } from '../lib/types';

/**
 * Formatea un importe de la cuenta (USDT) para la interfaz.
 *
 * Sin miles de separador cuando el numero es pequeno: en el campo micro las
 * cifras son 1, 5, 25 y 300, y "1.000" se lee como una cantidad que da miedo.
 * Con separador a partir de 1000.
 */
export const fmtUsdt = (n: number): string => {
  const v = Math.round((n ?? 0) * 100) / 100;
  if (Math.abs(v) >= 1000) {
    return v.toLocaleString('es-ES', { maximumFractionDigits: 0 });
  }
  if (Number.isInteger(v)) return String(v);
  return v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * Como se ve el saldo en la cabecera.
 *
 * ------------------------------------------------------------------
 * SOLO USDT. UNA MONEDA, COMO COINPOKER
 *
 * Antes debajo del saldo se ponia el equivalente en CUP: "USDT · 122.100 CUP". Se quito
 * porque son dos monedas en la misma pantalla y el usuario no sabe cual arriesga. El saldo
 * que arriesga son USDT, y es lo unico que se muestra.
 *
 * Ademas era una conversion sin cotizacion real (un numero fijo guardado en el codigo), y
 * mostrado junto a un saldo con centavos假的 da precision que no existe: 0,003 USDT son "0
 * CUP" o "1 CUP" segun como redondee. Un numero inventado al lado del dinero real invite a
 * la desconfianza.
 *
 * CoinPoker tiene una sola moneda en pantalla por la misma razon, y sin referencia secundaria.
 */
export const BalanceDisplay = ({
  balance,
}: {
  balance: { real: number; play: number; total: number };
}) => (
  <div className="flex flex-col items-end leading-none">
    <span className="text-sm font-bold text-[#00d26a]">{fmtUsdt(balance.total)}</span>
    <span className="text-[9px] text-[#a0a0b0] mt-0.5">USDT</span>
  </div>
);

/**
 * Texto de "tu saldo de promocion".
 *
 * TIENE que explicar el ratio 1:10. Un jugador que ve que su saldo baja al
 * comprar una entrada y no sabe que hay un desbloqueo creera que le estan
 * cobrando de mas, y se quejara. Decirlo aqui evita el reclamo.
 */
export const PromoBalanceNote = ({
  play,
  maxExtractable,
}: {
  play: number;
  maxExtractable: number;
}) => (
  <div
    className="rounded-xl p-3 flex items-start gap-2.5"
    style={{
      background: 'rgba(255,215,0,0.08)',
      border: '1px solid rgba(255,215,0,0.25)',
    }}
  >
    <span className="text-sm">💡</span>
    <p className="text-[11px] text-[#a0a0b0] leading-relaxed">
      Tienes <strong className="text-[#ffd700]">{fmtUsdt(play)} USDT</strong> de
      promoción. Sirven para jugar en cualquier campo, pero no se retiran
      directamente: al usarlos se desbloquea{' '}
      <strong className="text-white">1 de cada 10</strong> a saldo retirable. Si
      los juegas todos, podrías extraer{' '}
      <strong className="text-white">{fmtUsdt(maxExtractable)} USDT</strong> (y
      perderías el resto por el camino).
    </p>
  </div>
);

/** Boton con el tono de la marca. */
export const PrimaryButton = ({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`btn btn-primary ${className} disabled:opacity-50 disabled:cursor-not-allowed`}
  >
    {children}
  </button>
);

/** Saludo con el nombre del jugador. */
export const Greeting = ({ user }: { user: Session | null }) => (
  <div className="mb-5">
    <p className="text-[#a0a0b0] text-sm">Hola</p>
    <h1 className="text-2xl font-bold text-white truncate">
      {user?.firstName || 'Jugador'}
    </h1>
  </div>
);
