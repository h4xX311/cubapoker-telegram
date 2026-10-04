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

/**
 * Tope por defecto de jugadores en el motor. El producto opera mesas de hasta
 * 500, asi que el valor por defecto es generoso y cada mesa lo ajusta a su
 * `maxSeats`.
 */
export const DEFAULT_MAX_PLAYERS = 500;

/**
 * Maximo de jugadores con los que se puede repartir una mano de poker real.
 *
 * Una baraja son 52 cartas. Cada jugador recibe 2 y la mesa necesita 5 cartas
 * comunitarias, asi que el techo es `(52 - 5) / 2 = 23`.
 *
 * Ojo con el 26: parece que caben 26 (52 / 2) pero no, porque las 5 cartas de
 * la mesa no son opcionales. Con 26 jugadores el reparto se come la baraja
 * entera y el flop hace `deck.pop()` sobre un mazo vacio: se reparten cartas
 * `undefined` y el evaluador revienta con
 * `Cannot read properties of undefined (reading 'suit')`.
 *
 * El producto ofrece mesas de 50 a 500 participantes, lo cual es imposible como
 * una sola mano: no existen "mesas cash de 500 jugadores" en el poker. Lo que si
 * existe (y hacen CoinPoker y similares) es una sala donde todos permanecen
 * sentados y se juega por tandas hasta que quedan pocos.
 */
export const MAX_DEALABLE_PLAYERS = Math.floor((52 - 5) / 2); // 23

export class PokerGame {
  private state: GameState;

  /**
   * Reparte una carta comunitaria. Si el mazo se agotara, se registra y la
   * mano vuelve a 'waiting' en vez de seguir repartiendo `undefined`: una carta
   * `undefined` revienta el evaluador y tumba la mesa entera.
   */
  private dealCommunity(count: number): boolean {
    for (let i = 0; i < count; i++) {
      const card = this.state.deck.pop();
      if (!card) {
        this.state.phase = 'waiting';
        return false;
      }
      this.state.communityCards.push(card);
    }
    return true;
  }

