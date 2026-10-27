import { Card, createDeck, shuffleDeck } from './card.utils';
import { evaluateHand, HandResult } from './hand.evaluator';
import { settlePot } from './sidepots';

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

/**
 * Configuración de rake de una mesa.
 *
 * El motor no conoce salas ni tiers: recibe los números ya resueltos por el
 * gestor de mesas. Así el rake se calcula sobre el bote real de la mano y no
 * después, cuando `state.pot` ya vale cero.
 */
export interface RakeConfig {
  /** Porcentaje sobre el bote igualado. 5 = 5 %. */
  percentage: number;
  /** Tope en unidades internas para esta mesa y este número de jugadores. */
  cap: number;
  /** Bote mínimo para cobrar rake. */
  minPot: number;
  /** Si es true, solo se cobra con flop visto o con una 3-bet preflop. */
  requireFlopOr3Bet: boolean;
}

export interface HandWinner {
  playerId: string;
  amount: number;
  hand: HandResult;
}

export interface HandPayout {
  playerId: string;
  amount: number;
}

export interface ShowdownEntry {
  playerId: string;
  cards: Card[];
  hand: HandResult;
}

export interface GameState {
  gameId: string;
  phase: GamePhase;
  players: Player[];
  communityCards: Card[];
  deck: Card[];
  pot: number;
  currentBet: number;
  /** Cuántas subidas hubo en preflop. Una 3-bet son dos subidas. */
  preflopRaises?: number;
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  smallBlind: number;
  bigBlind: number;
  minRaise: number;
  /** Bote bruto de la mano terminada, antes de rake y antes de devolver lo no igualado. */
  potGross?: number;
  /** Rake cobrado en la mano terminada. */
  rake?: number;
  winners?: HandWinner[];
  /** Todos los que cobraron algo, incluidos los botes laterales y lo no igualado. */
  payouts?: HandPayout[];
  /** Cartas y manos de los que llegaron al showdown. Vacío si todos se retiraron. */
  showdown?: ShowdownEntry[];
  lastAction?: { playerId: string; action: PlayerAction; amount?: number };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Asientos por mesa física: 7-max.
 *
 * El producto anuncia campos de 50 a 500 participantes, pero eso es el número
 * de inscritos en total (multi-mesa), no personas sentadas a la vez. Una mesa de
 * poker real son 6-9 jugadores; aquí son 7.
 */
export const DEFAULT_MAX_PLAYERS = 7;

/**
 * Techo MATEMÁTICO de jugadores en una mano.
 *
 * Una baraja son 52 cartas. Cada jugador recibe 2 y la mesa necesita 5
 * comunitarias, así que el máximo absoluto es `(52 - 5) / 2 = 23`.
 */
export const MAX_DEALABLE_PLAYERS = Math.floor((52 - 5) / 2); // 23

const BETTING_PHASES = new Set<GamePhase>(['preflop', 'flop', 'turn', 'river']);

export class PokerGame {
  private state: GameState;
  private readonly maxPlayers: number;
  private readonly rakeConfig?: RakeConfig;

  constructor(
    gameId: string,
    smallBlind: number = 1,
    bigBlind: number = 2,
    maxPlayers: number = DEFAULT_MAX_PLAYERS,
    rakeConfig?: RakeConfig,
  ) {
    // Las ciegas y las fichas son unidades enteras. Aceptar 12,5/25 no es una
    // mesa de póker: es una mesa que produce medios puntos y descuadra el
    // ledger. Se falla al construir, no en mitad de una mano.
    if (!Number.isInteger(smallBlind) || smallBlind <= 0) {
      throw new Error(`Ciega pequeña inválida: ${smallBlind}. Debe ser un entero positivo.`);
    }
    if (!Number.isInteger(bigBlind) || bigBlind < smallBlind) {
      throw new Error(
        `Ciega grande inválida: ${bigBlind}. Debe ser un entero positivo y no menor que la pequeña.`,
      );
    }
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2) {
      throw new Error(`Número de asientos inválido: ${maxPlayers}.`);
    }

