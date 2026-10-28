import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { CashFormat, CashTier, MyTable, TableSummary } from '../lib/types';
import { PageHeader, SectionLabel } from '../components/Layout';
import { fmtUsdt, fmtStake } from '../components/Balance';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
  /** Abre la sala VIP Arena, que es un lobby aparte. */
  onOpenArena?: () => void;
}

/**
 * Modalidades del lobby.
 *
 * El motor de esta version solo resuelve No-Limit Hold'em. PLO y Short Deck
 * necesitan un evaluador y una baraja distintos, asi que se muestran como
 * proximamente en vez de abrir una mesa que no puede jugar. Es preferible una
 * sala vacia y honesta a cobrar un buy-in por un juego que no existe.
 */
const MODOS = [
  {
    id: 'nlh',
    siglas: 'NLH',
    nombre: "No-Limit Hold'em",
    listo: true,
  },
  {
    id: 'plo',
    siglas: 'PLO',
    nombre: 'Pot-Limit Omaha',
    listo: false,
  },
  {
    id: 'short-deck',
    siglas: '6+',
    nombre: 'Short Deck',
    listo: false,
  },
] as const;

type ModoId = (typeof MODOS)[number]['id'];

/**
 * Formatos base mientras llega la configuracion del servidor.
 *
 * El orden importa: 6-max y Heads-Up son las salas principales del lobby. El
 * 7-max se conserva como mesa llena para quien prefiera el formato clasico.
 */
const FORMATOS_BASE: CashFormat[] = [
  { id: '6max', label: '6-max', shortLabel: '6-MAX', maxSeats: 6 },
  { id: 'hu', label: 'Heads-Up', shortLabel: 'HU', maxSeats: 2 },
  { id: '7max', label: '7-max', shortLabel: '7-MAX', maxSeats: 7 },
];

const ORDEN_FORMATO: Record<string, number> = {
  '6max': 0,
  hu: 1,
  '7max': 2,
};

/**
 * LOBBY DE CASH NORMAL
 * ====================
 *
 * Cash no es un torneo: el jugador entra con un buy-in, juega las manos que
 * quiera y se levanta con su stack. Esta pantalla no muestra bote garantizado,
 * premios por posicion ni nada que se parezca a un torneo.
 *
 * La navegacion esta pensada como la de una sala real:
 *
 *   modalidad -> nivel de ciegas -> formato de mesa -> entrar
 *
 * Cada nivel muestra sus ciegas, el buy-in minimo y las mesas disponibles con
 * su ocupacion. El jugador puede sentarse en varias mesas a la vez; la barra
 * superior de mesas activas conserva sus cartas privadas.
 *
 * VIP Arena no aparece mezclada aqui: tiene su propia pantalla, sus propios
 * niveles y su propio profit share.
 */
