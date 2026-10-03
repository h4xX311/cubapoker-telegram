import { Card, createDeck, shuffleDeck } from './card.utils';
import { evaluateHand, HandResult } from './hand.evaluator';

export type GamePhase = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'finished';
export type PlayerAction = 'fold' | 'check' | 'call' | 'raise' | 'all_in';

export interface Player {
  id: string;
  username: string;
  chips: number;
  bet: number;
  totalBet: number;
  cards: Card[];
  folded: boolean;
  allIn: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction?: PlayerAction;
  hand?: HandResult;
}

export interface GameState {
  gameId: string;
  phase: GamePhase;
  players: Player[];
  communityCards: Card[];
  deck: Card[];
  pot: number;
  currentBet: number;
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  smallBlind: number;
  bigBlind: number;
  minRaise: number;
  winners?: { playerId: string; amount: number; hand: HandResult }[];
  lastAction?: { playerId: string; action: PlayerAction; amount?: number };
  createdAt: Date;
  updatedAt: Date;
}

export class PokerGame {
  private state: GameState;

  constructor(gameId: string, smallBlind: number = 1, bigBlind: number = 2) {
    this.state = {
      gameId,
      phase: 'waiting',
      players: [],
      communityCards: [],
      deck: [],
      pot: 0,
      currentBet: 0,
      currentPlayerIndex: 0,
      dealerIndex: 0,
      smallBlindIndex: 0,
      bigBlindIndex: 0,
      smallBlind,
      bigBlind,
      minRaise: bigBlind,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  getState(): GameState {
    return { ...this.state };
  }

  addPlayer(id: string, username: string, chips: number): boolean {
    if (this.state.players.length >= 6) return false;
    if (this.state.phase !== 'waiting') return false;

    this.state.players.push({
      id,
      username,
      chips,
      bet: 0,
      totalBet: 0,
      cards: [],
      folded: false,
      allIn: false,
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
    });

    return true;
  }

  removePlayer(id: string): void {
    this.state.players = this.state.players.filter(p => p.id !== id);
  }

  startGame(): boolean {
    if (this.state.players.length < 2) return false;

    this.state.phase = 'preflop';
    this.state.deck = shuffleDeck(createDeck());
    this.state.communityCards = [];
    this.state.pot = 0;
    this.state.currentBet = 0;

    this.state.players.forEach(p => {
      p.bet = 0;
      p.totalBet = 0;
      p.cards = [];
      p.folded = false;
      p.allIn = false;
      p.lastAction = undefined;
      p.hand = undefined;
    });

    this.state.dealerIndex = 0;
    this.state.smallBlindIndex = 1 % this.state.players.length;
    this.state.bigBlindIndex = 2 % this.state.players.length;

    this.state.players[this.state.dealerIndex].isDealer = true;
    this.state.players[this.state.smallBlindIndex].isSmallBlind = true;
    this.state.players[this.state.bigBlindIndex].isBigBlind = true;

    this.postBlind(this.state.smallBlindIndex, this.state.smallBlind);
    this.postBlind(this.state.bigBlindIndex, this.state.bigBlind);

    this.dealCards();

    this.state.currentPlayerIndex = (this.state.bigBlindIndex + 1) % this.state.players.length;
    this.state.currentBet = this.state.bigBlind;

    this.state.updatedAt = new Date();
    return true;
  }

  private postBlind(playerIndex: number, amount: number): void {
    const player = this.state.players[playerIndex];
    const actualAmount = Math.min(amount, player.chips);
    player.chips -= actualAmount;
    player.bet += actualAmount;
    player.totalBet += actualAmount;
    this.state.pot += actualAmount;

    if (player.chips === 0) {
      player.allIn = true;
    }
  }

  private dealCards(): void {
    for (let i = 0; i < 2; i++) {
      for (const player of this.state.players) {
        const card = this.state.deck.pop();
        if (card) {
          player.cards.push(card);
        }
      }
    }
  }

  performAction(playerId: string, action: PlayerAction, amount?: number): boolean {
    const playerIndex = this.state.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return false;
    if (playerIndex !== this.state.currentPlayerIndex) return false;

    const player = this.state.players[playerIndex];

    switch (action) {
      case 'fold':
        player.folded = true;
        player.lastAction = 'fold';
        break;

      case 'check':
        if (player.bet < this.state.currentBet) return false;
        player.lastAction = 'check';
        break;

      case 'call': {
        const callAmount = Math.min(this.state.currentBet - player.bet, player.chips);
        player.chips -= callAmount;
        player.bet += callAmount;
        player.totalBet += callAmount;
        this.state.pot += callAmount;
        if (player.chips === 0) player.allIn = true;
        player.lastAction = 'call';
        break;
      }

      case 'raise': {
        if (!amount || amount < this.state.minRaise) return false;
        const totalBet = this.state.currentBet + amount;
        const raiseAmount = totalBet - player.bet;
        if (raiseAmount > player.chips) return false;

        player.chips -= raiseAmount;
        player.bet = totalBet;
        player.totalBet += raiseAmount;
        this.state.pot += raiseAmount;
        this.state.currentBet = totalBet;
        this.state.minRaise = amount;
        if (player.chips === 0) player.allIn = true;
        player.lastAction = 'raise';
        break;
      }

      case 'all_in': {
        const allInAmount = player.chips;
        player.bet += allInAmount;
        player.totalBet += allInAmount;
        this.state.pot += allInAmount;
        player.chips = 0;
        player.allIn = true;
        player.lastAction = 'all_in';
        if (player.bet > this.state.currentBet) {
          this.state.currentBet = player.bet;
        }
        break;
      }
    }

    this.state.lastAction = { playerId, action, amount };
    this.nextPlayer();
    this.state.updatedAt = new Date();
    return true;
  }

  private nextPlayer(): void {
    const activePlayers = this.state.players.filter(p => !p.folded && !p.allIn);
    if (activePlayers.length <= 1) {
      this.endGame();
      return;
    }

    let nextIndex = (this.state.currentPlayerIndex + 1) % this.state.players.length;
    let attempts = 0;

    while (
      (this.state.players[nextIndex].folded || this.state.players[nextIndex].allIn) &&
      attempts < this.state.players.length
    ) {
      nextIndex = (nextIndex + 1) % this.state.players.length;
      attempts++;
    }

    this.state.currentPlayerIndex = nextIndex;

    if (this.isBettingRoundComplete()) {
      this.advancePhase();
    }
  }

  private isBettingRoundComplete(): boolean {
    const activePlayers = this.state.players.filter(p => !p.folded && !p.allIn);
    if (activePlayers.length === 0) return true;

    const allMatched = activePlayers.every(p => p.bet === this.state.currentBet);
    const allActed = activePlayers.every(p => p.lastAction !== undefined);

    return allMatched && allActed;
  }

  private advancePhase(): void {
    this.state.players.forEach(p => {
      p.bet = 0;
      p.lastAction = undefined;
    });
    this.state.currentBet = 0;
    this.state.minRaise = this.state.bigBlind;

    switch (this.state.phase) {
      case 'preflop':
        this.state.phase = 'flop';
        this.state.communityCards.push(this.state.deck.pop()!);
        this.state.communityCards.push(this.state.deck.pop()!);
        this.state.communityCards.push(this.state.deck.pop()!);
        break;
      case 'flop':
        this.state.phase = 'turn';
        this.state.communityCards.push(this.state.deck.pop()!);
        break;
      case 'turn':
        this.state.phase = 'river';
        this.state.communityCards.push(this.state.deck.pop()!);
        break;
      case 'river':
        this.state.phase = 'showdown';
        this.endGame();
        return;
    }

    this.state.currentPlayerIndex = (this.state.dealerIndex + 1) % this.state.players.length;
    while (
      this.state.players[this.state.currentPlayerIndex].folded ||
      this.state.players[this.state.currentPlayerIndex].allIn
    ) {
      this.state.currentPlayerIndex = (this.state.currentPlayerIndex + 1) % this.state.players.length;
    }
  }

  private endGame(): void {
    this.state.phase = 'showdown';

    const activePlayers = this.state.players.filter(p => !p.folded);

    if (activePlayers.length === 1) {
      this.state.winners = [{
        playerId: activePlayers[0].id,
        amount: this.state.pot,
        hand: { rank: 'high_card', name: 'Último jugador', value: 0, bestCards: [] },
      }];
      activePlayers[0].chips += this.state.pot;
    } else {
      for (const player of activePlayers) {
        const allCards = [...player.cards, ...this.state.communityCards];
        player.hand = evaluateHand(allCards);
      }

      const sorted = [...activePlayers].sort((a, b) => {
        if (!a.hand || !b.hand) return 0;
        return b.hand.value - a.hand.value;
      });

      const bestHand = sorted[0].hand!;
      const winners = sorted.filter(p => p.hand!.value === bestHand.value);

      const winAmount = Math.floor(this.state.pot / winners.length);
      this.state.winners = winners.map(w => ({
        playerId: w.id,
        amount: winAmount,
        hand: w.hand!,
      }));

      for (const winner of winners) {
        const player = this.state.players.find(p => p.id === winner.playerId);
        if (player) {
          player.chips += winAmount;
        }
      }
    }

    this.state.phase = 'finished';
    this.state.updatedAt = new Date();
  }

  getPlayerState(playerId: string): any {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return null;

    return {
      gameId: this.state.gameId,
      phase: this.state.phase,
      players: this.state.players.map(p => ({
        id: p.id,
        username: p.username,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        isDealer: p.isDealer,
        isSmallBlind: p.isSmallBlind,
        isBigBlind: p.isBigBlind,
        lastAction: p.lastAction,
        cardCount: p.cards.length,
      })),
      communityCards: this.state.communityCards,
      pot: this.state.pot,
      currentBet: this.state.currentBet,
      currentPlayerIndex: this.state.currentPlayerIndex,
      smallBlind: this.state.smallBlind,
      bigBlind: this.state.bigBlind,
      winners: this.state.winners,
      lastAction: this.state.lastAction,
      myCards: player.cards,
      myHand: player.hand,
    };
  }
}
