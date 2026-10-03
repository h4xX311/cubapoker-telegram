import { Card } from './card.utils';

export type HandRank =
  | 'high_card'
  | 'pair'
  | 'two_pair'
  | 'three_of_a_kind'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'four_of_a_kind'
  | 'straight_flush'
  | 'royal_flush';

export interface HandResult {
  rank: HandRank;
  name: string;
  value: number;
  bestCards: Card[];
}

const HAND_RANK_NAMES: Record<HandRank, string> = {
  high_card: 'Carta Alta',
  pair: 'Par',
  two_pair: 'Doble Par',
  three_of_a_kind: 'Trío',
  straight: 'Escalera',
  flush: 'Color',
  full_house: 'Full House',
  four_of_a_kind: 'Póker',
  straight_flush: 'Escalera de Color',
  royal_flush: 'Escalera Real',
};

export const evaluateHand = (cards: Card[]): HandResult => {
  if (cards.length < 5) {
    return { rank: 'high_card', name: 'Carta Alta', value: 1, bestCards: cards.slice(0, 5) };
  }

  const allCombinations = getCombinations(cards, 5);
  let bestHand: HandResult = { rank: 'high_card', name: 'Carta Alta', value: 0, bestCards: [] };

  for (const combo of allCombinations) {
    const result = evaluateFiveCards(combo);
    if (result.value > bestHand.value) {
      bestHand = result;
    }
  }

  return bestHand;
};

const getCombinations = (arr: Card[], size: number): Card[][] => {
  if (size === 0) return [[]];
  if (arr.length === 0) return [];

  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, size - 1).map(combo => [first, ...combo]);
  const withoutFirst = getCombinations(rest, size);

  return [...withFirst, ...withoutFirst];
};

const evaluateFiveCards = (cards: Card[]): HandResult => {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const isFlush = cards.every(c => c.suit === cards[0].suit);
  const isStraight = checkStraight(sorted);
  const counts = getCounts(sorted);

  if (isFlush && isStraight && sorted[0].value === 14) {
    return { rank: 'royal_flush', name: HAND_RANK_NAMES.royal_flush, value: 10000, bestCards: sorted };
  }

  if (isFlush && isStraight) {
    return { rank: 'straight_flush', name: HAND_RANK_NAMES.straight_flush, value: 9000 + sorted[0].value, bestCards: sorted };
  }

  if (counts.some(c => c.count === 4)) {
    const fourCard = counts.find(c => c.count === 4)!;
    const kicker = counts.find(c => c.count === 1)!;
    return { rank: 'four_of_a_kind', name: HAND_RANK_NAMES.four_of_a_kind, value: 8000 + fourCard.value * 15 + kicker.value, bestCards: sorted };
  }

  if (counts.some(c => c.count === 3) && counts.some(c => c.count === 2)) {
    const threeCard = counts.find(c => c.count === 3)!;
    const pairCard = counts.find(c => c.count === 2)!;
    return { rank: 'full_house', name: HAND_RANK_NAMES.full_house, value: 7000 + threeCard.value * 15 + pairCard.value, bestCards: sorted };
  }

  if (isFlush) {
    return { rank: 'flush', name: HAND_RANK_NAMES.flush, value: 6000 + sorted[0].value, bestCards: sorted };
  }

  if (isStraight) {
    return { rank: 'straight', name: HAND_RANK_NAMES.straight, value: 5000 + sorted[0].value, bestCards: sorted };
  }

  if (counts.some(c => c.count === 3)) {
    const threeCard = counts.find(c => c.count === 3)!;
    return { rank: 'three_of_a_kind', name: HAND_RANK_NAMES.three_of_a_kind, value: 4000 + threeCard.value, bestCards: sorted };
  }

  const pairs = counts.filter(c => c.count === 2);
  if (pairs.length === 2) {
    const highPair = Math.max(pairs[0].value, pairs[1].value);
    const lowPair = Math.min(pairs[0].value, pairs[1].value);
    return { rank: 'two_pair', name: HAND_RANK_NAMES.two_pair, value: 3000 + highPair * 15 + lowPair, bestCards: sorted };
  }

  if (pairs.length === 1) {
    return { rank: 'pair', name: HAND_RANK_NAMES.pair, value: 2000 + pairs[0].value, bestCards: sorted };
  }

  return { rank: 'high_card', name: HAND_RANK_NAMES.high_card, value: 1000 + sorted[0].value, bestCards: sorted };
};

const checkStraight = (sorted: Card[]): boolean => {
  let isStraight = true;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].value - sorted[i + 1].value !== 1) {
      isStraight = false;
      break;
    }
  }
  if (isStraight) return true;

  if (sorted[0].value === 14) {
    const aceLow = [5, 4, 3, 2, 1];
    return sorted.every((card, i) => card.value === aceLow[i] || (i === 0 && card.value === 14));
  }

  return false;
};

const getCounts = (cards: Card[]): { value: number; count: number }[] => {
  const counts: { value: number; count: number }[] = [];
  for (const card of cards) {
    const existing = counts.find(c => c.value === card.value);
    if (existing) {
      existing.count++;
    } else {
      counts.push({ value: card.value, count: 1 });
    }
  }
  return counts.sort((a, b) => b.count - a.count || b.value - a.value);
};
