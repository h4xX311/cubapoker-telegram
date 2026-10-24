import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { CashTier, TableSummary } from '../lib/types';
import { PageHeader, SectionLabel } from '../components/Layout';
import { fmtUsdt, fmtStake } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
}

/**
 * LOBBY DE CASH (RING TABLES)
 * ===========================
 *
 * Cash no es un torneo de 300 personas: es una mesa 7-max en la que entras con
 * un buy-in, juegas las manos que quieras y te levantas con tus fichas. Por eso
 * esta pantalla no muestra bote, premio al ganador ni reparto por posiciones:
 * esos numeros pertenecen a los torneos, no al cash.
 *
 * La pantalla resuelve tres cosas:
 *   1. Cuanto cuesta sentarse y con que ciegas.
 *   2. Si ya estas sentado en alguna mesa (para no cobrarte dos buy-ins).
 *   3. Si hay mesas abiertas a las que entrar sin esperar.
 */
export function Tables({
  user,
  onBack,
  onBalanceChange,
  onPlay,
}: Props) {
  const [tiers, setTiers] = useState<CashTier[]>([]);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [seatsPerTable, setSeatsPerTable] = useState(7);
  const [unlockRatio, setUnlockRatio] = useState('1:10');
  const [miMesa, setMiMesa] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [cfg, list, mine] = await Promise.all([
        api.gameConfig(),
        api.listTables(),
        api.myTable(),
      ]);

      setTiers(cfg?.cashTiers ?? []);
      if (cfg?.seatsPerTable) setSeatsPerTable(cfg.seatsPerTable);
      if (cfg?.unlock?.ratioLabel) setUnlockRatio(cfg.unlock.ratioLabel);

      // Solo mesas sueltas. Las mesas que pertenecen a un campo multi-mesa
      // (torneo, freeroll o centroll) se juegan desde su propia pantalla.
      setTables((list?.tables ?? []).filter((t: TableSummary) => !t.field));
      setMiMesa(mine?.tableId ?? null);
    } catch {
      // Si falla una carga puntual no se borra lo que ya se veia: el polling
      // vuelve a intentarlo en unos segundos.
      setError('No se pudieron cargar las mesas. Reintentando…');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, []);

  const entrar = async (destino: { tierId?: string; tableId?: string }) => {
    const clave = destino.tableId ?? destino.tierId ?? '';
    setBusy(clave);
    setError('');

    try {
      // Si ya hay una mesa abierta, se abre esa. El servidor rechazaria un
      // segundo asiento y el jugador no tendria forma de volver a la primera.
      if (miMesa) {
        onPlay(miMesa);
        return;
      }

      const res = await api.sit(destino);
      await onBalanceChange?.();

      if (res?.tableId) {
        onPlay(res.tableId);
        return;
      }

      const mine = await api.myTable();
      if (mine?.tableId) {
        onPlay(mine.tableId);
        return;
      }

      setError('Te has sentado. Vuelve a entrar para ver tu mesa.');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo entrar en la mesa.',
      );
    } finally {
      setBusy(null);
    }
  };

  const balance = user?.balance?.total ?? 0;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Mesas cash" onBack={onBack} />

      {/* Saldo disponible para jugar */}
      <div
        className="rounded-2xl p-4 mb-5 flex items-center justify-between"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <div>
          <p className="text-[#a0a0b0] text-xs">Saldo disponible</p>
          <p className="text-2xl font-bold text-[#00d26a]">
            {fmtUsdt(balance)}{' '}
            <span className="text-xs font-semibold text-[#a0a0b0]">USDT</span>
          </p>
        </div>
        <div className="text-right text-[10px] text-[#a0a0b0] leading-relaxed">
          <p>Retirable: {fmtUsdt(user?.balance?.real ?? 0)} USDT</p>
          <p>Promoción: {fmtUsdt(user?.balance?.play ?? 0)} USDT</p>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {/* Ya sentado: no se ofrece comprar otra entrada */}
      {miMesa && (
        <div
          className="rounded-2xl p-4 mb-5"
          style={{ background: '#12241c', border: '1px solid #00d26a' }}
        >
          <div className="flex items-start gap-3">
            <span className="relative flex h-3 w-3 mt-1 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00d26a] opacity-60" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-[#00d26a]" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-white text-sm">Ya estás en una mesa</p>
              <p className="text-xs text-[#a0a0b0] mt-1">
                Vuelve a ella para seguir jugando. No hace falta comprar otra
                entrada.
              </p>
            </div>
          </div>
          <button
            onClick={() => onPlay(miMesa)}
            className="w-full btn btn-primary py-2.5 text-sm mt-3"
          >
            Volver a mi mesa
          </button>
        </div>
      )}

      {loading && tiers.length === 0 ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto" />
        </div>
      ) : tiers.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-4xl mb-3">♠</div>
          <p className="text-sm text-white font-semibold mb-1">
            No hay mesas disponibles
          </p>
          <p className="text-xs text-[#a0a0b0]">
            Se abrirán en un momento. Vuelve a intentarlo.
          </p>
        </div>
      ) : (
        <>
          {!miMesa && (
            <>
          <SectionLabel>Elige tu nivel</SectionLabel>
          <div className="space-y-3 mb-6">
            {tiers.map((tier, i) => {
              const canAfford = balance >= tier.buyIn;
              const sentando = busy === tier.id;

              return (
                <article
                  key={tier.id}
                  className="card animate-slideUp"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <header className="flex items-start justify-between mb-3 gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white">{tier.label}</h3>
                        <span className="badge badge-success">
                          {seatsPerTable}-max
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
                      <p className="text-lg font-bold text-white leading-none">
                        {fmtUsdt(tier.buyIn)}
                      </p>
                      <p className="text-[9px] text-[#a0a0b0] mt-0.5">USDT</p>
                    </div>
                  </header>

                  <button
                    onClick={() => entrar({ tierId: tier.id })}
                    disabled={sentando || (!miMesa && !canAfford)}
                    className="w-full btn btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sentando
                      ? 'Sentando…'
                      : miMesa
                      ? 'Volver a mi mesa'
                      : !canAfford
                      ? `Te faltan ${fmtUsdt(tier.buyIn - balance)} USDT`
                      : `Jugar ahora · ${fmtUsdt(tier.buyIn)} USDT`}
                  </button>
                </article>
              );
            })}
          </div>

          {/* Mesas que ya existen: entrar sin crear otra */}
          {tables.length > 0 && (
            <>
              <SectionLabel>Mesas abiertas</SectionLabel>
              <div className="space-y-2 mb-6">
                {tables.map((t) => {
                  const label =
                    tiers.find((tier) => tier.id === t.tierId)?.label ?? 'Cash';
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
                            {label} · {fmtStake(t.smallBlind)}/
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
            </>
          )}

          <div className="card">
            <p className="text-xs text-[#a0a0b0] leading-relaxed">
              <span className="text-white font-semibold">Cómo funciona:</span> cada
              mesa es {seatsPerTable}-max. Entras con el buy-in, juegas con tus
              fichas y, cuando te levantas, vuelven a tu saldo. El saldo de
              promoción se desbloquea {unlockRatio} al usarlo.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
