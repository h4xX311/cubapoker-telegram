/**
 * EQUIDAD DEL ALL-IN Y REPLAY PUBLICO
 * ===================================
 *
 * El motor resuelve la mano de golpe cuando todos estan all-in. Para que el
 * jugador vea algo parecido a una retransmision, `buildAllInReveal` calcula la
 * probabilidad de cada calle con las cartas conocidas. Esta prueba comprueba
 * que ese calculo:
 *
 *   1. Suma 100 % y es determinista para el mismo board.
 *   2. En el river no estima: el ganador sale 100 % y el perdedor 0 %.
 *   3. La vista publica conserva el replay y no inventa cartas de quien no
 *      llego al showdown.
 *
 * No necesita Mongo: son funciones puras.
 */

const assert = require('assert');
const { calculateEquity } = require('../dist/game/hand.equity');
const { toPublicTable } = require('../dist/models/Table');

let ok = 0;
let fail = 0;

function prueba(nombre, fn) {
  try {
    fn();
    ok++;
    console.log(`  \x1b[32mok\x1b[0m   ${nombre}`);
  } catch (error) {
    fail++;
    console.log(`  \x1b[31mFALLA\x1b[0m ${nombre}`);
    console.log(`        ${error.message}`);
  }
}

const carta = (rank, suit) => ({ rank, suit });
const board = (...cartas) => cartas.map(([r, s]) => carta(r, s));

console.log('\n\x1b[1mCubaPoker · Equidad del all-in y replay\x1b[0m');

// ---------------------------------------------------------------------------
prueba('el river resuelve 100/0 sin simular', () => {
  const jugadores = [
    { id: '0', cards: board(['A', 'hearts'], ['A', 'spades']) },
    { id: '1', cards: board(['K', 'hearts'], ['K', 'diamonds']) },
  ];
  const mesa = board(
    ['A', 'clubs'],
    ['7', 'hearts'],
    ['4', 'spades'],
    ['2', 'clubs'],
    ['9', 'diamonds'],
  );

  const r = calculateEquity(jugadores, mesa, 5000, 7);
  assert.strictEqual(r.find((p) => p.playerId === '0').equity, 100);
  assert.strictEqual(r.find((p) => p.playerId === '1').equity, 0);
});

prueba('el turn es determinista y suma 100', () => {
  const jugadores = [
    // Doble pareja con el J y el 7 del board.
    { id: '0', cards: board(['J', 'spades'], ['7', 'clubs']) },
    // Escalera hecha 7-8-9-T-J.
    { id: '1', cards: board(['8', 'clubs'], ['T', 'clubs']) },
  ];
  const mesa = board(
    ['2', 'clubs'],
    ['7', 'diamonds'],
    ['9', 'spades'],
    ['J', 'hearts'],
  );

  const a = calculateEquity(jugadores, mesa, 4000, 12345);
  const b = calculateEquity(jugadores, mesa, 4000, 12345);
  assert.deepStrictEqual(a, b, 'la misma semilla debe dar el mismo resultado');
  assert.strictEqual(a.reduce((s, p) => s + p.equity, 0), 100);
  assert(
    a.find((p) => p.playerId === '1').equity >
      a.find((p) => p.playerId === '0').equity,
    'la escalera debe ir por delante de la doble pareja',
  );
  assert(
    a.find((p) => p.playerId === '0').equity > 0,
    'la doble pareja conserva outs y no debe salir 0 % en el turn',
  );
});

prueba('tres jugadores siguen sumando 100', () => {
  const jugadores = [
    { id: '0', cards: board(['A', 'hearts'], ['K', 'hearts']) },
    { id: '1', cards: board(['Q', 'clubs'], ['Q', 'diamonds']) },
    { id: '2', cards: board(['7', 'spades'], ['6', 'spades']) },
  ];
  const mesa = board(
    ['2', 'clubs'],
    ['9', 'diamonds'],
    ['J', 'spades'],
    ['4', 'hearts'],
    ['3', 'clubs'],
  );

  const r = calculateEquity(jugadores, mesa, 3000, 99);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r.reduce((s, p) => s + p.equity, 0), 100);
  assert(
    r.every((p) => p.equity >= 0 && p.equity <= 100),
    'cada porcentaje debe quedar entre 0 y 100',
  );
});

