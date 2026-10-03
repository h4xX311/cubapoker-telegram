import { useState, useEffect, useCallback, useRef } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

const POLL_MS = 2000;
const MIN_BUYIN = 10;

const PHASE_LABEL: Record<string, string> = {
  waiting: 'Esperando jugadores',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  finished: 'Finalizada',
};

const SUIT_SYMBOL: Record<string, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

export function Game({ user, onBack, onBalanceChange }: Props) {
  const [gameId, setGameId] = useState<string | null>(null);
  const [state, setState] = useState<any>(null);
  const [gameIdInput, setGameIdInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const telegramId = user?.telegramId;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.gameState(id, telegramId);
          if (res.state) setState(res.state);
        } catch {
          // La partida pudo expirar; el siguiente ciclo lo reflejara
        }
      }, POLL_MS);
    },
    [stopPolling, telegramId],
  );

  useEffect(() => stopPolling, [stopPolling]);

  // Al terminar la partida, el saldo en MongoDB cambio: lo refrescamos
  const previousPhase = useRef<string | null>(null);
  useEffect(() => {
    if (state?.phase === 'finished' && previousPhase.current !== 'finished') {
      onBalanceChange?.();
    }
    previousPhase.current = state?.phase ?? null;
  }, [state?.phase, onBalanceChange]);

  const enterGame = (id: string) => {
    setGameId(id);
    setState(null);
    setError('');
    startPolling(id);
    // Primera carga inmediata
    api
      .gameState(id, telegramId)
      .then(res => setState(res.state))
      .catch(() => {});
  };

  const createGame = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.createGame(1, 2);
      enterGame(res.gameId);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo crear la mesa.',
      );
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async () => {
    const id = gameIdInput.trim();
    if (!id) {
      setError('Introduce el ID de la mesa.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.joinGame(id);
      enterGame(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo unir a la mesa.');
    } finally {
      setLoading(false);
    }
  };

  const act = async (action: string, amount?: number) => {
    if (!gameId || acting) return;
    setActing(true);
    try {
      const res = await api.gameAction(gameId, action, amount);
      if (res.state) setState(res.state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Acción no válida.');
    } finally {
      setActing(false);
    }
  };

  const leave = async () => {
    if (gameId) {
      try {
        await api.leaveGame(gameId);
      } catch {
        // si la mesa ya no existe, seguimos limpiando el estado local
      }
    }
    stopPolling();
    setGameId(null);
    setState(null);
    onBalanceChange?.();
  };

  // --- Selector de mesa ---
  if (!gameId) {
    const balance = user?.balance?.credits ?? 0;
    return (
      <div className="p-4 pb-10 animate-fadeIn">
        <PageHeader title="Jugar" onBack={onBack} />

        <div className="rounded-2xl p-6 mb-5 text-center" style={{ background: '#16213e', border: '1px solid #2a2a4a' }}>
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🃏</span>
          </div>
          <h2 className="text-xl font-bold text-white mb-1">Texas Hold'em</h2>
          <p className="text-sm text-[#a0a0b0]">
            Saldo: <span className="text-[#00d26a] font-semibold">{balance} CUP</span>
          </p>
        </div>

        {error && (
          <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
            <p className="text-sm text-[#ff8a94]">{error}</p>
          </div>
        )}

        <button
          onClick={createGame}
          disabled={loading || balance < MIN_BUYIN}
          className="w-full btn btn-primary py-3.5 text-base disabled:opacity-50 disabled:cursor-not-allowed mb-3"
        >
          {loading ? 'Creando…' : 'Crear mesa nueva'}
        </button>

        <div className="flex gap-2">
          <input
            type="text"
            value={gameIdInput}
            onChange={e => setGameIdInput(e.target.value)}
            placeholder="ID de mesa"
            className="input flex-1 text-sm"
            aria-label="ID de mesa"
          />
          <button
            onClick={joinGame}
            disabled={loading || !gameIdInput.trim()}
            className="btn btn-outline px-5 disabled:opacity-50"
          >
            Unirse
          </button>
        </div>

        {balance < MIN_BUYIN && (
          <p className="text-sm text-[#ff8a94] mt-4 text-center">
            Necesitas al menos {MIN_BUYIN} CUP para jugar.{' '}
            <button
              onClick={() => navigateDeposit(onBack)}
              className="text-[#00d26a] underline"
            >
              Depositar
            </button>
          </p>
        )}
      </div>
    );
  }

  // --- Mesa en curso ---
  const isMyTurn =
    state && state.players[state.currentPlayerIndex]?.id === String(telegramId);
  const inProgress = state && state.phase !== 'finished' && state.phase !== 'waiting';

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <div className="flex items-center justify-between mb-4">
        <PageHeader title="Mesa" onBack={leave} />
        <span className="badge badge-warning text-[10px] uppercase mb-5">
          {PHASE_LABEL[state?.phase] ?? 'Cargando'}
        </span>
      </div>

      {/* Pote */}
      <div className="text-center mb-4">
        <div
          className="inline-block rounded-2xl px-8 py-3"
          style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
        >
          <p className="text-[#a0a0b0] text-xs uppercase tracking-wide">Pote</p>
          <p className="text-2xl font-bold text-[#ffd700]">{state?.pot ?? 0} CUP</p>
        </div>
      </div>

      {/* Cartas comunitarias */}
      <div className="flex justify-center gap-2 mb-5" aria-label="Cartas comunitarias">
        {state?.communityCards?.length ? (
          state.communityCards.map((card: any, i: number) => (
            <PlayingCard key={i} card={card} />
          ))
        ) : (
          <p className="text-sm text-[#a0a0b0] py-4">Esperando cartas comunitarias…</p>
        )}
      </div>

      {/* Jugadores */}
      <div className="space-y-2 mb-5">
        {state?.players?.map((player: any, index: number) => {
          const isTurn = index === state.currentPlayerIndex;
          const folded = player.folded;
          return (
            <div
              key={player.id}
              className={`rounded-xl p-3 flex items-center justify-between transition-all ${
                isTurn ? 'neon-gold' : ''
              } ${folded ? 'opacity-40' : ''}`}
              style={{
                background: '#16213e',
                border: `1px solid ${isTurn ? '#ffd700' : '#2a2a4a'}`,
              }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  {(player.username || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">
                    {player.username}
                  </p>
                  <div className="flex gap-1 mt-0.5">
                    {player.isDealer && <Tag label="D" tone="gold" />}
                    {player.isSmallBlind && <Tag label="SB" tone="blue" />}
                    {player.isBigBlind && <Tag label="BB" tone="red" />}
                    {player.allIn && <Tag label="ALL IN" tone="red" />}
                  </div>
                </div>
              </div>

              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold text-[#00d26a]">
                  {player.chips} CUP
                </p>
                {player.bet > 0 && (
                  <p className="text-xs text-[#ffd700]">Apuesta {player.bet}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Mi mano */}
      {state?.myCards?.length > 0 && (
        <div className="flex justify-center gap-3 mb-5" aria-label="Tus cartas">
          {state.myCards.map((card: any, i: number) => (
            <PlayingCard key={i} card={card} large />
          ))}
        </div>
      )}

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {/* Acciones */}
      {isMyTurn && inProgress && (
        <div className="grid grid-cols-4 gap-2 mb-4">
          <button onClick={() => act('fold')} disabled={acting} className="btn btn-danger py-3 text-sm">
            Fold
          </button>
          <button onClick={() => act('check')} disabled={acting} className="btn btn-outline py-3 text-sm">
            Check
          </button>
          <button onClick={() => act('call')} disabled={acting} className="btn btn-primary py-3 text-sm">
            Call
          </button>
          <button
            onClick={() => act('raise', (state.currentBet || 2) * 2)}
            disabled={acting}
            className="btn btn-gold py-3 text-sm"
          >
            Raise
          </button>
        </div>
      )}

      {/* Resultado */}
      {state?.winners?.length > 0 && (
        <div className="card mb-4 text-center" style={{ borderColor: '#ffd700' }}>
          <p className="text-xs text-[#a0a0b0] uppercase tracking-wide mb-2">
            Ganó la mano
          </p>
          {state.winners.map((w: any, i: number) => (
            <div key={i}>
              <p className="text-white font-semibold">{w.hand?.name}</p>
              <p className="text-[#00d26a] font-bold">
                +{w.amount} CUP
              </p>
            </div>
          ))}
        </div>
      )}

      <button onClick={leave} className="w-full btn btn-outline py-3">
        Salir de la mesa
      </button>
    </div>
  );
}

function PlayingCard({ card, large }: { card: any; large?: boolean }) {
  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  return (
    <div
      className={`bg-white rounded-lg flex flex-col items-center justify-center shadow-lg ${
        large ? 'w-16 h-24' : 'w-11 h-16'
      }`}
    >
      <span className={`${large ? 'text-2xl' : 'text-lg'} font-bold ${isRed ? 'text-[#e74c3c]' : 'text-[#2c3e50]'}`}>
        {card.rank}
      </span>
      <span className={`${large ? 'text-2xl' : 'text-lg'} ${isRed ? 'text-[#e74c3c]' : 'text-[#2c3e50]'}`}>
        {SUIT_SYMBOL[card.suit]}
      </span>
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

function navigateDeposit(onBack: () => void) {
  window.history.pushState({}, '', '/deposit');
  onBack();
}
