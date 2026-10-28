/**
 * Entrega de turno y cierre de mano, sin Mongo y sin esperar 30 segundos.
 *
 * Comprueba dos cosas que no se ven en una captura:
 *
 *   1. El aviso al humano lleva `deadlineAt` y `deadlineMs`, calculados desde
 *      el mismo `hand.lastActionAt` que usa la vista de la mesa.
 *   2. Cuando ese plazo vence, `checkTurnTimeout()` ejecuta una accion REAL en
 *      el motor (no solo cambia una bandera de la interfaz), la mesa se cierra
 *      y queda una entrada de historial con las cartas privadas del jugador.
 *
 * Usa un `Table` de mentira con `save()` vacio. No toca la base de datos: asi
 * esta prueba no depende de que haya un Mongo levantado.
 */

const assert = require('assert');
const { TableManager } = require('../dist/game/table.manager');
const { PokerGame } = require('../dist/game/game.state');
const { toPublicTable } = require('../dist/models/Table');
const { TURN_TIMER } = require('../dist/config/product');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d !== undefined) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function crearMesa(engine) {
  const state = engine.getState();
  return {
    tableId: 'mesa-timer',
    kind: 'cash',
    status: 'running',
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    buyInUnits: 1000,
    maxSeats: 2,
    seats: [
      {
        index: 0, kind: 'human', playerId: '111', displayName: 'Ana',
        chips: 1000, bet: 0, totalBet: 0, status: 'active',
        isDealer: false, isSmallBlind: false, isBigBlind: false,
        handsPlayed: 0, handsWon: 0, netChips: 0, joinedAt: new Date(),
      },
      {
        index: 1, kind: 'human', playerId: '222', displayName: 'Luis',
        chips: 1000, bet: 0, totalBet: 0, status: 'active',
        isDealer: false, isSmallBlind: false, isBigBlind: false,
        handsPlayed: 0, handsWon: 0, netChips: 0, joinedAt: new Date(),
      },
    ],
    hand: {
      handNumber: 1,
      phase: 'preflop',
      communityCards: [],
      pot: 15,
      currentBet: 10,
      actingSeat: 0,
      dealerSeat: 0,
      startedAt: new Date(Date.now() - 1000),
      lastActionAt: new Date(Date.now() - 1000),
    },
    handHistory: [],
    stats: { handsPlayed: 1, rakeCollected: 0, prizePaid: 0 },
    save: async () => {},
  };
}