    this.maxPlayers = maxPlayers;
    this.rakeConfig = rakeConfig;
    this.state = {
      gameId,
      phase: 'waiting',
      players: [],
      communityCards: [],
      deck: [],
      pot: 0,
      currentBet: 0,
      preflopRaises: 0,
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
    return {
      ...this.state,
      players: this.state.players.map(player => ({
        ...player,
        cards: [...player.cards],
        hand: player.hand ? { ...player.hand, bestCards: [...player.hand.bestCards] } : undefined,
      })),
      communityCards: [...this.state.communityCards],
      deck: [...this.state.deck],
      winners: this.state.winners?.map(w => ({ ...w })),
      payouts: this.state.payouts?.map(p => ({ ...p })),
      showdown: this.state.showdown?.map(s => ({
        ...s,
        cards: [...s.cards],
        hand: { ...s.hand, bestCards: [...s.hand.bestCards] },
      })),
      lastAction: this.state.lastAction ? { ...this.state.lastAction } : undefined,
    };
  }

  addPlayer(id: string, username: string, chips: number): boolean {
    if (this.state.players.length >= this.maxPlayers) return false;
    if (this.state.phase !== 'waiting') return false;
    if (this.state.players.some(p => p.id === id)) return false;
    if (!Number.isFinite(chips) || chips <= 0) return false;

    this.state.players.push({
      id,
      username,
      chips: Math.floor(chips),
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
   * `startingDealerIndex` permite que el botón gire de mano a mano. Sin ese
   * parámetro el dealer se quedaba clavado en el asiento 0 para siempre.
   */
  startGame(startingDealerIndex?: number, presetDeck?: Card[]): boolean {
    if (this.state.players.length < 2) return false;
    if (this.state.players.length > MAX_DEALABLE_PLAYERS) return false;

    this.state.phase = 'preflop';
    // `presetDeck` es solo para pruebas y para reproducir una mano concreta.
    // En producción siempre se baraja con el RNG criptográfico.
    this.state.deck = presetDeck
      ? presetDeck.map(card => ({ ...card }))
      : shuffleDeck(createDeck());
    this.state.communityCards = [];
    this.state.pot = 0;
    this.state.potGross = undefined;
    this.state.rake = undefined;
    this.state.currentBet = 0;
    this.state.preflopRaises = 0;
    this.state.minRaise = this.state.bigBlind;
    this.state.winners = undefined;
    this.state.payouts = undefined;
    this.state.showdown = undefined;
    this.state.lastAction = undefined;

    this.state.players.forEach(p => {
      p.bet = 0;
      p.totalBet = 0;
      p.cards = [];
      p.folded = false;
      p.allIn = false;
      p.lastAction = undefined;
      p.hand = undefined;
      p.isDealer = false;
      p.isSmallBlind = false;
      p.isBigBlind = false;
    });

    const n = this.state.players.length;

    if (typeof startingDealerIndex === 'number' && startingDealerIndex >= 0) {
      this.state.dealerIndex = Math.floor(startingDealerIndex) % n;
    }

    // Heads-up: el botón pone la ciega pequeña y actúa primero preflop. En una
    // mesa de 3+ el botón es el último en hablar preflop. Antes se calculaba
    // siempre `dealer+1` y `dealer+2`, y en heads-up el botón acababa pagando
    // las dos ciegas: una mano imposible de jugar.
    if (n === 2) {
      this.state.smallBlindIndex = this.state.dealerIndex;
      this.state.bigBlindIndex = (this.state.dealerIndex + 1) % n;
    } else {
      this.state.smallBlindIndex = (this.state.dealerIndex + 1) % n;
      this.state.bigBlindIndex = (this.state.dealerIndex + 2) % n;
    }

    this.state.players[this.state.dealerIndex].isDealer = true;
    this.state.players[this.state.smallBlindIndex].isSmallBlind = true;
    this.state.players[this.state.bigBlindIndex].isBigBlind = true;

    this.postBlind(this.state.smallBlindIndex, this.state.smallBlind);
    this.postBlind(this.state.bigBlindIndex, this.state.bigBlind);

    this.dealCards();

    // La ciega grande marca la apuesta mínima aunque esté all-in por menos: los
    // demás deben poner la ciega completa y el exceso va a un bote lateral. Si
    // se usara solo lo que puso la BB corta, una mesa con ciegas 10/20 dejaría
    // subir a 30 en vez de 40.
    this.state.currentBet = this.state.bigBlind;

    this.state.currentPlayerIndex = this.firstToAct('preflop');
    this.state.updatedAt = new Date();

    // Si la primera posición ya está all-in (por ejemplo, ciegas cortas), se
    // avanza hasta alguien que pueda decidir. Si no hay nadie, se corre la
    // mesa y se hace showdown sin esperar una acción imposible.
    this.skipToActionable();
    return true;
  }

  private postBlind(playerIndex: number, amount: number): void {
    const player = this.state.players[playerIndex];
    const actualAmount = Math.min(amount, player.chips);
    player.chips -= actualAmount;
    player.bet += actualAmount;
    player.totalBet += actualAmount;
    this.state.pot += actualAmount;

    if (player.chips === 0) player.allIn = true;
  }

  /** Reparte dos cartas a cada jugador. */
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

  /**
   * Reparte cartas comunitarias. Si el mazo se agotara, la mano se detiene en
   * vez de repartir `undefined` (que revienta el evaluador).
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

  /**
   * Aplica una acción.
   *
   * IMPORTANTE: en `raise`, `amount` es el **total al que queda la apuesta del
   * jugador después de subir**, no el incremento. Es la misma semántica que
   * `currentBet`, y evita la doble suma que tenía el cliente:
   *
   *   bote actual 20, el jugador quiere subir a 40 -> amount = 40.
   *
   * El motor comprueba el mínimo y las fichas disponibles. Si `amount` es el
   * stack completo del jugador, se acepta como all-in aunque no llegue al
   * mínimo de subida (una subida corta es legal; lo que no hace es reabrir la
   * apuesta).
   */
  performAction(playerId: string, action: PlayerAction, amount?: number): boolean {
    if (!BETTING_PHASES.has(this.state.phase)) return false;

    const playerIndex = this.state.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return false;
    if (playerIndex !== this.state.currentPlayerIndex) return false;

    const player = this.state.players[playerIndex];
    if (player.folded || player.allIn || player.chips <= 0) return false;

    switch (action) {
      case 'fold':
        player.folded = true;
        player.lastAction = 'fold';
        break;

      case 'check':
        if (player.bet !== this.state.currentBet) return false;
        player.lastAction = 'check';
        break;

      case 'call': {
        const callAmount = Math.min(this.state.currentBet - player.bet, player.chips);
        if (callAmount <= 0) return false;
        player.chips -= callAmount;
        player.bet += callAmount;
        player.totalBet += callAmount;
        this.state.pot += callAmount;
        if (player.chips === 0) player.allIn = true;
        player.lastAction = 'call';
        break;
      }

      case 'raise': {
        if (!Number.isFinite(amount)) return false;
        const target = Math.floor(amount as number);
        const stackTarget = player.bet + player.chips;

        // Subir a lo que ya hay no es subir; para eso está `call`.
        if (target <= this.state.currentBet) return false;
        if (target > stackTarget) return false;

        const isAllIn = target === stackTarget;
        const minTarget = this.state.currentBet + this.state.minRaise;
        if (target < minTarget && !isAllIn) return false;

        const added = target - player.bet;
        player.chips -= added;
        player.bet = target;
        player.totalBet += added;
        this.state.pot += added;

        const raiseSize = target - this.state.currentBet;
        const fullRaise = raiseSize >= this.state.minRaise;
        this.state.currentBet = target;
        if (fullRaise) this.state.minRaise = raiseSize;
        if (this.state.phase === 'preflop') {
          this.state.preflopRaises = (this.state.preflopRaises ?? 0) + 1;
        }

        if (player.chips === 0) player.allIn = true;
        player.lastAction = isAllIn ? 'all_in' : 'raise';
        this.clearOthersAction(player);
        break;
      }

      case 'all_in': {
        const allInAmount = player.chips;
        if (allInAmount <= 0) return false;

        const previousBet = player.bet;
        const newBet = previousBet + allInAmount;

        player.chips = 0;
        player.bet = newBet;
        player.totalBet += allInAmount;
        this.state.pot += allInAmount;
        player.allIn = true;
        player.lastAction = 'all_in';

        if (newBet > this.state.currentBet) {
          const raiseSize = newBet - this.state.currentBet;
          const fullRaise = raiseSize >= this.state.minRaise;
          this.state.currentBet = newBet;
          if (fullRaise) this.state.minRaise = raiseSize;
          if (this.state.phase === 'preflop') {
            this.state.preflopRaises = (this.state.preflopRaises ?? 0) + 1;
          }
          this.clearOthersAction(player);
        }
        break;
      }

      default:
        return false;
    }

    this.state.lastAction = { playerId, action, amount };
    this.advanceTurn();
    this.state.updatedAt = new Date();
    return true;
  }

  /**
   * Cuando alguien sube, los demás vuelven a tener acción pendiente. Sin esto,
   * un jugador que ya había igualado podía quedarse con `lastAction` puesto y
   * la ronda se cerraba antes de que respondiera a la subida.
   */
  private clearOthersAction(aggresor: Player): void {
    for (const other of this.state.players) {
      if (other === aggresor || other.folded || other.allIn) continue;
      other.lastAction = undefined;
    }
  }

  /** Primer asiento que puede actuar en una calle. */
  private firstToAct(phase: 'preflop' | 'postflop'): number {
    const n = this.state.players.length;
    if (n === 0) return 0;

    if (phase === 'preflop') {
      return n === 2
        ? this.state.dealerIndex
        : (this.state.bigBlindIndex + 1) % n;
    }

    // Postflop habla primero el primer jugador a la izquierda del botón. En
    // heads-up ese es la ciega grande, que es el otro jugador.
    return n === 2
      ? this.state.bigBlindIndex
      : (this.state.dealerIndex + 1) % n;
  }

  /**
   * Avanza hasta el siguiente jugador que pueda actuar. Devuelve false si no
   * queda ninguno (todos all-in o retirados).
   */
  private skipToActionable(): boolean {
    const n = this.state.players.length;
    for (let hop = 0; hop < n; hop++) {
      const player = this.state.players[this.state.currentPlayerIndex];
      if (player && !player.folded && !player.allIn && player.chips > 0) return true;
      this.state.currentPlayerIndex = (this.state.currentPlayerIndex + 1) % n;
    }

    // Nadie puede actuar: se corre la mesa completa y se resuelve.
    this.runoutToShowdown();
    return false;
  }

  private advanceTurn(): void {
    const contenders = this.state.players.filter(p => !p.folded);
    if (contenders.length <= 1) {
      this.settleHand();
      return;
    }

    const actionable = contenders.filter(p => !p.allIn && p.chips > 0);
    if (actionable.length === 0) {
      this.runoutToShowdown();
      return;
    }

    const roundComplete = actionable.every(
      p => p.bet === this.state.currentBet && p.lastAction !== undefined,
    );
    if (roundComplete) {
      this.advancePhase();
      return;
    }

    // Siguiente asiento con acción pendiente. Se busca desde el jugador actual,
    // no desde el array de activos: los índices del motor son los del asiento.
    const n = this.state.players.length;
    for (let hop = 1; hop <= n; hop++) {
      const idx = (this.state.currentPlayerIndex + hop) % n;
      const p = this.state.players[idx];
      if (p && !p.folded && !p.allIn && p.chips > 0) {
        this.state.currentPlayerIndex = idx;
        return;
      }
    }

    // Solo queda un jugador con fichas. Si ya igualó y actuó, la ronda terminó;
    // si no, es él mismo el que tiene la opción (por ejemplo, la ciega grande).
    this.state.currentPlayerIndex = this.state.players.findIndex(
      p => !p.folded && !p.allIn && p.chips > 0,
    );
  }

  private advancePhase(): void {
    this.state.players.forEach(p => {
      p.bet = 0;
      p.lastAction = undefined;
    });
    this.state.currentBet = 0;
    this.state.minRaise = this.state.bigBlind;

    const stages: Record<string, { to: GamePhase; cards: number } | null> = {
      preflop: { to: 'flop', cards: 3 },
      flop: { to: 'turn', cards: 1 },
      turn: { to: 'river', cards: 1 },
      river: null,
    };

    const stage = stages[this.state.phase];
    if (!stage) {
      this.state.phase = 'showdown';
      this.settleHand();
      return;
    }

    if (!this.dealCommunity(stage.cards)) return;

    this.state.phase = stage.to;
    this.state.currentPlayerIndex = this.firstToAct('postflop');

    const actionable = this.state.players.filter(
      p => !p.folded && !p.allIn && p.chips > 0,
    );

    // Si solo queda uno con fichas, no hay apuesta posible: se reparte el resto
    // de la mesa y se va al showdown. Antes se llamaba a `endGame()` aquí, y la
    // mano terminaba en el flop con all-ins sin resolver.
    if (actionable.length <= 1) {
      this.runoutToShowdown();
      return;
    }

    this.skipToActionable();
  }

  /**
   * Reparte todas las cartas que falten y resuelve la mano. Se usa cuando ya no
   * queda ninguna decisión posible (todos all-in, o solo uno con fichas).
   */
  private runoutToShowdown(): void {
    while (this.state.communityCards.length < 5) {
      const missing = 5 - this.state.communityCards.length;
      const deal = this.state.communityCards.length === 0 ? Math.min(3, missing) : 1;
      if (!this.dealCommunity(deal)) return;
    }

    this.state.phase = 'showdown';
    this.settleHand();
  }

  /**
   * Calcula el rake sobre el bote que realmente fue igualado.
   *
   * Lo que un jugador apuesta y nadie iguala no es bote: se le devuelve. Cobrar
   * rake sobre esa parte sería cobrar por dinero que nunca estuvo en juego.
   */
  private calculateRake(matchedPot: number, sawFlop: boolean): number {
    const config = this.rakeConfig;
    if (!config || matchedPot <= 0) return 0;
    if (matchedPot < config.minPot) return 0;
    if (config.requireFlopOr3Bet && !sawFlop && (this.state.preflopRaises ?? 0) < 2) {
      return 0;
    }

    const percentage = Math.max(0, config.percentage);
    const cap = Math.max(0, config.cap);
    return Math.min(Math.floor((matchedPot * percentage) / 100), cap);
  }

  /** Cierra la mano: evalúa, reparte botes laterales, cobra rake y acredita. */
  private settleHand(): void {
    const contenders = this.state.players.filter(p => !p.folded);

    // --- Evaluación -----------------------------------------------------
    let grupos: string[][] = [];

    if (contenders.length === 1) {
      this.state.showdown = [];
      grupos = [[contenders[0].id]];
    } else {
      for (const player of contenders) {
        player.hand = evaluateHand([...player.cards, ...this.state.communityCards]);
      }

      const sorted = [...contenders].sort((a, b) => {
        if (!a.hand || !b.hand) return 0;
        return b.hand.value - a.hand.value;
      });

      for (const p of sorted) {
        const valor = p.hand!.value;
        const ultimo = grupos[grupos.length - 1];
        if (ultimo && this.sameHandValue(ultimo[0], p.id, sorted)) ultimo.push(p.id);
        else grupos.push([p.id]);
      }

      this.state.showdown = sorted.map(p => ({
        playerId: p.id,
        cards: [...p.cards],
        hand: p.hand!,
      }));
    }

    // --- Bote bruto y aportaciones --------------------------------------
    const contributions = this.state.players.map(p => ({
      id: p.id,
      amount: Math.max(0, Math.floor(p.totalBet)),
    }));
    const grossPot = contributions.reduce((sum, c) => sum + c.amount, 0);

    // --- Lo que no fue igualado ----------------------------------------
    // Si un jugador puso más que todos los demás, la diferencia nunca estuvo
    // en juego: se le devuelve y no paga rake.
    const ordered = [...contributions]
      .filter(c => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const top = ordered[0];
    const secondAmount = ordered[1]?.amount ?? 0;
    const uncalled = top && top.amount > secondAmount ? top.amount - secondAmount : 0;
    const matchedPot = grossPot - uncalled;

    if (top && uncalled > 0) {
      // Se rebaja la aportación del que puso de más hasta el segundo nivel. El
      // resto se le devuelve después, fuera del reparto y fuera del rake.
      for (const c of contributions) {
        if (c.amount > secondAmount) c.amount = secondAmount;
      }
    }

    const sawFlop = this.state.communityCards.length > 0;
    const rake = this.calculateRake(matchedPot, sawFlop);

    // --- Reparto de botes laterales -------------------------------------
    const premios = settlePot(contributions, grupos);

    let repartido = Object.values(premios).reduce((sum, n) => sum + n, 0);
    if (repartido < matchedPot) {
      // Red de seguridad: si un tramo se quedó sin elegibles, vuelve al mejor
      // de la mano. Es preferible a que las fichas desaparezcan del sistema.
      const mejor = grupos[0]?.[0];
      if (mejor) {
        premios[mejor] = (premios[mejor] ?? 0) + (matchedPot - repartido);
        repartido = matchedPot;
      }
    }

    // --- Rake proporcional entre los que cobran -------------------------
    const netos: Record<string, number> = { ...premios };
    if (rake > 0 && matchedPot > 0) {
      const entradas = Object.entries(netos)
        .filter(([, amount]) => amount > 0)
        .sort((a, b) => b[1] - a[1]);

      let pendiente = rake;
      const descuentos = new Map<string, number>();

      for (const [id, amount] of entradas) {
        const descuento = Math.min(amount, Math.floor((amount * rake) / matchedPot));
        descuentos.set(id, descuento);
        pendiente -= descuento;
      }

      // El resto de la división se cobra de una en una a los mayores premios.
      for (const [id, amount] of entradas) {
        if (pendiente <= 0) break;
        const actual = descuentos.get(id) ?? 0;
        if (actual < amount) {
          descuentos.set(id, actual + 1);
          pendiente--;
        }
      }

      for (const [id, descuento] of descuentos) {
        netos[id] = Math.max(0, (netos[id] ?? 0) - descuento);
      }
    }

    // Lo no igualado vuelve a su dueño, aunque se haya retirado después. Nunca
    // formó parte del bote y no puede quedarse en la mesa.
    if (top && uncalled > 0) {
      netos[top.id] = (netos[top.id] ?? 0) + uncalled;
    }

    // --- Acreditar -------------------------------------------------------
    let pagado = 0;
    for (const [id, amount] of Object.entries(netos)) {
      if (amount <= 0) continue;
      const player = this.state.players.find(p => p.id === id);
      if (!player) continue;
      player.chips += amount;
      pagado += amount;
    }

    // Invariante de dinero: bote bruto = premios netos + rake. Si no cuadra,
    // se registra en el estado para que el test y el operador lo vean.
    this.state.potGross = grossPot;
    this.state.rake = rake;
    this.state.payouts = Object.entries(netos)
      .filter(([, amount]) => amount > 0)
      .map(([playerId, amount]) => ({ playerId, amount }));
    this.state.pot = 0;

    const ganadores = grupos[0] ?? [];
    this.state.winners = ganadores.map(id => {
      const player = this.state.players.find(p => p.id === id)!;
      return {
        playerId: id,
        amount: netos[id] ?? 0,
        hand: player.hand ?? {
          rank: 'high_card',
          name: 'Último jugador en pie',
          value: 0,
          bestCards: [],
        },
      };
    }).filter(w => w.amount > 0);

    if (pagado !== matchedPot - rake + uncalled) {
      // No se lanza una excepción en producción: la mesa tiene que cerrar. Pero
      // el desajuste queda en `state` y el test de conservación lo detecta.
      this.state.lastAction = {
        playerId: 'system',
        action: 'fold',
        amount: pagado,
      };
    }

    this.state.phase = 'finished';
    this.state.updatedAt = new Date();
  }

  /**
   * Compara dos jugadores por el valor exacto de su mano. Se usa para agrupar
   * empates; no basta con comparar contra el anterior del array ordenado, porque
   * el anterior puede ser de otro grupo.
   */
  private sameHandValue(idA: string, idB: string, players: Player[]): boolean {
    const a = players.find(p => p.id === idA)?.hand?.value;
    const b = players.find(p => p.id === idB)?.hand?.value;
    return a !== undefined && b !== undefined && a === b;
  }

  getPlayerState(playerId: string): any {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return null;

    const toCall = Math.max(0, this.state.currentBet - player.bet);
    const canCheck = toCall === 0;
    const canRaise = player.chips > toCall;

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
      potGross: this.state.potGross,
      rake: this.state.rake,
      currentBet: this.state.currentBet,
      minRaise: this.state.minRaise,
      currentPlayerIndex: this.state.currentPlayerIndex,
      smallBlind: this.state.smallBlind,
      bigBlind: this.state.bigBlind,
      winners: this.state.winners,
      payouts: this.state.payouts,
      showdown: this.state.showdown,
      lastAction: this.state.lastAction,
      myCards: player.cards,
      myHand: player.hand,
      myChips: player.chips,
      myBet: player.bet,
      toCall,
      canCheck,
      canRaise,
    };
  }
}
