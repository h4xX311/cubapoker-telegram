import { Router, Request, Response } from 'express';
import { PokerGame } from './game.state';
import { RakeManager } from './rake';
import { TournamentManager } from './tournament';
import { User } from '../models/User';
import { Game } from '../models/Game';
import { Transaction } from '../models/Transaction';
import TelegramBot from 'node-telegram-bot-api';

const activeGames: Map<string, PokerGame> = new Map();
const playerGames: Map<number, string> = new Map();
const rakeManager = new RakeManager({ percentage: 5, maxRake: 100 });
const tournamentManager = new TournamentManager();

export const createGameRoutes = (bot: TelegramBot): Router => {
  const router = Router();

  // Crear nueva mesa
  router.post('/create', async (req: Request, res: Response) => {
    try {
      const { telegramId, smallBlind = 1, bigBlind = 2 } = req.body;

      const user = await User.findOne({ telegramId });
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (user.balance.credits < bigBlind * 10) {
        return res.status(400).json({ error: 'Balance insuficiente' });
      }

      const gameId = `game-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const game = new PokerGame(gameId, smallBlind, bigBlind);

      activeGames.set(gameId, game);
      playerGames.set(telegramId, gameId);

      await Game.create({
        gameId,
        players: [telegramId.toString()],
        status: 'waiting',
      });

      res.json({
        success: true,
        gameId,
        message: 'Mesa creada. Comparte el ID para que otros jugadores se unan.',
      });
    } catch (error) {
      console.error('Create game error:', error);
      res.status(500).json({ error: 'Error al crear la mesa' });
    }
  });

  // Unirse a mesa
  router.post('/join', async (req: Request, res: Response) => {
    try {
      const { telegramId, gameId } = req.body;

      const user = await User.findOne({ telegramId });
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const game = activeGames.get(gameId);
      if (!game) {
        return res.status(404).json({ error: 'Mesa no encontrada' });
      }

      const state = game.getState();
      if (state.players.length >= 6) {
        return res.status(400).json({ error: 'Mesa llena (máximo 6 jugadores)' });
      }

      if (state.phase !== 'waiting') {
        return res.status(400).json({ error: 'El juego ya comenzó' });
      }

      const success = game.addPlayer(telegramId.toString(), user.firstName, user.balance.credits);
      if (!success) {
        return res.status(400).json({ error: 'No puedes unirte a esta mesa' });
      }

      playerGames.set(telegramId, gameId);

      await Game.findOneAndUpdate(
        { gameId },
        { $addToSet: { players: telegramId.toString() } }
      );

      const gameState = game.getState();
      for (const player of gameState.players) {
        if (parseInt(player.id) !== telegramId) {
          bot.sendMessage(
            parseInt(player.id),
            `🎮 *${user.firstName}* se unió a la mesa!\n\nJugadores: ${gameState.players.length}/6`,
            { parse_mode: 'Markdown' }
          );
        }
      }

      if (gameState.players.length >= 2) {
        setTimeout(() => startGame(gameId, bot), 3000);
      }

      res.json({
        success: true,
        gameId,
        message: 'Te uniste a la mesa. Esperando más jugadores...',
      });
    } catch (error) {
      console.error('Join game error:', error);
      res.status(500).json({ error: 'Error al unirse a la mesa' });
    }
  });

  // Obtener estado del juego (polling)
  router.get('/state/:gameId/:telegramId', async (req: Request, res: Response) => {
    try {
      const { gameId, telegramId } = req.params;

      const game = activeGames.get(gameId);
      if (!game) {
        return res.status(404).json({ error: 'Mesa no encontrada' });
      }

      const playerState = game.getPlayerState(telegramId);
      if (!playerState) {
        return res.status(403).json({ error: 'No estás en esta mesa' });
      }

      res.json({
        success: true,
        state: playerState,
      });
    } catch (error) {
      console.error('Get state error:', error);
      res.status(500).json({ error: 'Error al obtener estado' });
    }
  });

  // Realizar acción
  router.post('/action', async (req: Request, res: Response) => {
    try {
      const { telegramId, gameId, action, amount } = req.body;

      const game = activeGames.get(gameId);
      if (!game) {
        return res.status(404).json({ error: 'Mesa no encontrada' });
      }

      const success = game.performAction(telegramId.toString(), action, amount);
      if (!success) {
        return res.status(400).json({ error: 'Acción inválida' });
      }

      const state = game.getState();

      for (const player of state.players) {
        const playerId = parseInt(player.id);
        if (!isNaN(playerId)) {
          const message = formatGameState(game.getPlayerState(player.id), playerId === telegramId);
          bot.sendMessage(playerId, message.text, { parse_mode: 'Markdown' });
        }
      }

      if (state.phase === 'finished') {
        await handleGameEnd(gameId, bot);
      }

      res.json({
        success: true,
        state: game.getPlayerState(telegramId.toString()),
      });
    } catch (error) {
      console.error('Action error:', error);
      res.status(500).json({ error: 'Error al realizar acción' });
    }
  });

  // Salir de la mesa
  router.post('/leave', async (req: Request, res: Response) => {
    try {
      const { telegramId, gameId } = req.body;

      const game = activeGames.get(gameId);
      if (!game) {
        return res.status(404).json({ error: 'Mesa no encontrada' });
      }

      game.removePlayer(telegramId.toString());
      playerGames.delete(telegramId);

      const state = game.getState();
      for (const player of state.players) {
        const playerId = parseInt(player.id);
        if (!isNaN(playerId)) {
          bot.sendMessage(playerId, `🚪 Un jugador salió de la mesa.`, { parse_mode: 'Markdown' });
        }
      }

      if (state.players.length === 0) {
        activeGames.delete(gameId);
        await Game.findOneAndDelete({ gameId });
      }

      res.json({ success: true, message: 'Saliste de la mesa' });
    } catch (error) {
      console.error('Leave game error:', error);
      res.status(500).json({ error: 'Error al salir de la mesa' });
    }
  });

  // Obtener mesas activas
  router.get('/active', async (req: Request, res: Response) => {
    try {
      const games = Array.from(activeGames.entries()).map(([gameId, game]) => {
        const state = game.getState();
        return {
          gameId,
          playerCount: state.players.length,
          phase: state.phase,
          smallBlind: state.smallBlind,
          bigBlind: state.bigBlind,
        };
      });

      res.json({ success: true, games });
    } catch (error) {
      console.error('Get active games error:', error);
      res.status(500).json({ error: 'Error al obtener mesas' });
    }
  });

  // === TORNEOS ===

  // Obtener torneos activos
  router.get('/tournaments', async (req: Request, res: Response) => {
    try {
      const tournaments = tournamentManager.getActiveTournaments();
      res.json({ success: true, tournaments });
    } catch (error) {
      console.error('Get tournaments error:', error);
      res.status(500).json({ error: 'Error al obtener torneos' });
    }
  });

  // Crear torneo
  router.post('/tournaments/create', async (req: Request, res: Response) => {
    try {
      const { name, type, buyIn, maxPlayers } = req.body;
      const tournament = tournamentManager.createTournament({
        name,
        type,
        buyIn,
        maxPlayers,
      });
      res.json({ success: true, tournament });
    } catch (error) {
      console.error('Create tournament error:', error);
      res.status(500).json({ error: 'Error al crear torneo' });
    }
  });

  // Registrarse en torneo
  router.post('/tournaments/:id/register', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { telegramId } = req.body;

      const user = await User.findOne({ telegramId });
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const tournament = tournamentManager.getTournament(id);
      if (!tournament) {
        return res.status(404).json({ error: 'Torneo no encontrado' });
      }

      if (user.balance.credits < tournament.config.buyIn) {
        return res.status(400).json({ error: 'Balance insuficiente para el buy-in' });
      }

      const success = tournamentManager.registerPlayer(id, telegramId, user.firstName);
      if (!success) {
        return res.status(400).json({ error: 'No puedes registrarte en este torneo' });
      }

      // Descontar buy-in
      user.balance.credits -= tournament.config.buyIn;
      await user.save();

      res.json({ success: true, message: 'Registrado en el torneo' });
    } catch (error) {
      console.error('Register tournament error:', error);
      res.status(500).json({ error: 'Error al registrarse' });
    }
  });

  // Iniciar torneo
  router.post('/tournaments/:id/start', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const success = tournamentManager.startTournament(id);

      if (!success) {
        return res.status(400).json({ error: 'No se puede iniciar el torneo' });
      }

      const tournament = tournamentManager.getTournament(id);
      res.json({ success: true, tournament });
    } catch (error) {
      console.error('Start tournament error:', error);
      res.status(500).json({ error: 'Error al iniciar torneo' });
    }
  });

  return router;
};

function startGame(gameId: string, bot: TelegramBot): void {
  const game = activeGames.get(gameId);
  if (!game) return;

  const success = game.startGame();
  if (!success) return;

  const state = game.getState();

  for (const player of state.players) {
    const playerId = parseInt(player.id);
    if (!isNaN(playerId)) {
      const message = `
🎮 *¡El juego comenzó!*

Mesa: ${gameId}
Jugadores: ${state.players.length}

${formatPlayerList(state.players)}

¡Buena suerte! 🃏
      `;
      bot.sendMessage(playerId, message, { parse_mode: 'Markdown' });
    }
  }
}

async function handleGameEnd(gameId: string, bot: TelegramBot): Promise<void> {
  const game = activeGames.get(gameId);
  if (!game) return;

  const state = game.getState();

  // Calcular rake
  const { rake, netPot } = rakeManager.splitPot(state.pot);

  // Actualizar balances
  for (const winner of state.winners || []) {
    const winnerShare = Math.floor(netPot / (state.winners?.length || 1));
    await User.findOneAndUpdate(
      { telegramId: parseInt(winner.playerId) },
      { $inc: { 'balance.credits': winnerShare } }
    );

    const playerId = parseInt(winner.playerId);
    if (!isNaN(playerId)) {
      bot.sendMessage(
        playerId,
        `🎉 *¡Ganaste ${winnerShare} CUP!*\n\nMano: ${winner.hand.name}\nRake: ${rake} CUP`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Guardar transacción de rake
  if (rake > 0) {
    await Transaction.create({
      telegramId: 0, // Sistema
      type: 'rake',
      paymentMethod: 'credits',
      amount: rake,
      currency: 'CUP',
      status: 'completed',
      metadata: { gameId },
    });
  }

  await Game.findOneAndUpdate(
    { gameId },
    {
      status: 'completed',
      pot: state.pot,
      rake,
      winner: state.winners?.[0]?.playerId,
    }
  );

  setTimeout(() => {
    activeGames.delete(gameId);
  }, 300000);
}

function formatGameState(state: any, isMyTurn: boolean): { text: string } {
  const lines: string[] = [];

  lines.push(`🃏 *Mesa de Poker*`);
  lines.push(``);
  lines.push(`Fase: ${state.phase}`);
  lines.push(`Pote: ${state.pot} CUP`);
  lines.push(``);

  if (state.communityCards && state.communityCards.length > 0) {
    lines.push(`Cartas comunitarias: ${state.communityCards.map((c: any) => `${c.rank}${getSuitSymbol(c.suit)}`).join(' ')}`);
    lines.push(``);
  }

  lines.push(`Jugadores:`);
  state.players.forEach((p: any, i: number) => {
    const marker = i === state.currentPlayerIndex ? '👉 ' : '';
    const folded = p.folded ? '❌' : '';
    const allIn = p.allIn ? '🔥' : '';
    lines.push(`${marker}${p.username}: ${p.chips} CUP ${folded}${allIn}`);
  });

  if (isMyTurn) {
    lines.push(``);
    lines.push(`¡Es tu turno!`);
  }

  return { text: lines.join('\n') };
}

function formatPlayerList(players: any[]): string {
  return players.map(p => `• ${p.username}`).join('\n');
}

function getSuitSymbol(suit: string): string {
  const symbols: Record<string, string> = {
    hearts: '♥',
    diamonds: '♦',
    clubs: '♣',
    spades: '♠',
  };
  return symbols[suit] || suit;
}
