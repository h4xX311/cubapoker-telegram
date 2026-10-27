import { useState, useEffect, useRef, useMemo } from 'react';
import { evaluarMano, parseCard, type Card } from '../lib/handStrength';
import { api, ApiError } from '../lib/api';
import { PageHeader } from '../components/Layout';
import {
  SUIT_SYMBOL,
  isRedSuit,
  PHASE_LABEL,
  type TableView,
} from '../lib/types';

interface Props {
  tableId: string;
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

/** Frecuencia de refresco. 1.5s da respuesta sin hammering al servidor. */
const POLL_MS = 1500;

/**
 * Que ha hecho cada jugador en la calle actual, en palabras.
 *
 * Sin esto, mirar la mesa es mirar un bote que sube sin saber por que: no se distingue si un
 * rival ha igualado, si ha subido, o si se ha retirado. Es la informacion que convierte una
 * lista de jugadores en una partida.
 *
 * El dato lo manda el servidor en `lastAction` por asiento. Si llega algo que no esta aqui,
 * se muestra en crudo: mejor una etiqueta rara que no perder la informacion.
 */
const LAST_ACTION_LABEL: Record<string, string> = {
  fold: 'Pass',
  check: 'Pass',
  call: 'Iguala',
  bet: 'Apuesta',
  raise: 'Sube',
  all_in: 'All-in',
  'all-in': 'All-in',
};

const LAST_ACTION_COLOR: Record<string, { bg: string; fg: string }> = {
  fold: { bg: 'rgba(160,160,176,0.15)', fg: '#a0a0b0' },
  check: { bg: 'rgba(160,160,176,0.15)', fg: '#a0a0b0' },
  call: { bg: 'rgba(52,152,219,0.18)', fg: '#5dade2' },
  bet: { bg: 'rgba(255,215,0,0.18)', fg: '#ffd700' },
  raise: { bg: 'rgba(231,76,60,0.18)', fg: '#ff8a94' },
  all_in: { bg: 'rgba(0,210,106,0.2)', fg: '#00d26a' },
  'all-in': { bg: 'rgba(0,210,106,0.2)', fg: '#00d26a' },
};

/**
 * Color del avatar a partir del nombre.
 *
 * Todos los asientos usan el mismo criterio: no hay un color "de humano" y otro
 * "de bot". El color es estable para el mismo nombre, como el avatar que una
 * plataforma genera por defecto para cualquier jugador.
 */
const AVATAR_COLORS = [
  '#2c3e50',
  '#34495e',
  '#7d3c98',
  '#1f618d',
  '#117a65',
  '#a04000',
  '#7b241c',
  '#566573',
];

interface SeatPos {
  x: number;
  y: number;
}

/**
 * Posiciones de los asientos alrededor del fieltro, en porcentaje.
 *
 * El índice 0 es SIEMPRE el jugador que mira: abajo al centro. Así la mesa no
 * cambia de orientación al sentarse en un asiento distinto, y sus cartas y sus
 * acciones quedan donde todo el mundo las busca. Los demás se colocan en
 * sentido horario.
 *
 * Son coordenadas de centro: el asiento se traslada con translate(-50%,-50%).
 * Con una tarjeta de ~68 px, x=11 % deja el borde izquierdo dentro de pantalla
 * en un móvil de 360 px.
 */
const SEAT_LAYOUTS: Record<number, SeatPos[]> = {
  2: [
    { x: 50, y: 90 },
    { x: 50, y: 12 },
  ],
  3: [
    { x: 50, y: 90 },
    { x: 15, y: 22 },
    { x: 85, y: 22 },
  ],
  4: [
    { x: 50, y: 90 },
    { x: 11, y: 45 },
    { x: 50, y: 10 },
    { x: 89, y: 45 },
  ],
  5: [
    { x: 50, y: 90 },
    { x: 13, y: 67 },
    { x: 29, y: 12 },
    { x: 71, y: 12 },
    { x: 87, y: 67 },
  ],
  6: [
    { x: 50, y: 90 },
    { x: 15, y: 72 },
    { x: 11, y: 40 },
    { x: 29, y: 13 },
    { x: 71, y: 13 },
    { x: 89, y: 40 },
  ],
  7: [
    { x: 50, y: 90 },
    { x: 15, y: 72 },
    { x: 11, y: 40 },
    { x: 27, y: 13 },
    { x: 73, y: 13 },
    { x: 89, y: 40 },
    { x: 85, y: 72 },
  ],
};

/** Si el formato no está en la tabla, se reparte en círculo. */
const posicionesDe = (maxSeats: number): SeatPos[] => {
  const fijas = SEAT_LAYOUTS[maxSeats];
  if (fijas) return fijas;

  const total = Math.max(2, Math.min(9, maxSeats || 7));
  return Array.from({ length: total }, (_, i) => {
    const angulo = Math.PI / 2 + (i * 2 * Math.PI) / total;
    return {
      x: 50 + Math.cos(angulo) * 40,
      y: 50 + Math.sin(angulo) * 42,
    };
  });
};

const avatarColor = (name: string): string => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

export function Table({ tableId, onBack, onBalanceChange }: Props) {
  const [view, setView] = useState<TableView | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  // Objetivo de subida en unidades internas (las mismas que manda el motor).
  const [raiseTo, setRaiseTo] = useState(0);

  const prevPhase = useRef<string>('');

  // ------------------------------------------------------------------
  // SUBIR: EL AMOUNT ES EL TOTAL, NO EL INCREMENTO
  //
  // El motor recibe el total al que queda la apuesta. Antes la UI mandaba
  // `currentBet * 2`, el motor lo interpretaba como un incremento y el jugador
  // acababa apostando el doble de lo que pidió. Aquí se calcula el rango real:
  // mínimo legal, máximo (su stack) y un objetivo de media pote.
  // ------------------------------------------------------------------
  const minRaiseTarget = view
    ? view.hand.currentBet + Math.max(1, view.minRaise ?? view.bigBlind)
    : 0;
  const maxRaiseTarget = view
    ? Math.max(0, (view.myBet ?? 0) + (view.myChips ?? 0))
    : 0;
  const canRaiseTarget = !!view && maxRaiseTarget > view.hand.currentBet && maxRaiseTarget >= minRaiseTarget;
  const suggestedRaise = view
    ? Math.min(
        maxRaiseTarget,
        Math.max(
          minRaiseTarget,
          Math.round(view.hand.currentBet + Math.max(view.hand.pot * 0.6, view.minRaise ?? view.bigBlind)),
        ),
      )
    : 0;
  const raiseValue = Math.min(
    maxRaiseTarget,
    Math.max(minRaiseTarget, raiseTo > 0 ? raiseTo : suggestedRaise),
  );

  useEffect(() => {
    if (!view?.isMyTurn || !canRaiseTarget) return;
    // Solo se reinicia cuando empieza un turno nuevo. El polling no debe mover
    // el slider que el jugador está arrastrando.
    setRaiseTo(suggestedRaise);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view?.isMyTurn,
    view?.hand.handNumber,
    view?.hand.phase,
    view?.hand.currentBet,
    view?.minRaise,
    view?.myChips,
    view?.myBet,
  ]);

  // --- Carga y polling ---
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await api.tableView(tableId);
        if (cancelled) return;

        if (res.spectator) {
          setError('No estás sentado en esta mesa.');
          return;
        }

        const next = res.state as TableView;
        setView(next);
        setError('');

        // Refresca el saldo del wallet cuando la mano termina
        if (next.hand.phase === 'finished' && prevPhase.current !== 'finished') {
          onBalanceChange?.();
        }
        prevPhase.current = next.hand.phase;
      } catch (err) {
        if (cancelled) return;

        // ------------------------------------------------------------------
        // ANTES, AQUI NO PASABA NADA
        //
        // Solo se miraba el 404. Cualquier otro error se tragaba sin decir nada, y como
        // `view` se queda a null, la pantalla se quedaba en el spinner PARA SIEMPRE: sin
        // mensaje, sin error, sin pista de si era la API, el servidor o el render.
        //
        // Tres fallos muy distintos se veian exactamente igual:
        //
        //   - la API devuelve algo que no es JSON (backend caido, 500 del proxy)
        //   - la sesion expiro (401)
        //   - cualquier otro error de la peticion
        //
        // Ahora todos se dicen. Un error que no se ve no se puede arreglar: se persiguen
        // las causas equivocadas.
        // ------------------------------------------------------------------
        if (err instanceof ApiError && err.status === 404) {
          setError('La mesa ya no existe.');
        } else if (err instanceof ApiError) {
          console.error('[cubapoker] fallo al cargar la mesa:', err.message, err.code);
          setError(err.message);
        } else {
          console.error('[cubapoker] fallo inesperado al cargar la mesa:', err);
          setError('No se pudo cargar la mesa. Vuelve a entrar.');
        }
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tableId, onBalanceChange]);

  // --- Cuenta atras del turno ---
  useEffect(() => {
    if (!view?.turnEndsAt || !view.isMyTurn) {
      setRemaining(null);
      return;
    }

    const update = () => {
      const end = new Date(view.turnEndsAt!).getTime();
      setRemaining(Math.max(0, Math.floor((end - Date.now()) / 1000)));
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [view?.turnEndsAt, view?.isMyTurn]);

  const act = async (action: string, amount?: number) => {
    if (acting) return;
    setActing(true);
    setError('');
    try {
      const res = await api.gameAction(tableId, action, amount);
      if (res.state) setView(res.state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Acción no válida.');
    } finally {
      setActing(false);
    }
  };

  const leave = async () => {
    setActing(true);
    try {
      await api.stand(tableId);
      await onBalanceChange?.();
      onBack();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo salir.');
      setActing(false);
    }
  };

  // ------------------------------------------------------------------
  // LOS HOOKS, ANTES DE CUALQUIER `return` TEMPRANO
  //
  // ------------------------------------------------------------------
  // ESTA POSICION NO ES COSA ESTETICA, ES UNA REGLA
  //
  // Este hook estaba DESPUES del `if (!view) return <cargando/>`. Eso rompe la regla de los
  // hooks de React: en el primer render `view` es null y se sale antes de llegar al hook; en el
  // siguiente ya hay vista y se ejecuta. Un render llama a 6 hooks y el siguiente a 7, y React
  // aborta con:
  //
  //     Minified React error #310: Rendered more hooks than during the previous render.
  //
  // Pantalla en blanco. Lo que se vio en produccion.
  //
  // Un hook SIEMPRE va antes de cualquier `return` temprano, y el caso de que falte el dato se
  // comprueba DENTRO del hook, no fuera. Por eso aqui empieza con `if (!view) return null`.
  // ------------------------------------------------------------------
  const fuerza = useMemo(() => {
    if (!view) return null;
    // Las tuyas llegan como objetos; las comunitarias, como "rank|suit". Antes
    // se pasaban las cadenas al evaluador y este leía `c.rank` como undefined:
    // la barra de fuerza SIEMPRE marcaba carta alta. Hay que normalizar las dos.
    const mias = (view.myCards ?? []) as Card[];
    const comunes = (view.hand.communityCards ?? [])
      .map(parseCard)
      .filter((c): c is Card => c !== null);
    return evaluarMano([...mias, ...comunes]);
  }, [view]);

  // --- Pantalla de carga ---
  if (!view) {
    return (
      <div className="p-4 pb-10">
        <PageHeader title="Mesa" onBack={onBack} />
        {error ? (
          <div className="card text-center py-10">
            <div className="text-3xl mb-3">⚠️</div>
            <p className="text-sm text-white mb-4">{error}</p>
            <button onClick={onBack} className="btn btn-primary px-6 py-2.5">
              Volver
            </button>
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="spinner mx-auto" />
          </div>
        )}
      </div>
    );
  }

  const inHand = view.hand.phase !== 'idle' && view.hand.phase !== 'waiting';
  const urgent = remaining !== null && remaining <= 10;
  const unidad = view.mode === 'USDT' ? 'USDT' : 'pts';
  /** Pinta una cantidad interna con la unidad que corresponde a la mesa. */
  const fmt = (internas: number, usdt: number): string =>
    view.mode === 'USDT' ? `${usdt.toFixed(2)} USDT` : `${Math.round(internas)} pts`;
  const resultado = view.hand.lastResult;
  const mostrarResultado = !inHand && !!resultado;

  // ------------------------------------------------------------------
  // SIN FICHAS: POR QUE NO PASA NADA, Y QUE HACER
  //
  // El caso real: el jugador se queda sin fichas (ha perdido la pila), sigue sentado, y la
  // mesa no arranca la mano porque solo arranca si hay un humano CON FICHAS. El jugador ve
  // una mesa con bots, sin cartas, sin bote, y no ocurre nada: ni error, ni aviso, ni boton.
  // Parecia que el juego estaba roto, y el juego estaba esperando a que tuviera fichas.
  //
  // Aqui se dice exactamente eso, con el numero, y se ofrece la unica accion que sirve:
  // volver a comprar fichas (rebuy). Sin esto el unico sintoma es una mesa quieta, que es
  // indistinguible de un fallo.
  // ------------------------------------------------------------------
  const miAsiento = view.seats.find((s) => s.isYou);
  const sinFichas = !!miAsiento && miAsiento.chips <= 0;

  // El asiento propio va siempre abajo. Se calcula la posición relativa al
  // índice del jugador; los huecos vacíos se quedan vacíos, no se reordenan.
  const miIndice = miAsiento?.index ?? 0;
  const layout = posicionesDe(view.maxSeats);
  const asientosMesa = view.seats
    .filter((s) => s.status !== 'out')
    .map((seat) => {
      const relativo =
        ((seat.index - miIndice) % view.maxSeats + view.maxSeats) % view.maxSeats;
      return {
        seat,
        pos: layout[relativo] ?? layout[0],
      };
    });

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader
        title={
          view.kind === 'freeroll'
            ? 'Freeroll'
            : view.kind === 'centroll'
              ? 'Centroll'
              : view.mode === 'USDT'
                ? 'Mesa cash'
                : 'Mesa'
        }
        onBack={leave}
      />

      {/* Estado */}
      <div
        className="rounded-xl p-3 mb-4 flex items-center justify-between"
        style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
      >
        <div>
          <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">Fase</p>
          <p className="font-bold text-white">
            {PHASE_LABEL[view.hand.phase] ?? view.hand.phase}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">Ciegas</p>
          <p className="font-bold text-white text-sm">
            {view.mode === 'USDT'
              ? `${view.smallBlindUsdt.toFixed(2)} / ${view.bigBlindUsdt.toFixed(2)}`
              : `${view.smallBlind} / ${view.bigBlind}`}
            <span className="text-[9px] text-[#a0a0b0] ml-1">{unidad}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">Pote</p>
          <p className="font-bold text-[#ffd700]">
            {fmt(view.hand.pot, view.hand.potUsdt)}
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-3">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {/* Resultado de la última mano. La mesa vuelve a `idle` enseguida; sin
          este snapshot el jugador nunca sabe quién ganó ni con qué mano. */}
      {mostrarResultado && resultado && (
        <div
          className="rounded-xl p-3 mb-3"
          style={{ background: '#16213e', border: '1px solid #ffd700' }}
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold text-[#ffd700]">
              Mano #{resultado.handNumber}
            </p>
            <p className="text-[10px] text-[#a0a0b0]">
              {resultado.endedByFold ? 'Sin showdown' : 'Showdown'} · Pote{' '}
              {fmt(resultado.pot, resultado.potUsdt)}
            </p>
          </div>

          {resultado.board.length > 0 && (
            <div className="flex justify-center gap-1 mb-2">
              {resultado.board.map((raw, i) => {
                const [rank, suit] = raw.split('|');
                return (
                  <span
                    key={i}
                    className="text-[11px] font-bold px-1.5 py-0.5 rounded"
                    style={{
                      background: '#0f172a',
                      color: isRedSuit(suit) ? '#ff8a94' : '#e2e8f0',
                    }}
                  >
                    {rank}{SUIT_SYMBOL[suit]}
                  </span>
                );
              })}
            </div>
          )}

          <div className="space-y-1">
            {resultado.winners.map((w) => (
              <div key={`${w.seatIndex}-${w.handName}`} className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-white truncate">
                  {w.displayName}
                  <span className="text-[10px] font-normal text-[#a0a0b0] ml-1.5">
                    {w.handName}
                  </span>
                </p>
                <p className="text-sm font-bold text-[#00d26a] flex-shrink-0">
                  +{fmt(w.amount, w.amountUsdt)}
                </p>
              </div>
            ))}
          </div>

          {resultado.showdown.length > 1 && (
            <div className="mt-2 pt-2 border-t border-white/10 space-y-1">
              {resultado.showdown.map((s) => (
                <div key={s.seatIndex} className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-[#a0a0b0] truncate">
                    {s.displayName} · {s.handName}
                  </p>
                  <p className="text-[11px] text-white flex-shrink-0">
                    {s.cards.map((c) => {
                      const [rank, suit] = c.split('|');
                      return `${rank}${SUIT_SYMBOL[suit] ?? ''}`;
                    }).join(' ')}
                  </p>
                </div>
              ))}
            </div>
          )}

          {resultado.rake > 0 && (
            <p className="text-[10px] text-[#a0a0b0] mt-2 text-right">
              Rake: {fmt(resultado.rake, resultado.rakeUsdt)}
            </p>
          )}
        </div>
      )}

      {/* Sin saldo en la mesa: la mesa está quieta porque no hay nadie que pueda jugar. */}
      {sinFichas && (
        <div className="bg-[#ffd700]/10 border border-[#ffd700] rounded-xl p-4 mb-3 text-center">
          <p className="text-sm font-bold text-[#ffd700] mb-1">
            Te has quedado sin {view.mode === 'USDT' ? 'saldo en la mesa' : 'puntos'}
          </p>
          <p className="text-xs text-[#a0a0b0] mb-3 leading-relaxed">
            Por eso la mesa no reparte cartas: hace falta al menos un jugador con
            {view.mode === 'USDT' ? ' USDT en la mesa' : ' puntos'} para jugar.
            {view.mode === 'USDT'
              ? ' Sal y vuelve a comprar entrada para seguir.'
              : ' Sal y vuelve a entrar en el próximo freeroll.'}
          </p>
          <button
            onClick={leave}
            disabled={acting}
            className="btn btn-primary py-2 px-6 text-sm w-full"
          >
            {acting
              ? 'Saliendo…'
              : view.mode === 'USDT'
                ? 'Salir y volver a comprar entrada'
                : 'Salir de la mesa'}
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------------
          MESA CON FIELTRO
          Los asientos van alrededor de la mesa, no en una lista. El jugador
          siempre está abajo al centro; los demás giran con él. Así se ve de un
          vistazo quién habla, quién está all-in y cuánto hay en el centro.
      ------------------------------------------------------------------ */}
      <div
        className="relative w-full max-w-md mx-auto mb-3"
        style={{ aspectRatio: '4 / 4.8' }}
        aria-label="Mesa de póker"
      >
        {/* Fieltro */}
        <div
          className="absolute rounded-[50%]"
          style={{
            top: '11%',
            bottom: '11%',
            left: '3%',
            right: '3%',
            background:
              'radial-gradient(ellipse at 50% 38%, #1f6b4f 0%, #14503b 42%, #0b3327 72%, #07241b 100%)',
            border: '6px solid #4a2f1d',
            boxShadow:
              '0 18px 38px rgba(0,0,0,0.55), inset 0 0 70px rgba(0,0,0,0.42), inset 0 0 0 2px rgba(255,215,0,0.14)',
          }}
        >
          <div
            className="absolute rounded-[50%] pointer-events-none"
            style={{
              inset: '7px',
              border: '1px solid rgba(255,215,0,0.18)',
            }}
          />

          {/* Centro: fase, bote y board */}
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4">
            <p className="text-[9px] uppercase tracking-[0.22em] text-[#9fe3c5]">
              {PHASE_LABEL[view.hand.phase] ?? view.hand.phase}
              {inHand ? ` · Mano ${view.hand.handNumber}` : ''}
            </p>

            <p className="text-[9px] uppercase tracking-[0.18em] text-[#ffd700]/80 mt-1">
              Pote
            </p>
            <p className="text-xl font-bold text-[#ffd700] leading-none">
              {fmt(view.hand.pot, view.hand.potUsdt)}
            </p>

            <div className="flex gap-1 justify-center mt-2" aria-label="Cartas comunitarias">
              {[0, 1, 2, 3, 4].map((i) => {
                const card = view.hand.communityCards[i];
                if (!card) {
                  return (
                    <div
                      key={i}
                      className="rounded-md"
                      style={{
                        width: 30,
                        height: 42,
                        background: 'rgba(0,0,0,0.18)',
                        border: '1px dashed rgba(255,255,255,0.14)',
                      }}
                    />
                  );
                }
                const [rank, suit] = card.split('|');
                return (
                  <div
                    key={i}
                    className="rounded-md bg-white flex flex-col items-center justify-center font-bold"
                    style={{
                      width: 30,
                      height: 42,
                      boxShadow: '0 3px 7px rgba(0,0,0,0.45)',
                    }}
                  >
                    <span
                      className="leading-none"
                      style={{
                        fontSize: 14,
                        color: isRedSuit(suit) ? '#e74c3c' : '#1e293b',
                      }}
                    >
                      {rank}
                    </span>
                    <span
                      className="leading-none mt-0.5"
                      style={{
                        fontSize: 13,
                        color: isRedSuit(suit) ? '#e74c3c' : '#1e293b',
                      }}
                    >
                      {SUIT_SYMBOL[suit]}
                    </span>
                  </div>
                );
              })}
            </div>

            {!inHand && (
              <p className="text-[9px] text-[#9fe3c5]/70 mt-2">
                {view.status === 'waiting'
                  ? 'Esperando jugadores'
                  : 'Esperando la próxima mano'}
              </p>
            )}
          </div>
        </div>

        {/* Asientos */}
        {asientosMesa.map(({ seat, pos }) => {
          const folded = seat.status === 'folded';
          const enMano =
            inHand && (seat.status === 'active' || seat.status === 'all_in');
          const esSuTurno = inHand && view.hand.actingSeat === seat.index;

          return (
            <div
              key={seat.index}
              className="absolute z-20 transition-all duration-300"
              style={{
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                width: 72,
                transform: 'translate(-50%, -50%)',
                opacity: folded ? 0.36 : 1,
              }}
            >
              {/* Cartas boca abajo. Las del rival nunca viajan al cliente. */}
              {enMano && !seat.isYou && (
                <div className="flex justify-center -space-x-2 mb-0.5" aria-hidden>
                  {[0, 1].map((i) => (
                    <span
                      key={i}
                      className="inline-block rounded-[3px]"
                      style={{
                        width: 12,
                        height: 17,
                        background:
                          'repeating-linear-gradient(45deg, #1e3a8a 0 2px, #0f172a 2px 4px)',
                        border: '1px solid rgba(255,255,255,0.45)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                      }}
                    />
                  ))}
                </div>
              )}

              <div
                className={`rounded-xl px-1 py-1 text-center ${
                  esSuTurno ? 'animate-pulse' : ''
                }`}
                style={{
                  background: seat.isYou
                    ? 'linear-gradient(180deg, #123b2b 0%, #0b231b 100%)'
                    : 'linear-gradient(180deg, #1b2440 0%, #121a2e 100%)',
                  border: `2px solid ${
                    esSuTurno
                      ? '#ffd700'
                      : seat.isYou
                        ? '#00d26a'
                        : '#2a3b5a'
                  }`,
                  boxShadow: esSuTurno
                    ? '0 0 16px rgba(255,215,0,0.65)'
                    : '0 4px 10px rgba(0,0,0,0.5)',
                }}
              >
                <div
                  className="relative mx-auto w-8 h-8 rounded-full flex items-center justify-center text-lg"
                  style={{ background: avatarColor(seat.displayName) }}
                >
                  <span className="leading-none">
                    {seat.avatarEmoji ?? '🃏'}
                  </span>
                  {seat.isDealer && (
                    <span className="absolute -right-2 -bottom-1 w-4 h-4 rounded-full bg-[#ffd700] text-black text-[8px] font-bold flex items-center justify-center border border-black/40">
                      D
                    </span>
                  )}
                  {seat.isSmallBlind && !seat.isDealer && (
                    <span className="absolute -left-1 -bottom-1 rounded-full bg-[#3498db] text-white text-[7px] font-bold px-1">
                      SB
                    </span>
                  )}
                  {seat.isBigBlind && (
                    <span className="absolute -left-1 -bottom-1 rounded-full bg-[#e74c3c] text-white text-[7px] font-bold px-1">
                      BB
                    </span>
                  )}
                </div>

                <p className="text-[9px] font-semibold text-white truncate leading-tight mt-0.5">
                  {seat.isYou ? 'Tú' : seat.displayName}
                </p>
                <p className="text-[9px] font-bold text-[#00d26a] leading-none mt-0.5">
                  {fmt(seat.chips, seat.chipsUsdt)}
                </p>

                {seat.bet > 0 && (
                  <p className="mt-0.5 inline-block rounded-full bg-[#ffd700]/15 px-1.5 text-[8px] font-bold text-[#ffd700] leading-tight">
                    {fmt(seat.bet, seat.betUsdt)}
                  </p>
                )}

                {seat.status === 'all_in' && (
                  <p className="text-[8px] font-bold text-[#ff8a94] leading-none mt-0.5">
                    ALL-IN
                  </p>
                )}
              </div>

              {seat.lastAction && !seat.isYou && (
                <span
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide"
                  style={{
                    background:
                      LAST_ACTION_COLOR[seat.lastAction]?.bg ?? '#16213e',
                    color:
                      LAST_ACTION_COLOR[seat.lastAction]?.fg ?? '#a0a0b0',
                  }}
                >
                  {LAST_ACTION_LABEL[seat.lastAction] ?? seat.lastAction}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Mi mano */}
      {view.myCards && view.myCards.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] uppercase tracking-wide text-[#a0a0b0] text-center mb-1.5">
            Tu mano
          </p>
          <div className="flex justify-center gap-2">
            {view.myCards.map((c, i) => (
              <div key={i} className="playing-card large">
                <span
                  className={`rank ${
                    isRedSuit(c.suit) ? 'text-[#e74c3c]' : 'text-[#2c3e50]'
                  }`}
                >
                  {c.rank}
                </span>
                <span
                  className={`suit ${
                    isRedSuit(c.suit) ? 'text-[#e74c3c]' : 'text-[#2c3e50]'
                  }`}
                >
                  {SUIT_SYMBOL[c.suit]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fuerza de la mano. Solo cuando ya hay 5 cartas: antes de eso, no hay mano que
          calificar y mostrar un "carta alta" seria mentir. */}
      {fuerza && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wide text-[#a0a0b0]">
              Fuerza
            </span>
            <span className="text-[11px] font-bold" style={{ color: '#ffd700' }}>
              {fuerza.name} · {fuerza.cards}
            </span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#16213e' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.round(fuerza.score * 100)}%`,
                background:
                  fuerza.score > 0.7
                    ? '#00d26a'
                    : fuerza.score > 0.35
                      ? '#ffd700'
                      : '#ff8a94',
              }}
            />
          </div>
        </div>
      )}

      {/* Turno */}
      {view.isMyTurn && inHand && (
        <div
          className={`rounded-xl p-2.5 mb-2 text-center ${
            urgent ? 'animate-pulse' : ''
          }`}
          style={{
            background: urgent ? 'rgba(255,71,87,0.12)' : 'rgba(0,210,106,0.1)',
            border: `1px solid ${urgent ? '#ff4757' : '#00d26a'}`,
          }}
        >
          <p className={`text-sm font-bold ${urgent ? 'text-[#ff8a94]' : 'text-[#00d26a]'}`}>
            Es tu turno
            {remaining !== null && ` · ${remaining}s`}
          </p>
        </div>
      )}

      {/* Acciones */}
      {view.isMyTurn && inHand && (
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => act('fold')}
              disabled={acting}
              className="btn btn-danger py-3 text-sm"
            >
              Retirarse
            </button>

            {(view.toCall ?? 0) > 0 ? (
              <button
                onClick={() => act('call')}
                disabled={acting}
                className="btn btn-primary py-3 text-sm"
              >
                Igualar {fmt(view.toCall ?? 0, (view.toCall ?? 0) / 1000)}
              </button>
            ) : (
              <button
                onClick={() => act('check')}
                disabled={acting}
                className="btn btn-outline py-3 text-sm"
              >
                Pasar
              </button>
            )}

            <button
              onClick={() => act('all_in')}
              disabled={acting}
              className="btn btn-gold py-3 text-sm"
            >
              All-in
            </button>
          </div>

          {/* Control de subida. El valor es el TOTAL de la apuesta, la misma
              semántica que usa el motor. */}
          {canRaiseTarget && (
            <div
              className="rounded-xl p-3"
              style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wide text-[#a0a0b0]">
                  Subir a
                </span>
                <span className="text-sm font-bold text-[#ffd700]">
                  {fmt(raiseValue, raiseValue / 1000)}
                </span>
              </div>

              <input
                type="range"
                min={minRaiseTarget}
                max={maxRaiseTarget}
                step={Math.max(1, view.bigBlind)}
                value={raiseValue}
                onChange={(e) => setRaiseTo(Number(e.target.value))}
                className="w-full accent-[#ffd700]"
                aria-label="Cantidad de subida"
              />

              <div className="grid grid-cols-4 gap-1.5 mt-2">
                <button
                  onClick={() => setRaiseTo(Math.min(maxRaiseTarget, Math.max(minRaiseTarget, Math.round(view.hand.currentBet + view.hand.pot * 0.5))))}
                  disabled={acting}
                  className="btn btn-outline py-2 text-[10px]"
                >
                  ½ pote
                </button>
                <button
                  onClick={() => setRaiseTo(Math.min(maxRaiseTarget, Math.max(minRaiseTarget, Math.round(view.hand.currentBet + view.hand.pot + (view.toCall ?? 0)))))}
                  disabled={acting}
                  className="btn btn-outline py-2 text-[10px]"
                >
                  Pote
                </button>
                <button
                  onClick={() => setRaiseTo(maxRaiseTarget)}
                  disabled={acting}
                  className="btn btn-outline py-2 text-[10px]"
                >
                  Stack
                </button>
                <button
                  onClick={() => act('raise', raiseValue)}
                  disabled={acting || raiseValue < minRaiseTarget || raiseValue > maxRaiseTarget}
                  className="btn btn-gold py-2 text-[10px]"
                >
                  Subir
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <button onClick={leave} disabled={acting} className="w-full btn btn-outline py-3">
        {acting ? 'Saliendo…' : 'Salir de la mesa'}
      </button>
    </div>
  );
}
