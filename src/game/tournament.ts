import { PokerGame } from './game.state';
import { RakeManager } from './rake';

export type TournamentType = 'sit_and_go' | 'scheduled' | 'freeroll';
export type TournamentStatus = 'registering' | 'running' | 'completed' | 'cancelled';

export interface TournamentConfig {
  name: string;
  type: TournamentType;
  buyIn: number;
  maxPlayers: number;
  minPlayers: number;
  startingChips: number;
  blindLevels: { smallBlind: number; bigBlind: number; duration: number }[];
  prizeStructure: number[]; // porcentajes para 1er, 2do, 3er lugar
}

export interface Tournament {
  id: string;
  config: TournamentConfig;
  status: TournamentStatus;
  players: Map<string, { telegramId: number; username: string; chips: number; eliminated: boolean }>;
  currentLevel: number;
  games: PokerGame[];
  prizes: Map<number, number>; // position -> prize
  startTime?: Date;
  endTime?: Date;
}

const DEFAULT_TOURNAMENTS: TournamentConfig[] = [
  {
    name: 'Torneo Diario',
    type: 'scheduled',
    buyIn: 100,
    maxPlayers: 20,
    minPlayers: 4,
    startingChips: 1000,
    blindLevels: [
      { smallBlind: 1, bigBlind: 2, duration: 60000 },
      { smallBlind: 2, bigBlind: 4, duration: 60000 },
      { smallBlind: 5, bigBlind: 10, duration: 60000 },
      { smallBlind: 10, bigBlind: 20, duration: 60000 },
    ],
    prizeStructure: [50, 30, 20],
  },
  {
    name: 'Sit & Go',
    type: 'sit_and_go',
    buyIn: 50,
    maxPlayers: 6,
    minPlayers: 2,
    startingChips: 500,
    blindLevels: [
      { smallBlind: 1, bigBlind: 2, duration: 45000 },
      { smallBlind: 2, bigBlind: 4, duration: 45000 },
      { smallBlind: 5, bigBlind: 10, duration: 45000 },
    ],
    prizeStructure: [70, 30],
  },
  {
    name: 'Freeroll',
    type: 'freeroll',
    buyIn: 0,
    maxPlayers: 50,
    minPlayers: 10,
    startingChips: 1000,
    blindLevels: [
      { smallBlind: 1, bigBlind: 2, duration: 60000 },
      { smallBlind: 2, bigBlind: 4, duration: 60000 },
    ],
    prizeStructure: [40, 30, 20, 10],
  },
];

export class TournamentManager {
  private tournaments: Map<string, Tournament> = new Map();
  private rakeManager: RakeManager;

  constructor() {
    this.rakeManager = new RakeManager({ percentage: 5, maxRake: 50 });
  }

  createTournament(config: Partial<TournamentConfig> = {}): Tournament {
    const defaultConfig = DEFAULT_TOURNAMENTS[0];
    const finalConfig: TournamentConfig = {
      ...defaultConfig,
      ...config,
      name: config.name || defaultConfig.name,
      type: config.type || defaultConfig.type,
    };

    const id = `tourney-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const tournament: Tournament = {
      id,
      config: finalConfig,
      status: 'registering',
      players: new Map(),
      currentLevel: 0,
      games: [],
      prizes: new Map(),
    };

    this.tournaments.set(id, tournament);
    return tournament;
  }

  registerPlayer(tournamentId: string, telegramId: number, username: string): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return false;
    if (tournament.status !== 'registering') return false;
    if (tournament.players.size >= tournament.config.maxPlayers) return false;

    tournament.players.set(telegramId.toString(), {
      telegramId,
      username,
      chips: tournament.config.startingChips,
      eliminated: false,
    });

    return true;
  }

  startTournament(tournamentId: string): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return false;
    if (tournament.players.size < tournament.config.minPlayers) return false;

    tournament.status = 'running';
    tournament.startTime = new Date();

    // Calcular premios
    const totalPrize = tournament.players.size * tournament.config.buyIn;
    const rake = this.rakeManager.calculateRake(totalPrize);
    const netPrize = totalPrize - rake;

    tournament.config.prizeStructure.forEach((percentage, index) => {
      tournament.prizes.set(index + 1, Math.floor((netPrize * percentage) / 100));
    });

    return true;
  }

  eliminatePlayer(tournamentId: string, telegramId: number): number {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return -1;

    const player = tournament.players.get(telegramId.toString());
    if (!player) return -1;

    player.eliminated = true;
    const remaining = Array.from(tournament.players.values()).filter(p => !p.eliminated).length;

    // Asignar premio si es top 3
    if (remaining <= 3) {
      const prize = tournament.prizes.get(remaining) || 0;
      player.chips += prize;
    }

    // Si solo queda uno, terminar torneo
    if (remaining === 1) {
      tournament.status = 'completed';
      tournament.endTime = new Date();
    }

    return remaining;
  }

  getTournament(id: string): Tournament | undefined {
    return this.tournaments.get(id);
  }

  getActiveTournaments(): Tournament[] {
    return Array.from(this.tournaments.values()).filter(
      t => t.status === 'registering' || t.status === 'running'
    );
  }

  getDefaultConfigs(): TournamentConfig[] {
    return DEFAULT_TOURNAMENTS;
  }
}
