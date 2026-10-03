import React, { useState, useEffect } from 'react';

interface TournamentsProps {
  user: any;
  onBack: () => void;
}

interface Tournament {
  id: string;
  name: string;
  type: string;
  buyIn: number;
  maxPlayers: number;
  minPlayers: number;
  playerCount: number;
  status: string;
  prizePool: number;
}

export const Tournaments: React.FC<TournamentsProps> = ({ user, onBack }) => {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);

  useEffect(() => {
    fetchTournaments();
  }, []);

  const fetchTournaments = async () => {
    try {
      const response = await fetch('/api/game/tournaments');
      const data = await response.json();
      if (data.success) {
        setTournaments(data.tournaments || []);
      }
    } catch (error) {
      console.error('Error fetching tournaments:', error);
    } finally {
      setLoading(false);
    }
  };

  const registerTournament = async (tournamentId: string) => {
    setRegistering(tournamentId);
    try {
      const response = await fetch(`/api/game/tournaments/${tournamentId}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramId: user?.id }),
      });

      const data = await response.json();
      if (data.success) {
        alert('¡Registrado exitosamente!');
        fetchTournaments();
      } else {
        alert(data.error || 'Error al registrarse');
      }
    } catch (error) {
      console.error('Error registering:', error);
    } finally {
      setRegistering(null);
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'sit_and_go': return '⚡';
      case 'scheduled': return '📅';
      case 'freeroll': return '🎁';
      default: return '🏆';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'sit_and_go': return 'Sit & Go';
      case 'scheduled': return 'Programado';
      case 'freeroll': return 'Gratis';
      default: return 'Torneo';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'registering':
        return <span className="badge badge-success">Inscripciones</span>;
      case 'running':
        return <span className="badge badge-warning">En curso</span>;
      case 'completed':
        return <span className="badge badge-danger">Finalizado</span>;
      default:
        return <span className="badge">{status}</span>;
    }
  };

  return (
    <div className="p-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="text-white mr-4 text-xl">
          ←
        </button>
        <h1 className="text-xl font-bold text-[#ffd700]">🏆 Torneos</h1>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto mb-4"></div>
          <p className="text-[#a0a0b0]">Cargando torneos...</p>
        </div>
      ) : tournaments.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-6xl mb-4">🏆</div>
          <h2 className="text-xl font-bold mb-2">No hay torneos activos</h2>
          <p className="text-[#a0a0b0]">Vuelve más tarde para nuevos torneos</p>
        </div>
      ) : (
        <div className="space-y-4">
          {tournaments.map((tournament) => (
            <div key={tournament.id} className="card animate-slideUp">
              {/* Header */}
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#ffd700] to-[#ffb700] flex items-center justify-center">
                    <span className="text-2xl">{getTypeIcon(tournament.type)}</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-white">{tournament.name}</h3>
                    <p className="text-sm text-[#a0a0b0]">{getTypeLabel(tournament.type)}</p>
                  </div>
                </div>
                {getStatusBadge(tournament.status)}
              </div>

              {/* Info */}
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="text-center">
                  <p className="text-[#a0a0b0] text-xs">Buy-in</p>
                  <p className="font-bold text-white">
                    {tournament.buyIn === 0 ? 'Gratis' : `${tournament.buyIn} CUP`}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[#a0a0b0] text-xs">Jugadores</p>
                  <p className="font-bold text-white">
                    {tournament.playerCount}/{tournament.maxPlayers}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[#a0a0b0] text-xs">Premio</p>
                  <p className="font-bold text-[#ffd700]">
                    {tournament.prizePool} CUP
                  </p>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="mb-4">
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${(tournament.playerCount / tournament.maxPlayers) * 100}%` }}
                  ></div>
                </div>
              </div>

              {/* Register Button */}
              {tournament.status === 'registering' && (
                <button
                  onClick={() => registerTournament(tournament.id)}
                  disabled={registering === tournament.id || (user?.balance?.credits || 0) < tournament.buyIn}
                  className="w-full btn btn-primary"
                >
                  {registering === tournament.id ? 'Registrando...' : 'Registrarse'}
                </button>
              )}

              {tournament.status === 'running' && (
                <button className="w-full btn btn-gold" disabled>
                  Torneo en curso
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Info */}
      <div className="mt-6 card">
        <h3 className="text-[#a0a0b0] text-sm mb-3">Tipos de Torneos</h3>
        <div className="space-y-2 text-sm text-[#a0a0b0]">
          <p>⚡ <strong>Sit & Go:</strong> Comienza cuando hay suficientes jugadores</p>
          <p>📅 <strong>Programado:</strong> Horario fijo, premios garantizados</p>
          <p>🎁 <strong>Freeroll:</strong> Gratis, todos pueden participar</p>
        </div>
      </div>
    </div>
  );
};
