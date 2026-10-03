import React, { useState, useEffect, useCallback } from 'react';

interface GameProps {
  user: any;
  onBack: () => void;
}

interface Player {
  id: string;
  username: string;
  chips: number;
  bet: number;
  folded: boolean;
  allIn: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction?: string;
  cardCount: number;
}

interface GameState {
  gameId: string;
  phase: string;
  players: Player[];
  communityCards: any[];
  pot: number;
  currentBet: number;
  currentPlayerIndex: number;
  smallBlind: number;
  bigBlind: number;
  winners?: { playerId: string; amount: number; hand: any }[];
  lastAction?: { playerId: string; action: string; amount?: number };
  myCards: any[];
  myHand?: any;
}

export const Game: React.FC<GameProps> = ({ user, onBack }) => {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);

  const fetchGameState = useCallback(async (gameId: string) => {
    try {
      const response = await fetch(`/api/game/state/${gameId}/${user?.id}`);
      const data = await response.json();
      if (data.success) {
        setGameState(data.state);
        setError(null);
      }
    } catch (err) {
      console.error('Error fetching game state:', err);
    }
  }, [user?.id]);

  const createGame = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/game/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: user?.id,
          smallBlind: 1,
          bigBlind: 2,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setGameState({
          gameId: data.gameId,
          phase: 'waiting',
          players: [],
          communityCards: [],
          pot: 0,
          currentBet: 0,
          currentPlayerIndex: 0,
          smallBlind: 1,
          bigBlind: 2,
          myCards: [],
        });
        const interval = setInterval(() => fetchGameState(data.gameId), 2000);
        setPollingInterval(interval);
      } else {
        setError(data.error || 'Error al crear la mesa');
      }
    } catch (err) {
      setError('Error al crear la mesa');
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (gameId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/game/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: user?.id,
          gameId,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setGameState({
          gameId,
          phase: 'waiting',
          players: [],
          communityCards: [],
          pot: 0,
          currentBet: 0,
          currentPlayerIndex: 0,
          smallBlind: 1,
          bigBlind: 2,
          myCards: [],
        });
        const interval = setInterval(() => fetchGameState(gameId), 2000);
        setPollingInterval(interval);
      } else {
        setError(data.error || 'Error al unirse');
      }
    } catch (err) {
      setError('Error al unirse');
    } finally {
      setLoading(false);
    }
  };

  const performAction = async (action: string, amount?: number) => {
    if (!gameState) return;
    try {
      const response = await fetch('/api/game/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: user?.id,
          gameId: gameState.gameId,
          action,
          amount,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setGameState(data.state);
      }
    } catch (err) {
      console.error('Error performing action:', err);
    }
  };

  const leaveGame = async () => {
    if (!gameState) return;
    try {
      await fetch('/api/game/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: user?.id,
          gameId: gameState.gameId,
        }),
      });

      if (pollingInterval) {
        clearInterval(pollingInterval);
        setPollingInterval(null);
      }
      setGameState(null);
    } catch (err) {
      console.error('Error leaving game:', err);
    }
  };

  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  const currentPlayer = gameState?.players[gameState.currentPlayerIndex];
  const isMyTurn = currentPlayer?.id === user?.id?.toString();

  const getSuitSymbol = (suit: string) => {
    const symbols: Record<string, string> = {
      hearts: '♥',
      diamonds: '♦',
      clubs: '♣',
      spades: '♠',
    };
    return symbols[suit] || suit;
  };

  const getSuitColor = (suit: string) => {
    return suit === 'hearts' || suit === 'diamonds' ? 'text-red-500' : 'text-gray-900';
  };

  return (
    <div className="p-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center mb-4">
        <button onClick={onBack} className="text-white mr-4 text-xl">←</button>
        <h1 className="text-xl font-bold text-[#ffd700]">🎮 Mesa de Poker</h1>
      </div>

      {!gameState ? (
        <div>
          {/* Create or Join */}
          <div className="text-center py-8">
            <div className="w-24 h-24 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center mx-auto mb-4 shadow-lg">
              <span className="text-5xl">🃏</span>
            </div>
            <h2 className="text-2xl font-bold mb-2">Texas Hold'em</h2>
            <p className="text-[#a0a0b0] mb-6">
              Balance: {user?.balance?.credits || 0} CUP
            </p>

            {error && (
              <div className="bg-red-500/20 border border-red-500 rounded-xl p-4 mb-4">
                <p className="text-red-400">{error}</p>
              </div>
            )}

            <div className="space-y-3">
              <button
                onClick={createGame}
                disabled={loading || (user?.balance?.credits || 0) < 100}
                className="w-full btn btn-primary text-lg"
              >
                {loading ? 'Creando...' : 'Crear Nueva Mesa'}
              </button>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="ID de mesa"
                  className="flex-1 input"
                  id="gameIdInput"
                />
                <button
                  onClick={() => {
                    const input = document.getElementById('gameIdInput') as HTMLInputElement;
                    if (input.value) joinGame(input.value);
                  }}
                  disabled={loading}
                  className="btn btn-outline"
                >
                  Unirse
                </button>
              </div>
            </div>

            {(user?.balance?.credits || 0) < 100 && (
              <p className="text-red-400 text-sm mt-4">
                Necesitas al menos 100 CUP para jugar
              </p>
            )}
          </div>
        </div>
      ) : (
        <div>
          {/* Game Info */}
          <div className="flex justify-between items-center mb-4">
            <div>
              <p className="text-[#a0a0b0] text-xs">Mesa</p>
              <p className="font-mono text-sm">{gameState.gameId.slice(0, 20)}...</p>
            </div>
            <div className="text-right">
              <p className="text-[#a0a0b0] text-xs">Fase</p>
              <p className="text-lg font-bold text-[#00d26a] capitalize">{gameState.phase}</p>
            </div>
          </div>

          {/* Pot */}
          <div className="text-center mb-4">
            <div className="inline-block glass rounded-2xl px-8 py-4">
              <p className="text-[#a0a0b0] text-sm">Pote</p>
              <p className="text-3xl font-bold text-[#ffd700]">{gameState.pot} CUP</p>
            </div>
          </div>

          {/* Community Cards */}
          <div className="flex justify-center gap-2 mb-6">
            {gameState.communityCards.length > 0 ? (
              gameState.communityCards.map((card, index) => (
                <div
                  key={index}
                  className={`playing-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black'}`}
                >
                  <span className="rank">{card.rank}</span>
                  <span className="suit">{getSuitSymbol(card.suit)}</span>
                </div>
              ))
            ) : (
              <div className="text-[#a0a0b0] py-8">Esperando cartas...</div>
            )}
          </div>

          {/* Players */}
          <div className="space-y-2 mb-4">
            {gameState.players.map((player, index) => (
              <div
                key={player.id}
                className={`card flex justify-between items-center p-3 ${
                  index === gameState.currentPlayerIndex ? 'border-[#ffd700] neon-gold' : ''
                } ${player.folded ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00d26a] to-[#00b894] flex items-center justify-center text-white font-bold">
                    {player.username.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold">{player.username}</p>
                    <div className="flex gap-1">
                      {player.isDealer && <span className="badge badge-warning text-xs">D</span>}
                      {player.isSmallBlind && <span className="badge badge-success text-xs">SB</span>}
                      {player.isBigBlind && <span className="badge badge-danger text-xs">BB</span>}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[#00d26a] font-bold">{player.chips} CUP</p>
                  {player.bet > 0 && <p className="text-sm text-[#a0a0b0]">Apuesta: {player.bet}</p>}
                  {player.lastAction && <p className="text-xs text-[#a0a0b0] capitalize">{player.lastAction}</p>}
                  {player.allIn && <p className="text-xs text-red-400 font-bold">ALL IN</p>}
                </div>
              </div>
            ))}
          </div>

          {/* My Cards */}
          {gameState.myCards && gameState.myCards.length > 0 && (
            <div className="flex justify-center gap-3 mb-4">
              {gameState.myCards.map((card, index) => (
                <div
                  key={index}
                  className={`playing-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black'}`}
                >
                  <span className="rank">{card.rank}</span>
                  <span className="suit">{getSuitSymbol(card.suit)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          {isMyTurn && gameState.phase !== 'finished' && (
            <div className="grid grid-cols-4 gap-2 mb-4">
              <button
                onClick={() => performAction('fold')}
                className="btn btn-danger"
              >
                Fold
              </button>
              <button
                onClick={() => performAction('check')}
                className="btn btn-outline"
              >
                Check
              </button>
              <button
                onClick={() => performAction('call')}
                className="btn btn-primary"
              >
                Call
              </button>
              <button
                onClick={() => performAction('raise', gameState.currentBet * 2)}
                className="btn btn-gold"
              >
                Raise
              </button>
            </div>
          )}

          {/* Winners */}
          {gameState.winners && gameState.winners.length > 0 && (
            <div className="mt-4 text-center">
              <h2 className="text-xl font-bold text-[#ffd700] mb-3">🏆 Ganadores</h2>
              {gameState.winners.map((winner, index) => (
                <div key={index} className="card inline-block m-1">
                  <p className="font-bold">{winner.playerId}</p>
                  <p className="text-[#00d26a]">+{winner.amount} CUP</p>
                  {winner.hand && <p className="text-sm text-[#a0a0b0]">{winner.hand.name}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Leave Button */}
          <button
            onClick={leaveGame}
            className="w-full btn btn-danger mt-4"
          >
            Salir de la Mesa
          </button>
        </div>
      )}
    </div>
  );
};
