import { randomInt } from 'crypto';

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: Suit;
  rank: Rank;
  value: number;
}

const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const createDeck = (): Card[] => {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANKS.indexOf(rank) + 2 });
    }
  }
  return deck;
};

/**
 * Generador criptográfico por defecto.
 *
 * `Math.random` no sirve para barajar dinero. Su estado se puede predecir a
 * partir de unas cuantas salidas, y en una mesa con apuestas eso es una ventaja
 * explotable. `crypto.randomInt` usa el generador del sistema operativo.
 *
 * El parámetro `rng` existe solo para pruebas deterministas. En producción
 * nunca se pasa: el camino por defecto es el criptográfico.
 */
const cryptoRng = (): number => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;

export const shuffleDeck = (
  deck: Card[],
  rng: () => number = cryptoRng,
): Card[] => {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

export const SUIT_SYMBOL: Record<Suit, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

export const cardToString = (card: Card): string =>
  `${card.rank}${SUIT_SYMBOL[card.suit]}`;