export function Tables({
  user,
  onBack,
  onBalanceChange,
  onPlay,
  onOpenArena,
}: Props) {
  const [tiers, setTiers] = useState<CashTier[]>([]);
  const [formats, setFormats] = useState<CashFormat[]>(FORMATOS_BASE);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [misMesas, setMisMesas] = useState<MyTable[]>([]);
  const [unlockRatio, setUnlockRatio] = useState('1:10');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [modo, setModo] = useState<ModoId>('nlh');
  const [stakeFiltro, setStakeFiltro] = useState<string>('all');
  const [formatoRapido, setFormatoRapido] = useState<CashFormat['id']>('6max');

  const load = async () => {
    try {
      const [cfg, list, mine] = await Promise.all([
        api.gameConfig(),
        api.listTables(),
        api.myTables(),
      ]);

      const normales = (cfg?.cashTiers ?? []).filter(
        (t: CashTier) => !t.vipArena,
      );
      setTiers(normales);

      const formatos = (cfg?.cashFormats ?? FORMATOS_BASE).slice();
      formatos.sort(
        (a: CashFormat, b: CashFormat) =>
          (ORDEN_FORMATO[a.id] ?? 9) - (ORDEN_FORMATO[b.id] ?? 9),
      );
      setFormats(formatos.length > 0 ? formatos : FORMATOS_BASE);

      if (cfg?.unlock?.ratioLabel) setUnlockRatio(cfg.unlock.ratioLabel);

      const idsNormales = new Set(normales.map((t: CashTier) => t.id));
      setTables(
        (list?.tables ?? []).filter(
          (t: TableSummary) => !t.field && idsNormales.has(t.tierId),
        ),
      );
      setMisMesas(mine?.tables ?? []);
    } catch {
      // Si falla una carga puntual no se borra lo que ya se veia: el polling
      // vuelve a intentarlo en unos segundos.
      setError('No se pudieron cargar las mesas. Reintentando...');
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
    formatId?: CashFormat['id'];
  }) => {
    const clave =
      destino.tableId ?? `${destino.tierId ?? ''}-${destino.formatId ?? ''}`;
    setBusy(clave);
    setError('');

    try {
      // Si ya tengo asiento en esa mesa, solo hay que abrirla. Para una mesa
      // nueva se cobra otro buy-in, porque el stack vive en cada mesa.
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
        err instanceof ApiError ? err.message : 'No se pudo entrar en la mesa.',
      );
    } finally {
      setBusy(null);
    }
  };

  const balance = user?.balance?.total ?? 0;
  const mesasNormales = misMesas.filter((m) => m.kind === 'cash');
  const modoActivo = MODOS.find((m) => m.id === modo) ?? MODOS[0];
  const modoListo = modoActivo.listo;

  const formatos = [...formats].sort(
    (a, b) => (ORDEN_FORMATO[a.id] ?? 9) - (ORDEN_FORMATO[b.id] ?? 9),
  );

  const tiersVisibles =
    stakeFiltro === 'all'
      ? tiers
      : tiers.filter((tier) => tier.id === stakeFiltro);

  /**
   * Mesa sugerida para "Unirse rapidamente".
   *
   * Con un filtro de nivel puesto se respeta ese nivel. Sin filtro se elige el
   * nivel mas bajo que el jugador pueda pagar: la entrada rapida nunca debe
   * arriesgar mas de lo necesario por adivinar el stake del jugador. Si no
   * puede pagar ninguno, se muestra el mas barato con el aviso de saldo.
   */
  const quickTier = (() => {
    if (!modoListo) return null;
    if (stakeFiltro !== 'all') {
      return tiers.find((tier) => tier.id === stakeFiltro) ?? null;
    }
    const asequibles = [...tiers]
      .filter((tier) => balance >= tier.buyIn)
      .sort((a, b) => a.buyIn - b.buyIn);
    return asequibles[0] ?? tiers[0] ?? null;
  })();

  const quickFormato =
    formatos.find((formato) => formato.id === formatoRapido) ??
    formatos[0] ??
    FORMATOS_BASE[0];

  const quickMia = quickTier
    ? mesasNormales.find(
        (m) =>
          m.tierId === quickTier.id &&
          m.formatId === quickFormato.id &&
          m.kind === 'cash',
      )
    : undefined;

  const quickMesa = quickTier
    ? tables.find(
        (t) =>
          t.tierId === quickTier.id &&
          t.formatId === quickFormato.id &&
          t.occupied < t.maxSeats,
      )
    : undefined;

  const quickClave =
    quickMia?.tableId ??
    quickMesa?.tableId ??
    `${quickTier?.id ?? ''}-${quickFormato.id}`;

  const quickSinSaldo = !!quickTier && balance < quickTier.buyIn;

  const unirseRapido = async () => {
    if (!quickTier || !modoListo || quickSinSaldo) return;
    if (quickMia) {
      onPlay(quickMia.tableId);
      return;
    }
    if (quickMesa) {
      await entrar({ tableId: quickMesa.tableId });
      return;
    }
    await entrar({ tierId: quickTier.id, formatId: quickFormato.id });
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn lg:px-0">
      <PageHeader title="Mesas cash" onBack={onBack} />

      <div
        className="rounded-2xl p-4 mb-5 flex items-center justify-between gap-3"
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

      {/* Mesas activas: informa, no bloquea. El multimesa es parte del producto. */}
      {mesasNormales.length > 0 && (
        <div
          className="rounded-2xl p-4 mb-5"
          style={{ background: '#12241c', border: '1px solid #00d26a' }}
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <p className="font-bold text-white text-sm">
                {mesasNormales.length === 1
                  ? 'Estás jugando una mesa'
                  : `Estás jugando ${mesasNormales.length} mesas`}
              </p>
              <p className="text-[11px] text-[#a0a0b0] mt-0.5">
                Puedes abrir otra o volver a cualquiera desde la barra superior.
              </p>
            </div>
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00d26a] opacity-60" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-[#00d26a]" />
            </span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {mesasNormales.map((m) => (
              <button
                key={m.tableId}
                onClick={() => onPlay(m.tableId)}
                className="shrink-0 rounded-lg px-3 py-2 text-left"
                style={{ background: '#0f1d17', border: '1px solid #2f6b4f' }}
              >
                <p className="text-[11px] font-semibold text-white">
                  {m.label} · {m.formatId?.toUpperCase()}
                </p>
                <p className="text-[10px] text-[#7ee2b0]">
                  {fmtUsdt(m.displayChips)} USDT
                  {m.isMyTurn ? ' · te toca' : ''}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      <SectionLabel>Jugar rápido</SectionLabel>

      <section
        className="rounded-2xl p-4 mb-6"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr_auto] lg:items-end">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[#a0a0b0] mb-2">
              Modalidad
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {MODOS.map((m) => {
                const activo = m.id === modo;
                return (
                  <button
                    key={m.id}
                    onClick={() => setModo(m.id)}
                    className="shrink-0 rounded-xl px-3 py-2 text-left transition-colors"
                    style={{
                      background: activo ? '#0f2a20' : '#151525',
                      border: `1px solid ${activo ? '#00d26a' : '#2a2a4a'}`,
                    }}
                  >
                    <p
                      className="text-xs font-bold"
                      style={{ color: activo ? '#00d26a' : '#ffffff' }}
                    >
                      {m.siglas}
                    </p>
                    <p className="text-[9px] text-[#a0a0b0] mt-0.5">
                      {m.listo ? m.nombre : 'Próximamente'}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wide text-[#a0a0b0] mb-2">
              Nivel de ciegas
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                onClick={() => setStakeFiltro('all')}
                className="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
                style={{
                  background: stakeFiltro === 'all' ? '#0f2a20' : '#151525',
                  border: `1px solid ${
                    stakeFiltro === 'all' ? '#00d26a' : '#2a2a4a'
                  }`,
                  color: stakeFiltro === 'all' ? '#00d26a' : '#ffffff',
                }}
              >
                Todos
              </button>
              {tiers.map((tier) => {
                const activo = stakeFiltro === tier.id;
                return (
                  <button
                    key={tier.id}
                    onClick={() => setStakeFiltro(tier.id)}
                    className="shrink-0 rounded-xl px-3 py-2 text-left transition-colors"
                    style={{
                      background: activo ? '#0f2a20' : '#151525',
                      border: `1px solid ${activo ? '#00d26a' : '#2a2a4a'}`,
                    }}
                  >
                    <p
                      className="text-xs font-bold"
                      style={{ color: activo ? '#00d26a' : '#ffffff' }}
                    >
                      {tier.label}
                    </p>
                    <p className="text-[9px] text-[#a0a0b0] mt-0.5">
                      {fmtUsdt(tier.buyIn)} USDT
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wide text-[#a0a0b0] mb-2">
              Formato
            </p>
            <div className="flex gap-2">
              {formatos.map((formato) => {
                const activo = formato.id === formatoRapido;
                return (
                  <button
                    key={formato.id}
                    onClick={() => setFormatoRapido(formato.id)}
                    className="rounded-xl px-3 py-2 text-xs font-bold transition-colors"
                    style={{
                      background: activo ? '#0f2a20' : '#151525',
                      border: `1px solid ${activo ? '#00d26a' : '#2a2a4a'}`,
                      color: activo ? '#00d26a' : '#ffffff',
                    }}
                  >
                    {formato.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {!modoListo ? (
          <div className="mt-4 rounded-xl p-3 bg-[#ffd700]/10 border border-[#ffd700]/40">
            <p className="text-xs text-[#ffd700] font-semibold">
              {modoActivo.nombre} todavía no está disponible.
            </p>
            <p className="text-[11px] text-[#a0a0b0] mt-1">
              El motor de esta versión solo resuelve No-Limit Hold'em. Elige NLH
              para jugar. No se abre ninguna mesa de PLO o Short Deck hasta que
              su motor esté listo.
            </p>
          </div>
        ) : (
          <div className="mt-4 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-[#0f1d17] border border-[#2f6b4f]">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-[#7ee2b0] mb-0.5">
                Mesa sugerida
              </p>
              <p className="text-sm font-bold text-white truncate">
                {quickTier
                  ? `${quickTier.label} · ${quickFormato.shortLabel} · ${fmtUsdt(
                      quickTier.buyIn,
                    )} USDT`
                  : 'No hay mesas disponibles'}
              </p>
              <p className="text-[10px] text-[#a0a0b0] mt-0.5">
                {quickTier
                  ? `Ciegas ${fmtStake(quickTier.blinds.small)}/${fmtStake(
                      quickTier.blinds.big,
                    )} USDT · ${
                      quickMia
                        ? 'ya tienes asiento'
                        : `${quickMesa?.occupied ?? 0}/${
                            quickMesa?.maxSeats ?? quickFormato.maxSeats
                          } jugadores`
                    }`
                  : 'Prueba otro nivel de ciegas.'}
              </p>
              {quickSinSaldo && quickTier && (
                <p className="text-[10px] text-[#ff8a94] mt-1">
                  Te faltan {fmtUsdt(quickTier.buyIn - balance)} USDT para este
                  nivel.
                </p>
              )}
            </div>
            <button
              onClick={() => void unirseRapido()}
              disabled={
                !modoListo ||
                !quickTier ||
                quickSinSaldo ||
                !!busy
              }
              className="btn btn-primary px-5 py-2.5 text-sm shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === quickClave
                ? 'Entrando...'
                : quickMia
                  ? 'Volver a mi mesa'
                  : 'Unirse rápidamente'}
            </button>
          </div>
        )}
      </section>

      {!modoListo ? (
        <div className="card text-center py-10 mb-6">
          <div className="text-4xl mb-3">♠</div>
          <p className="text-sm text-white font-semibold mb-1">
            {modoActivo.nombre}: próximamente
          </p>
          <p className="text-xs text-[#a0a0b0] max-w-sm mx-auto">
            Cuando el evaluador de Omaha o la baraja de Short Deck estén
            integrados, sus mesas aparecerán aquí con las mismas reglas de
            stack, rake y seguridad que NLH.
          </p>
          <button
            onClick={() => setModo('nlh')}
            className="btn btn-outline px-4 py-2 text-xs mt-4"
          >
            Ver mesas NLH
          </button>
        </div>
      ) : loading && tiers.length === 0 ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto" />
        </div>
      ) : tiersVisibles.length === 0 ? (
        <div className="card text-center py-10 mb-5">
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
          <SectionLabel>Mesas por nivel</SectionLabel>

          <div className="grid gap-4 mb-6 lg:grid-cols-2">
            {tiersVisibles.map((tier, i) => {
              const canAfford = balance >= tier.buyIn;
              return (
                <article
                  key={tier.id}
                  className="card animate-slideUp"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <header className="flex items-start justify-between mb-3 gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-white">{tier.label}</h3>
                        <span
                          className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
                          style={{
                            color: '#00d26a',
                            background: 'rgba(0, 210, 106, 0.12)',
                          }}
                        >
                          {tier.stackInBigBlinds} BB
                        </span>
                      </div>
                      <p className="text-xs text-[#a0a0b0] mt-1">
                        Ciegas {fmtStake(tier.blinds.small)}/
                        {fmtStake(tier.blinds.big)} USDT
                      </p>
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide">
                        Buy-in mínimo
                      </p>
                      <p className="text-lg font-bold text-white leading-none">
                        {fmtUsdt(tier.buyIn)}
                      </p>
                      <p className="text-[9px] text-[#a0a0b0] mt-0.5">USDT</p>
                    </div>
                  </header>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {formatos.map((formato) => {
                      const mesaAbierta = tables.find(
                        (t) =>
                          t.tierId === tier.id &&
                          t.formatId === formato.id &&
                          t.occupied < t.maxSeats,
                      );
                      const miMesa = mesasNormales.find(
                        (m) =>
                          m.kind === 'cash' &&
                          m.tierId === tier.id &&
                          m.formatId === formato.id,
                      );
                      const mesaFull = tables.find(
                        (t) =>
                          t.tierId === tier.id &&
                          t.formatId === formato.id &&
                          t.occupied >= t.maxSeats,
                      );
                      const llena = !miMesa && !mesaAbierta && !!mesaFull;
                      const clave =
                        miMesa?.tableId ??
                        mesaAbierta?.tableId ??
                        `${tier.id}-${formato.id}`;
                      const sentandoAqui = busy === clave;
                      const sinSaldo = !canAfford && !miMesa;

                      const etiqueta = miMesa
                        ? 'Volver'
                        : sentandoAqui
                          ? 'Entrando...'
                          : llena
                            ? 'Abrir nueva'
                            : 'Entrar';

                      return (
                        <button
                          key={formato.id}
                          onClick={() =>
                            void entrar(
                              miMesa
                                ? { tableId: miMesa.tableId }
                                : mesaAbierta
                                  ? { tableId: mesaAbierta.tableId }
                                  : {
                                      tierId: tier.id,
                                      formatId: formato.id,
                                    },
                            )
                          }
                          disabled={sentandoAqui || sinSaldo}
                          className="rounded-xl p-3 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          style={{
                            background: miMesa ? '#0f2a20' : '#151525',
                            border: `1px solid ${
                              miMesa
                                ? '#00d26a'
                                : mesaAbierta
                                  ? '#2f6b4f'
                                  : '#2a2a4a'
                            }`,
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-[9px] uppercase tracking-wide text-[#a0a0b0]">
                                {formato.id === 'hu'
                                  ? 'Mano a mano'
                                  : 'Multijugador'}
                              </p>
                              <p className="text-sm font-bold text-white mt-0.5">
                                {formato.shortLabel}
                              </p>
                            </div>
                            <span className="text-[10px] font-bold text-[#00d26a]">
                              {miMesa
                                ? 'Jugando'
                                : mesaAbierta
                                  ? `${mesaAbierta.occupied}/${mesaAbierta.maxSeats}`
                                  : mesaFull
                                    ? `${mesaFull.occupied}/${mesaFull.maxSeats}`
                                    : `0/${formato.maxSeats}`}
                            </span>
                          </div>

                          <p className="text-[10px] text-[#a0a0b0] mt-2">
                            {miMesa
                              ? 'Tienes asiento en esta mesa'
                              : llena
                                ? 'Mesa completa; se abre otra'
                                : mesaAbierta
                                  ? (() => {
                                      const libres =
                                        mesaAbierta.maxSeats -
                                        mesaAbierta.occupied;
                                      return `${libres} ${
                                        libres === 1
                                          ? 'asiento libre'
                                          : 'asientos libres'
                                      }`;
                                    })()
                                  : `Mesa nueva de ${formato.maxSeats}`}
                          </p>

                          <span
                            className="inline-block mt-2 text-[10px] font-bold"
                            style={{
                              color: miMesa
                                ? '#00d26a'
                                : sinSaldo
                                  ? '#a0a0b0'
                                  : '#ffffff',
                            }}
                          >
                            {etiqueta}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {!canAfford && (
                    <p className="text-[10px] text-[#ff8a94] mt-2">
                      Te faltan {fmtUsdt(tier.buyIn - balance)} USDT para este
                      nivel.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}

      {/* Arena no se mezcla con los niveles normales. */}
      {onOpenArena && (
        <button
          onClick={onOpenArena}
          className="w-full text-left rounded-2xl p-4 mb-5"
          style={{
            background: 'linear-gradient(135deg, #1c1730 0%, #16131f 100%)',
            border: '1px solid rgba(255, 215, 0, 0.55)',
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#ffd700]">
                Sala independiente
              </p>
              <p className="text-white font-bold mt-1">VIP Arena</p>
              <p className="text-[11px] text-[#a0a0b0] mt-1">
                Mesas propias desde 200 USDT. Profit share del 15 % del rake.
              </p>
            </div>
            <span className="text-[#ffd700] text-2xl">→</span>
          </div>
        </button>
      )}

      <div className="card">
        <p className="text-xs text-[#a0a0b0] leading-relaxed">
          <span className="text-white font-semibold">Cómo funciona:</span> cada
          nivel tiene 6-max, Heads-Up y 7-max. Entras con el buy-in, juegas con
          tu stack y, cuando te levantas, vuelve a tu saldo. El saldo de
          promoción se desbloquea {unlockRatio} al usarlo. Puedes tener varias
          mesas abiertas a la vez.
        </p>
      </div>
    </div>
  );
}
