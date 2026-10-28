import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader } from '../components/Layout';
import { fmtUsdt } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onGoTables?: () => void;
  onGoMembership?: () => void;
}

/**
 * VIP ARENA
 * =========
 *
 * VIP Arena es una SALA DE CASH, no una membresía ni un plan comprable.
 * "VIP" aquí significa acceso a la mesa de high stakes: todos los usuarios que
 * se sientan en ella participan del profit share. No hay que suscribirse.
 *
 * La membresía QVA-Bet Club vive en `Membership.tsx` y es un producto distinto:
 * se activa un plan y devuelve rakeback de las mesas cash normales. Mezclar
 * ambas cosas en una sola pantalla hacía que un jugador creyera que para jugar
 * en Arena necesitaba comprar QVA Premium, y no es así.
 */

const fechaCorta = (iso: string | null | undefined) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
  });
};

export function VipArena({
  user,
  onBack,
  onBalanceChange,
  onGoTables,
  onGoMembership,
}: Props) {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await api.vip();
      setStatus(res);
    } catch {
      // Sin estado de Arena la pantalla sigue siendo útil: explica la sala y
      // permite volver al lobby de cash. El siguiente intento recarga los datos.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const claim = async () => {
    setClaiming(true);
    setError('');
    try {
      const res = await api.claimArenaProfitShare();
      await onBalanceChange?.();
      await load();
      if (!res?.paidUsdt && res?.reason) {
        setError(res.reason);
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo cobrar el profit share de VIP Arena.',
      );
    } finally {
      setClaiming(false);
    }
  };

  const arena = status?.arena;
  const available = arena?.claimableUsdt ?? 0;
  const percent = arena?.percent ?? 15;
  // Un pago `pending` ya salió del estado "nada pagado" pero todavía no está
  // confirmado. No se ofrece cobrar de nuevo: el índice único lo rechazaría.
  const payoutPending = arena?.payoutStatus === 'pending';
  // `user.vipArena` se calcula por asientos y rake de Arena. No tiene nada que
  // ver con `user.vip`, que es la membresía QVA-Bet Club.
  const participando = Boolean(user?.vipArena?.participating);

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="VIP Arena" onBack={onBack} />

      <div
        className="rounded-2xl p-4 mb-5"
        style={{
          background: 'linear-gradient(135deg, #1c1730 0%, #16131f 100%)',
          border: '1px solid rgba(255, 215, 0, 0.45)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#ffd700] font-bold">
              Sala de cash · High stakes
            </p>
            <h2 className="text-xl font-bold text-white mt-1">
              Juega y cobra tu profit share
            </h2>
          </div>
          <span className="text-[10px] font-bold text-[#ffd700] bg-[#ffd700]/10 border border-[#ffd700]/30 rounded-full px-2 py-1 whitespace-nowrap">
            {percent}% semanal
          </span>
        </div>

        <p className="text-xs text-[#a0a0b0] mt-2 leading-relaxed">
          VIP Arena no es una membresía ni un plan de QVA-Bet Club. Es una mesa
          de cash de 50/100 USDT a la que se entra con el buy-in, como en
          cualquier otra sala. Todos los que se sientan allí reciben cada lunes
          el {percent}% del rake que generaron. No se compra acceso.
        </p>

        <p className="text-[10px] mt-2">
          <span
            className="font-bold"
            style={{ color: participando ? '#00d26a' : '#a0a0b0' }}
          >
            {participando
              ? 'Participación detectada esta semana'
              : 'Sin participación esta semana'}
          </span>
          <span className="text-[#a0a0b0]">
            {' '}
            · se recalcula al sentarte en la sala.
          </span>
        </p>
      </div>

      {loading ? (
        <div className="text-center py-10">
          <div className="spinner mx-auto" />
        </div>
      ) : (
        <>
          <div
            className="rounded-2xl p-4 mb-5"
            style={{ background: '#151525', border: '1px solid #2a2a4a' }}
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl p-3" style={{ background: '#0f0d17' }}>
                <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide">
                  Rake en Arena
                </p>
                <p className="text-lg font-bold text-white mt-1">
                  {fmtUsdt(arena?.rakeUsdt ?? 0)}
                  <span className="text-[10px] font-normal text-[#a0a0b0] ml-1">
                    USDT
                  </span>
                </p>
                <p className="text-[9px] text-[#a0a0b0] mt-1">
                  {fechaCorta(arena?.weekStart)} – {fechaCorta(arena?.weekEnd)}
                </p>
              </div>
              <div className="rounded-xl p-3" style={{ background: '#0f0d17' }}>
                <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide">
                  Tu profit share
                </p>
                <p className="text-lg font-bold text-[#ffd700] mt-1">
                  {fmtUsdt(arena?.estimatedUsdt ?? 0)}
                  <span className="text-[10px] font-normal text-[#a0a0b0] ml-1">
                    USDT
                  </span>
                </p>
                <p className="text-[9px] text-[#a0a0b0] mt-1">
                  {arena?.payoutStatus === 'paid'
                    ? 'Pagado'
                    : payoutPending
                      ? 'En revisión'
                      : available > 0
                        ? 'Disponible'
                        : 'Sin rake esta semana'}
                </p>
              </div>
            </div>

            {available > 0 && !payoutPending ? (
              <button
                onClick={claim}
                disabled={claiming}
                className="w-full btn btn-primary py-2.5 text-sm mt-3 disabled:opacity-50"
              >
                {claiming
                  ? 'Cobrando…'
                  : `Cobrar ${fmtUsdt(available)} USDT`}
              </button>
            ) : (
              <p className="text-[10px] text-[#a0a0b0] mt-3">
                {payoutPending
                  ? 'Tu profit share está en revisión. No hace falta volver a cobrarlo.'
                  : `Próximo pago: ${fechaCorta(arena?.nextPayoutAt)}. Juega en la sala VIP Arena del lobby de cash.`}
              </p>
            )}

            {(arena?.currentWeekRakeUsdt ?? 0) > 0 && (
              <p className="text-[10px] text-[#a0a0b0] mt-2">
                Rake acumulado esta semana:{' '}
                <span className="text-white font-semibold">
                  {fmtUsdt(arena.currentWeekRakeUsdt)} USDT
                </span>
              </p>
            )}
          </div>

          {error && (
            <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
              <p className="text-sm text-[#ff8a94]">{error}</p>
            </div>
          )}

          <div
            className="rounded-2xl p-4 mb-4"
            style={{ background: '#151525', border: '1px solid #2a2a4a' }}
          >
            <p className="text-sm font-semibold text-white">
              ¿Buscas la membresía?
            </p>
            <p className="text-xs text-[#a0a0b0] mt-1 leading-relaxed">
              QVA-Bet Club es un producto aparte: se activa un plan y devuelve
              rakeback de las mesas cash normales. No hace falta para jugar en
              VIP Arena.
            </p>
            {onGoMembership && (
              <button
                onClick={onGoMembership}
                className="text-xs font-semibold text-[#ffd700] mt-2"
              >
                Ver planes de QVA-Bet Club →
              </button>
            )}
          </div>

          {onGoTables && (
            <button
              onClick={onGoTables}
              className="w-full btn btn-primary py-3 text-sm"
            >
              Ir al lobby de cash
            </button>
          )}
        </>
      )}
    </div>
  );
}
