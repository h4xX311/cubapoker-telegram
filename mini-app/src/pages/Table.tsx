import { useState, useEffect, useRef } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';
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

export function Table({ tableId, onBack, onBalanceChange }: Props) {
  const [view, setView] = useState<TableView | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);

  const prevPhase = useRef<string>('');

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

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title={view.guaranteedPrize > 0 ? `Premio ${view.guaranteedPrize} CUP` : 'Mesa'} onBack={leave} />

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
            {view.smallBlind}/{view.bigBlind}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">Pote</p>
          <p className="font-bold text-[#ffd700]">{view.hand.pot}</p>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-3">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {/* Sin fichas: la mesa esta quieta porque no hay nadie con fichas que juegue. */}
      {sinFichas && (
        <div className="bg-[#ffd700]/10 border border-[#ffd700] rounded-xl p-4 mb-3 text-center">
          <p className="text-sm font-bold text-[#ffd700] mb-1">
            Te has quedado sin fichas
          </p>
          <p className="text-xs text-[#a0a0b0] mb-3 leading-relaxed">
            Por eso la mesa no reparte cartas: hace falta al menos un jugador con fichas.
            Sal y vuelve a comprar fichas para seguir jugando.
          </p>
          <button
            onClick={leave}
            disabled={acting}
            className="btn btn-primary py-2 px-6 text-sm w-full"
          >
            {acting ? 'Saliendo…' : 'Salir y comprar fichas de nuevo'}
          </button>
        </div>
      )}

      {/* Cartas comunitarias */}
      <div className="flex justify-center gap-1.5 mb-4" aria-label="Cartas comunitarias">
        {[0, 1, 2, 3, 4].map(i => {
          const card = view.hand.communityCards[i];
          if (!card) {
            return (
              <div
                key={i}
                className="w-11 h-16 rounded-lg flex items-center justify-center"
                style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
              >
                <span className="text-[#2a2a4a] text-xl">?</span>
              </div>
            );
          }
          const [rank, suit] = card.split('|');
          return (
            <div key={i} className="playing-card">
              <span className={`rank ${isRedSuit(suit) ? 'text-[#e74c3c]' : 'text-[#2c3e50]'}`}>
                {rank}
              </span>
              <span className={`suit ${isRedSuit(suit) ? 'text-[#e74c3c]' : 'text-[#2c3e50]'}`}>
                {SUIT_SYMBOL[suit]}
              </span>
            </div>
          );
        })}
      </div>

      {/* Mi mano */}
      {view.myCards && view.myCards.length > 0 && (
        <div className="flex justify-center gap-2 mb-4">
          {view.myCards.map((c, i) => (
            <div key={i} className="playing-card large">
              <span className={`rank ${isRedSuit(c.suit) ? 'text-[#e74c3c]' : 'text-[#2c3e50]'}`}>
                {c.rank}
              </span>
              <span className={`suit ${isRedSuit(c.suit) ? 'text-[#e74c3c]' : 'text-[#2c3e50]'}`}>
                {SUIT_SYMBOL[c.suit]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Turno */}
      {view.isMyTurn && inHand && (
        <div
          className={`rounded-xl p-3 mb-3 text-center ${
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

      {/* Asientos */}
      <SectionLabel>
        Jugadores · {view.humans} humanos · {view.bots} bots
      </SectionLabel>
      <div className="space-y-1.5 mb-4">
        {view.seats.slice(0, 20).map(seat => (
          <div
            key={seat.index}
            className={`rounded-xl p-2.5 flex items-center justify-between transition-colors ${
              seat.isYou ? '' : ''
            } ${seat.status === 'folded' ? 'opacity-40' : ''}`}
            style={{
              background: seat.isYou ? '#12241c' : '#16213e',
              border: `1px solid ${seat.isYou ? '#00d26a' : '#2a2a4a'}`,
              boxShadow: seat.isYou ? '0 0 0 1px rgba(0,210,106,0.35)' : undefined,
            }}
          >
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              {/* Que ha hecho ESTE rival. Sin esto no hay mesa de poker: se ve el bote subiendo y
                  no se sabe si los demas igualaron, subieron o se retiraron. El dato ya
                  viene del servidor (`lastAction`); faltaba enseñarlo. */}
              {seat.lastAction && !seat.isYou && (
                <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{
                    background: LAST_ACTION_COLOR[seat.lastAction]?.bg ?? '#16213e',
                    color: LAST_ACTION_COLOR[seat.lastAction]?.fg ?? '#a0a0b0',
                  }}
                >
                  {LAST_ACTION_LABEL[seat.lastAction] ?? seat.lastAction}
                </span>
              )}
              {seat.isYou && (
                <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#00d26a]/20 text-[#00d26a] flex-shrink-0">
                  Tú
                </span>
              )}
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                style={{
                  background:
                    seat.kind === 'bot'
                      ? 'linear-gradient(135deg,#2c3e50,#34495e)'
                      : 'linear-gradient(135deg,#00d26a,#00b894)',
                }}
              >
                {seat.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {seat.displayName}
                  {seat.isYou && <span className="text-[#00d26a] ml-1">(tú)</span>}
                  {seat.kind === 'bot' && (
                    <span className="text-[9px] text-[#6c6c80] ml-1">bot</span>
                  )}
                </p>
                <div className="flex gap-1 mt-0.5">
                  {seat.isDealer && <Tag label="D" tone="gold" />}
                  {seat.isSmallBlind && <Tag label="SB" tone="blue" />}
                  {seat.isBigBlind && <Tag label="BB" tone="red" />}
                  {seat.status === 'all_in' && <Tag label="ALL IN" tone="red" />}
                </div>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm font-bold text-[#00d26a]">{seat.chips}</p>
              {seat.bet > 0 && <p className="text-[10px] text-[#ffd700]">{seat.bet}</p>}
            </div>
          </div>
        ))}
      </div>

      {view.seats.length > 20 && (
        <p className="text-xs text-[#a0a0b0] text-center mb-4">
          +{view.seats.length - 20} jugadores más
        </p>
      )}

      {/* Acciones */}
      {view.isMyTurn && inHand && (
        <div className="grid grid-cols-4 gap-2 mb-3">
          <button onClick={() => act('fold')} disabled={acting} className="btn btn-danger py-3 text-sm">
            Fold
          </button>
          <button onClick={() => act('check')} disabled={acting} className="btn btn-outline py-3 text-sm">
            Check
          </button>
          <button onClick={() => act('call')} disabled={acting} className="btn btn-primary py-3 text-sm">
            Igualar
          </button>
          <button
            onClick={() => act('raise', Math.max(view.hand.currentBet * 2, view.hand.currentBet + view.bigBlind))}
            disabled={acting}
            className="btn btn-gold py-3 text-sm"
          >
            Subir
          </button>
        </div>
      )}

      <button onClick={leave} disabled={acting} className="w-full btn btn-outline py-3">
        {acting ? 'Saliendo…' : 'Salir de la mesa'}
      </button>
    </div>
  );
}

function Tag({ label, tone }: { label: string; tone: 'gold' | 'blue' | 'red' }) {
  const colors = {
    gold: 'bg-[#ffd700] text-black',
    blue: 'bg-[#3498db] text-white',
    red: 'bg-[#ff4757] text-white',
  };
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${colors[tone]}`}>
      {label}
    </span>
  );
}