  constructor(
    gameId: string,
    smallBlind: number = 1,
    bigBlind: number = 2,
    maxPlayers: number = DEFAULT_MAX_PLAYERS,
  ) {
    this.maxPlayers = maxPlayers;
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

  /**
   * Tope de jugadores sentados.
   *
   * El motor arranca con 6 porque es el maximo de una mesa 6-max. Pero CubaPoker
   * opera mesas de 50 a 500 jugadores, asi que el tope se recibe al construir
   * el motor. Antes estaba fijado en 6 y cualquier mesa grande no arranca:
   * `addPlayer` devolvia false y `startGame` se quedaba con 2 jugadores.
   */
  private readonly maxPlayers: number;

  getState(): GameState {
    return { ...this.state };
  }

  addPlayer(id: string, username: string, chips: number): boolean {
    if (this.state.players.length >= this.maxPlayers) return false;
    if (this.state.phase !== 'waiting') return false;
    // Un asiento no puede ocupar dos veces al mismo jugador en la misma mano.
    if (this.state.players.some(p => p.id === id)) return false;
    if (chips <= 0) return false;

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

  /**
   * Arranca la mano.
   *
   * `startingDealerIndex` permite que el boton gire de mano a mano. Sin ese
   * parametro el dealer se quedaba clavado en el asiento 0 para siempre, que
   * en poker es directamente incorrecto (y da ventaja a quien ocupe ese
   * asiento). El gestor de mesas lo mantiene persistido entre manos.
   */
  startGame(startingDealerIndex?: number): boolean {
    if (this.state.players.length < 2) return false;

    // Comprobacion antes de tocar nada: una mano necesita dos cartas por
    // jugador y la baraja tiene 52. Si no caben, no se arranca la mano. Antes
    // se repartia lo que cupiera y se dejaba al resto sin cartas, con lo que
    // la mesa jugaba una mano rota en la que casi nadie tenia cartas.
    if (this.state.players.length > MAX_DEALABLE_PLAYERS) return false;

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

    // Dealer y ciegas. El orden es estandar: el boton esta a la izquierda del
    // boton de la ciega grande, que es quien primero actua despues del reparto.
    const n = this.state.players.length;

    if (typeof startingDealerIndex === 'number' && startingDealerIndex >= 0) {
      this.state.dealerIndex = Math.floor(startingDealerIndex) % n;
    }

    this.state.smallBlindIndex = (this.state.dealerIndex + 1) % n;
    this.state.bigBlindIndex = (this.state.dealerIndex + 2) % n;

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

  /**
   * Reparte dos cartas a cada jugador.
   *
   * `startGame` ya ha comprobado que caben (MAX_DEALABLE_PLAYERS), asi que aqui
   * siempre hay cartas suficientes. Si aun asi faltara alguna, se registra en
   * vez de repartir un duplicado: dos cartas iguales en jugadores distintos
   * hacen la mano imevaluable y el showdown daria un ganador arbitrario.
   */
  private dealCards(): void {
    for (let i = 0; i < 2; i++) {
      for (const player of this.state.players) {
        const card = this.state.deck.pop();
        if (!card) {
          this.state.phase = 'waiting';
          return;
        }
        player.cards.push(card);
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

    // 3 cartas en el flop, 1 en turn y 1 en river. En river ya no hay ronda de
    // apuesta: se pasa a mostrar cartas.
    const stages: Record<string, { to: GamePhase; cards: number } | null> = {
      preflop: { to: 'flop', cards: 3 },
      flop: { to: 'turn', cards: 1 },
      turn: { to: 'river', cards: 1 },
      river: null,
    };

    const stage: { to: GamePhase; cards: number } | null =
      stages[this.state.phase];
    if (!stage) {
      this.state.phase = 'showdown';
      this.endGame();
      return;
    }

    // Si el mazo no da para la mesa, la mano se detiene en vez de seguir con
    // cartas `undefined` (que revientan el evaluador y tumban la mesa).
    if (!this.dealCommunity(stage.cards)) return;

    this.state.phase = stage.to;

    // Empieza el primero despues del boton (UTG). El bucle necesita un tope:
    // si todos los demas estan all-in o folded no hay a quien dar la palabra, y
    // antes esto entraba en bucle infinito colgando el proceso entero.
    this.state.currentPlayerIndex =
      (this.state.dealerIndex + 1) % this.state.players.length;
    const start = this.state.currentPlayerIndex;
    let hops = 0;

    while (
      (this.state.players[this.state.currentPlayerIndex].folded ||
        this.state.players[this.state.currentPlayerIndex].allIn) &&
      hops < this.state.players.length
    ) {
      this.state.currentPlayerIndex =
        (this.state.currentPlayerIndex + 1) % this.state.players.length;
      hops++;
    }

    // Nadie puede actuar en esta calle: se muestra directamente.
    if (
      this.state.players[this.state.currentPlayerIndex].folded ||
      this.state.players[this.state.currentPlayerIndex].allIn
    ) {
      this.state.currentPlayerIndex = start;
      this.endGame();
    }
  }

  private endGame(): void {
    this.state.phase = 'showdown';

    const activePlayers = this.state.players.filter(p => !p.folded);

    // El bote se reparte SIEMPRE, y a los que no les toca devolverlo.
    //
    // Antes se repartia `floor(pot / winners)` a cada ganador y el resto se
    // quedaba en el bote sin destino. Con dos ganadores impares eso perdia
    // fichas reales del sistema: cada mano restaba 1-2 CUP de la circulacion
    // sin que nadie los recibiera. Con el tiempo las fichas se evaporan y el
    // boton de la mesa llega a 0 para todo el mundo.
    const awardPot = (winnerIds: string[], amounts?: number[]): void => {
      const pool = this.state.pot;
      if (pool <= 0 || winnerIds.length === 0) {
        this.state.pot = 0;
        return;
      }

      const shares =
        amounts ??
        // Reparto con resto explicito: los primeros cobran una unidad extra
        // para que la suma cuadre exactamente con el bote.
        Array.from({ length: winnerIds.length }, (_, i) =>
          Math.floor(pool / winnerIds.length) + (i < pool % winnerIds.length ? 1 : 0),
        );

      let paid = 0;
      winnerIds.forEach((id, i) => {
        const player = this.state.players.find(p => p.id === id);
        if (!player) return;
        const amount = shares[i];
        player.chips += amount;
        paid += amount;
      });

      // Cualquier resto que no se haya podido asignar (por ejemplo, si un
      // ganador fue eliminado a mitad de reparto) vuelve al bote ganador para
      // que el sistema no pierda fichas.
      if (paid < pool && winnerIds.length > 0) {
        const fallback = this.state.players.find(p => p.id === winnerIds[0]);
        if (fallback) {
          fallback.chips += pool - paid;
          paid = pool;
        }
      }

      this.state.pot = 0;
    };

    if (activePlayers.length === 1) {
      // Todos los demas se retiraron: el unico que sigue se lleva el bote sin
      // mostrar cartas. No hay showdown que evaluar.
      this.state.winners = [{
        playerId: activePlayers[0].id,
        amount: this.state.pot,
        hand: { rank: 'high_card', name: 'Ultimo jugador en pie', value: 0, bestCards: [] },
      }];
      awardPot([activePlayers[0].id]);
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

      // Los想到这里 van los datos que vera el cliente. `amount` se rellena
      // despues de repartir, porque el reparto con resto depende del bote real.
      const winnerIds = winners.map(w => w.id);
      this.state.winners = winners.map(w => ({
        playerId: w.id,
        amount: 0,
        hand: w.hand!,
      }));

      // Reparte entre todos los empatados. Un empate divide el bote: darlo
      // entero a uno solo seria robarle a los demas, y en una mesa grande los
      // empates son frequentes, no una excepcion.
      const pot = this.state.pot;
      const shares = Array.from(
        { length: winnerIds.length },
        (_, i) =>
          Math.floor(pot / winnerIds.length) +
          (i < pot % winnerIds.length ? 1 : 0),
      );

      awardPot(winnerIds, shares);

      this.state.winners = this.state.winners.map(w => ({
        ...w,
        amount: shares[winnerIds.indexOf(w.playerId)] ?? 0,
      }));
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
