import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { CashFormat, CashTier, MyTable, TableSummary } from '../lib/types';
import { PageHeader, SectionLabel } from '../components/Layout';
import { fmtUsdt, fmtStake } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
  onGoTables?: () => void;
  onGoMembership?: () => void;
}

/**
 * VIP ARENA
 * =========
 *
 * VIP Arena es una SALA DE CASH independiente, no una membresía ni un plan
 * comprable. Tiene sus propias mesas, buy-ins y ciegas; el jugador entra con
 * el buy-in como en cualquier otra sala y participa del profit share del rake.
 *
 * La membresía QVA-Bet Club vive en `Membership.tsx` y es un producto distinto.
 * Mezclar ambas cosas en una sola pantalla hacía que un jugador creyera que
 * para jugar en Arena necesitaba comprar QVA Premium.
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
  onPlay,
  onGoTables,
  onGoMembership,
}: Props) {
  const [status, setStatus] = useState<any>(null);
  const [tiers, setTiers] = useState<CashTier[]>([]);
  const [formats, setFormats] = useState<CashFormat[]>([]);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [misMesas, setMisMesas] = useState<MyTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [arena, cfg, list, mine] = await Promise.all([
        api.vip(),
        api.gameConfig(),
        api.listTables(),
        api.myTables(),
      ]);

      setStatus(arena);

      const arenaTiers = (cfg?.cashTiers ?? []).filter(
        (t: CashTier) => t.vipArena,
      );
      setTiers(arenaTiers);
      setFormats(
        cfg?.cashFormats ?? [
          { id: '7max', label: '7-max', shortLabel: '7-MAX', maxSeats: 7 },
        ],
      );

      const ids = new Set(arenaTiers.map((t: CashTier) => t.id));
      setTables(
        (list?.tables ?? []).filter(
          (t: TableSummary) => !t.field && ids.has(t.tierId),
        ),
      );
      setMisMesas(
        (mine?.tables ?? []).filter((m: MyTable) => ids.has(m.tierId ?? '')),
      );
    } catch {
      // Sin estado de Arena la pantalla sigue siendo útil: el siguiente intento
      // recarga los datos.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, []);

  const entrar = async (destino: {
    tierId?: string;
    tableId?: string;
    formatId?: '7max' | '6max' | 'hu';
  }) => {
    const clave =
      destino.tableId ?? `${destino.tierId ?? ''}-${destino.formatId ?? ''}`;
    setBusy(clave);
    setError('');

    try {
      if (destino.tableId && misMesas.some((m) => m.tableId === destino.tableId)) {
        onPlay(destino.tableId);
        return;
      }

      const res = await api.sit(destino);
      await onBalanceChange?.();

      if (res?.tableId) {
        onPlay(res.tableId);
        return;
      }

      const mine = await api.myTables();
      const recien = mine?.tables?.[0];
      if (recien?.tableId) {
        onPlay(recien.tableId);
        return;
      }

      setError('Te has sentado. Vuelve a entrar para ver tu mesa.');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo entrar en la mesa de Arena.',
      );
    } finally {
      setBusy(null);
    }
  };

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
  const payoutPending = arena?.payoutStatus === 'pending';
  const participando = Boolean(user?.vipArena?.participating);
  const balance = user?.balance?.total ?? 0;

  return (
    <div className="p-4 pb-10 animate-fadeIn lg:px-0">
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
              Sala de cash · mesas propias
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
          VIP Arena no es una membresía ni un plan de QVA-Bet Club. Es una sala
          de cash independiente, con mesas desde <strong>200 USDT</strong> de
          buy-in. Entras con el buy-in, juegas con tu stack y todos los que se
          sientan reciben cada lunes el {percent}% del rake que generaron.
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

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-10">
          <div className="spinner mx-auto" />
        </div>
      ) : (
        <>
          <SectionLabel>Mesas Arena</SectionLabel>
          {tiers.length === 0 ? (
            <div className="card text-center py-8 mb-5">
              <p className="text-sm text-white font-semibold">
                No hay niveles Arena disponibles
              </p>
              <p className="text-xs text-[#a0a0b0] mt-1">
                Vuelve a intentarlo en un momento.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 mb-6 lg:grid-cols-2 xl:grid-cols-3">
              {tiers.map((tier, i) => {
                const canAfford = balance >= tier.buyIn;
                return (
                  <article
                    key={tier.id}
                    className="card animate-slideUp"
                    style={{
                      animationDelay: `${i * 40}ms`,
                      borderColor: 'rgba(255, 215, 0, 0.45)',
                      background:
                        'linear-gradient(135deg, #1c1730 0%, #16131f 100%)',
                    }}
                  >
                    <header className="flex items-start justify-between mb-3 gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-white">{tier.label}</h3>
                          <span className="text-[9px] font-bold text-[#ffd700] bg-[#ffd700]/10 border border-[#ffd700]/30 rounded-full px-2 py-0.5">
                            {tier.arenaProfitSharePercent ?? percent}% profit share
                          </span>
                        </div>
                        <p className="text-xs text-[#a0a0b0] mt-1">
                          Ciegas {fmtStake(tier.blinds.small)}/
                          {fmtStake(tier.blinds.big)} · {tier.stackInBigBlinds} BB
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide">
                          Buy-in
                        </p>
                        <p className="text-lg font-bold text-[#ffd700] leading-none">
                          {fmtUsdt(tier.buyIn)}
                        </p>
                        <p className="text-[9px] text-[#a0a0b0] mt-0.5">USDT</p>
                      </div>
                    </header>

                    <div className="grid grid-cols-3 gap-2">
                      {formats.map((formato) => {
                        const mesa = tables.find(
                          (t) =>
                            t.tierId === tier.id &&
                            t.formatId === formato.id &&
                            t.occupied < t.maxSeats,
                        );
                        const llena =
                          tables.some(
                            (t) =>
                              t.tierId === tier.id &&
                              t.formatId === formato.id &&
                              t.occupied >= t.maxSeats,
                          ) && !mesa;
                        const clave = mesa?.tableId ?? `${tier.id}-${formato.id}`;
                        const sentandoAqui = busy === clave;

                        return (
                          <button
                            key={formato.id}
                            onClick={() =>
                              entrar(
                                mesa
                                  ? { tableId: mesa.tableId }
                                  : { tierId: tier.id, formatId: formato.id },
                              )
                            }
                            disabled={sentandoAqui || !canAfford || llena}
                            className="rounded-xl px-2 py-2 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{
                              background: '#151525',
                              border: `1px solid ${mesa ? '#8a6d1d' : '#3a3350'}`,
                            }}
                          >
                            <p className="text-xs font-bold text-white">
                              {formato.shortLabel}
                            </p>
                            <p className="text-[9px] text-[#a0a0b0] mt-0.5">
                              {sentandoAqui
                                ? 'Sentando…'
                                : llena
                                  ? 'Llena'
                                  : mesa
                                    ? `${mesa.occupied}/${mesa.maxSeats} jugadores`
                                    : `${formato.maxSeats} asientos`}
                            </p>
                          </button>
                        );
                      })}
                    </div>

                    {!canAfford && (
                      <p className="text-[10px] text-[#ff8a94] mt-2">
                        Te faltan {fmtUsdt(tier.buyIn - balance)} USDT para este
                        nivel
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          {tables.length > 0 && (
            <>
              <SectionLabel>Mesas Arena abiertas</SectionLabel>
              <div className="grid gap-2 mb-6 lg:grid-cols-2">
                {tables.map((t) => {
                  const label =
                    tiers.find((tier) => tier.id === t.tierId)?.label ?? 'Arena';
                  const formato =
                    formats.find((f) => f.id === t.formatId)?.shortLabel ??
                    `${t.maxSeats}-MAX`;
                  const sentando = busy === t.tableId;
                  const llena = t.occupied >= t.maxSeats;

                  return (
                    <div
                      key={t.tableId}
                      className="rounded-xl p-3 flex items-center justify-between gap-3"
                      style={{ background: '#151525', border: '1px solid #2a2a4a' }}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{
                            background:
                              t.status === 'running' ? '#00d26a' : '#ffd700',
                          }}
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white truncate">
                            {label} · {formato} · {fmtStake(t.smallBlind)}/
                            {fmtStake(t.bigBlind)}
                          </p>
                          <p className="text-[10px] text-[#a0a0b0]">
                            {t.occupied}/{t.maxSeats} jugadores ·{' '}
                            {t.status === 'running' ? 'en juego' : 'esperando'}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => entrar({ tableId: t.tableId })}
                        disabled={sentando || llena}
                        className="btn btn-outline px-3 py-1.5 text-xs shrink-0 disabled:opacity-50"
                      >
                        {llena ? 'Llena' : sentando ? '…' : 'Entrar'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div
            className="rounded-2xl p-4 mb-4"
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
                  : `Próximo pago: ${fechaCorta(arena?.nextPayoutAt)}. Juega en las mesas Arena de arriba.`}
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
              className="w-full btn btn-outline py-3 text-sm"
            >
              Ir al lobby de cash normal
            </button>
          )}
        </>
      )}
    </div>
  );
}