// ---------------------------------------------------------------------------
prueba('la vista publica conserva el replay del all-in', () => {
  const allIn = {
    startStreet: 'turn',
    board: ['2|clubs', '7|diamonds', '9|spades', 'J|hearts', '4|hearts'],
    players: [
      {
        seatIndex: 0,
        displayName: 'Ana',
        cards: ['J|spades', '7|clubs'],
        equity: { preflop: 44, flop: 38, turn: 20, river: 0 },
        handName: {
          preflop: 'Carta alta',
          flop: 'Doble pareja',
          turn: 'Doble pareja',
          river: 'Doble pareja',
        },
      },
      {
        seatIndex: 1,
        displayName: 'Luis',
        cards: ['8|clubs', 'T|clubs'],
        equity: { preflop: 56, flop: 62, turn: 80, river: 100 },
        handName: {
          preflop: 'Carta alta',
          flop: 'Escalera',
          turn: 'Escalera',
          river: 'Escalera',
        },
      },
    ],
  };

  const mesa = {
    tableId: 'mesa-allin',
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 1000,
    maxSeats: 2,
    seats: [
      {
        index: 0,
        kind: 'human',
        displayName: 'Ana',
        chips: 0,
        bet: 0,
        status: 'active',
        isDealer: true,
      },
      {
        index: 1,
        kind: 'human',
        displayName: 'Luis',
        chips: 2000,
        bet: 0,
        status: 'active',
      },
    ],
    hand: {
      handNumber: 9,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      lastResult: {
        handNumber: 9,
        endedAt: new Date().toISOString(),
        pot: 2000,
        potUsdt: 2,
        rake: 0,
        rakeUsdt: 0,
        board: allIn.board,
        winners: [
          {
            seatIndex: 1,
            displayName: 'Luis',
            amount: 2000,
            amountUsdt: 2,
            handName: 'Escalera',
            cards: ['8|clubs', 'T|clubs'],
          },
        ],
        showdown: [
          {
            seatIndex: 0,
            displayName: 'Ana',
            cards: ['J|spades', '7|clubs'],
            handName: 'Doble pareja',
          },
          {
            seatIndex: 1,
            displayName: 'Luis',
            cards: ['8|clubs', 'T|clubs'],
            handName: 'Escalera',
          },
        ],
        endedByFold: false,
        unit: 'USDT',
        allIn,
      },
    },
    stats: { rakeCollected: 0 },
  };

  const vista = toPublicTable(mesa, 1);
  assert(vista.hand.lastResult, 'falta lastResult');
  assert(vista.hand.lastResult.allIn, 'falta el replay allIn');
  assert.strictEqual(vista.hand.lastResult.allIn.startStreet, 'turn');
  assert.strictEqual(vista.hand.lastResult.allIn.players.length, 2);
  assert.strictEqual(
    vista.hand.lastResult.allIn.players[0].equity.turn,
    20,
  );
  assert.strictEqual(
    vista.hand.lastResult.allIn.players[1].equity.river,
    100,
  );

  const json = JSON.stringify(vista);
  assert(json.includes('"allIn"'), 'la serializacion no lleva el replay');
  assert(!json.includes('botProfile'), 'la vista no debe delatar bots');
});

prueba('el replay no revela cartas de quien no llego al showdown', () => {
  const mesa = {
    tableId: 'mesa-fold',
    kind: 'cash',
    tierId: 't1',
    status: 'running',
    smallBlind: 5,
    bigBlind: 10,
    buyInUnits: 1000,
    maxSeats: 3,
    seats: [
      { index: 0, kind: 'human', displayName: 'Ana', chips: 1000, bet: 0, status: 'active' },
      { index: 1, kind: 'human', displayName: 'Luis', chips: 1000, bet: 0, status: 'active' },
      { index: 2, kind: 'human', displayName: 'Marta', chips: 1000, bet: 0, status: 'folded' },
    ],
    hand: {
      handNumber: 10,
      phase: 'idle',
      communityCards: [],
      pot: 0,
      currentBet: 0,
      lastResult: {
        handNumber: 10,
        endedAt: new Date().toISOString(),
        pot: 100,
        potUsdt: 0.1,
        rake: 0,
        rakeUsdt: 0,
        board: ['As', 'Kd', '7c', '4h', '2s'],
        winners: [
          {
            seatIndex: 0,
            displayName: 'Ana',
            amount: 100,
            amountUsdt: 0.1,
            handName: 'Pareja de ases',
            cards: ['Ah', 'Ad'],
          },
        ],
        showdown: [
          {
            seatIndex: 0,
            displayName: 'Ana',
            cards: ['Ah', 'Ad'],
            handName: 'Pareja de ases',
          },
          {
            seatIndex: 1,
            displayName: 'Luis',
            cards: ['Kh', 'Kc'],
            handName: 'Pareja de reyes',
          },
        ],
        endedByFold: false,
        unit: 'USDT',
        allIn: {
          startStreet: 'river',
          board: ['As', 'Kd', '7c', '4h', '2s'],
          players: [
            {
              seatIndex: 0,
              displayName: 'Ana',
              cards: ['Ah', 'Ad'],
              equity: { preflop: 80, flop: 90, turn: 95, river: 100 },
              handName: { preflop: 'Pareja', flop: 'Pareja', turn: 'Pareja', river: 'Pareja' },
            },
            {
              seatIndex: 1,
              displayName: 'Luis',
              cards: ['Kh', 'Kc'],
              equity: { preflop: 20, flop: 10, turn: 5, river: 0 },
              handName: { preflop: 'Pareja', flop: 'Pareja', turn: 'Pareja', river: 'Pareja' },
            },
          ],
        },
      },
    },
    stats: { rakeCollected: 0 },
  };

  const vista = toPublicTable(mesa, 0);
  assert.strictEqual(vista.hand.lastResult.allIn.players.length, 2);
  assert(
    vista.hand.lastResult.allIn.players.every((p) => p.seatIndex !== 2),
    'el replay no debe incluir a quien se retiro',
  );
  assert(
    vista.hand.lastResult.showdown.every((p) => p.seatIndex !== 2),
    'el showdown no debe incluir a quien se retiro',
  );
});

console.log(`\n${ok} correctas, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