async function main() {
  console.log('\n\x1b[1mCubaPoker · Entrega de turno, timeout e historial\x1b[0m');

  section('1. El aviso lleva el vencimiento exacto');
  {
    const engine = new PokerGame('mesa-timer', 5, 10, 2);
    engine.addPlayer('0', 'Ana', 1000);
    engine.addPlayer('1', 'Luis', 1000);
    assert(engine.startGame(0), 'la mano no arrancó');

    const state = engine.getState();
    const actorIndex = state.currentPlayerIndex;
    const mesa = crearMesa(engine);
    const manager = new TableManager();
    manager.engines.set(mesa.tableId, { engine, handSeed: 1 });

    const avisos = [];
    manager.setNotifier((n) => avisos.push(n));

    const asiento = mesa.seats.find((s) => s.index === actorIndex);
    const inicio = mesa.hand.lastActionAt.getTime();
    manager.notifyHumanTurn(mesa, asiento);

    if (avisos.length === 1) {
      const aviso = avisos[0];
      const esperado = new Date(inicio + TURN_TIMER.humanMs).toISOString();
      if (aviso.deadlineAt === esperado && aviso.deadlineMs === TURN_TIMER.humanMs) {
        ok('el notifier recibe deadlineAt y deadlineMs coherentes con lastActionAt');
      } else {
        bad('el aviso no lleva el deadline esperado', JSON.stringify(aviso));
      }
      if (aviso.telegramId === Number(asiento.playerId) && aviso.cards.length === 2) {
        ok('el aviso identifica al humano y lleva solo sus cartas');
      } else {
        bad('el aviso no identifica al humano o no lleva sus cartas', JSON.stringify(aviso));
      }
    } else {
      bad(`se enviaron ${avisos.length} avisos en vez de uno`);
    }

    // No repetir el mismo turno: la deduplicacion es parte de la entrega.
    manager.notifyHumanTurn(mesa, asiento);
    if (avisos.length === 1) ok('el mismo turno no genera un segundo aviso');
    else bad(`el mismo turno se notificó ${avisos.length} veces`);

    manager.stop();
  }

  section('2. El timeout ejecuta una accion real y cierra la mano');
  {
    const engine = new PokerGame('mesa-timer-2', 5, 10, 2);
    engine.addPlayer('0', 'Ana', 1000);
    engine.addPlayer('1', 'Luis', 1000);
    assert(engine.startGame(0), 'la mano no arrancó');

    const mesa = crearMesa(engine);
    mesa.tableId = 'mesa-timer-2';
    const manager = new TableManager();
    manager.engines.set(mesa.tableId, { engine, handSeed: 2 });

    const estadoAntes = engine.getState();
    const actorIndex = estadoAntes.currentPlayerIndex;
    const actorAntes = estadoAntes.players[actorIndex];
    const toCallAntes = Math.max(0, estadoAntes.currentBet - actorAntes.bet);

    // El turno lleva vencido mas de un turno completo.
    mesa.hand.lastActionAt = new Date(Date.now() - TURN_TIMER.humanMs - 5_000);

    await manager.checkTurnTimeout(mesa);
    await dormir(30); // finishHand se dispara desde scheduleTurn

    const estadoDespues = engine.getState();
    const actorDespues = estadoDespues.players.find((p) => p.id === actorAntes.id);
    const accion = estadoDespues.lastAction;

    if (accion && accion.playerId === actorAntes.id &&
        (accion.action === 'fold' || accion.action === 'check')) {
      ok(`el timeout jugó ${accion.action} por el asiento ${actorAntes.id}`);
    } else {
      bad('el timeout no ejecutó una accion en el motor', JSON.stringify(accion));
    }

    if (toCallAntes === 0 ? accion?.action === 'check' : accion?.action === 'fold') {
      ok('con deuda pendiente se retira; sin deuda, pasa');
    } else {
      bad(`accion de timeout incorrecta: debía ${toCallAntes}, hizo ${accion?.action}`);
    }

    if (!manager.engines.has(mesa.tableId)) {
      ok('la mano se cerró y el motor se retiró del mapa');
    } else {
      bad('la mano sigue viva después del timeout');
    }

    if ((mesa.handHistory ?? []).length === 1) {
      ok('el cierre guardó una entrada en el historial');
    } else {
      bad(`historial con ${(mesa.handHistory ?? []).length} entradas, esperaba 1`);
    }

    const entrada = (mesa.handHistory ?? [])[0];
    const mia = entrada?.players?.find((p) => p.seatIndex === Number(actorAntes.id));
    if (mia && mia.cards.length === 2) {
      ok('el historial guarda las cartas privadas del jugador');
    } else {
      bad('el historial no guardó las cartas del jugador', JSON.stringify(entrada?.players));
    }

    const vista = toPublicTable(mesa, Number(actorAntes.id));
    const hist = vista.history?.[0];
    if (hist && hist.myCards.length === 2) {
      ok('la vista del jugador recupera sus propias cartas del historial');
    } else {
      bad('la vista no recupera las cartas propias', JSON.stringify(hist));
    }

    if (hist && JSON.stringify(hist).includes('"players"') === false) {
      ok('la vista no envia la lista interna de cartas privadas');
    } else {
      bad('la vista del historial envía players');
    }

    manager.stop();
  }

  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
