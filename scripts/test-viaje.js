/**
 * El camino completo de un usuario, paso a paso.
 *
 * ------------------------------------------------------------------
 * POR QUE
 *
 * Cada bug de verdad de este proyecto ha aparecido al hacer lo que un usuario intenta hacer,
 * no al leer el codigo. Y el ultimo sintoma ("ya estas sentado en otra mesa") era un
 * bucle cerrado que ninguna lectura del codigo habria mostrado.
 *
 * Asi que esto recorre EL RECORRIDO COMPLETO, con los servicios de produccion, en orden, y
 * se para en el primer paso que falla:
 *
 *   1. Abrir la aplicacion y cargar el perfil
 *   2. Depositar (en simulacion, sin tocar la cadena)
 *   3. Ver los campos y los tiers
 *   4. Sentarse en una mesa y jugar CONTRA BOTS de verdad
 *   5. Levantar y recuperar el saldo
 *   6. Registrarse en un campo, llenarlo con bots, y jugar
 *   7. Que el campo reparta el premio al ganador
 *
 * El paso 7 es el que no funciona. Y hasta que funcione, un campo es una promesa sin pago.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_viaje node scripts/test-viaje.js
 */

process.env.DEV_AUTH_BYPASS = 'true';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
process.env.SIMULATE_PAYMENTS = 'true';
process.env.ADMIN_API_KEY = 'clave-de-prueba';

const mongoose = require('mongoose');

let paso = 0;
let fallos = 0;

const titulo = (t) => {
  paso++;
  console.log(`\n\x1b[1m\x1b[36m── PASO ${paso}: ${t}\x1b[0m`);
};
const ok = (m) => console.log(`  \x1b[32m+\x1b[0m ${m}`);
const bad = (m, d) => {
  fallos++;
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d) console.log(`      \x1b[2m${d}\x1b[0m`);
};
const nota = (m) => console.log(`      \x1b[2m${m}\x1b[0m`);

const fin = async () => {
  console.log(
    `\n\x1b[1m${fallos === 0 ? '\x1b[32mEL VIAJE COMPLETO FUNCIONA' : `\x1b[31mEL VIAJE SE ROMPE EN EL PASO ${paso}`}\x1b[0m\n`,
  );
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch { /* nada */ }
  process.exit(fallos === 0 ? 0 : 1);
};

main().catch(async (e) => {
  console.error('\n\x1b[31mEl viaje reviento:\x1b[0m');
  console.error(e && e.stack ? e.stack : e);
  fallos++;
  await fin();
});

const YOI = 600_000_001;

async function main() {
  console.log('\n\x1b[1mCubaPoker · El camino de un usuario, de principio a fin\x1b[0m');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  ok('entorno limpio');

  const { User } = require('../dist/models/User');
  const { Field } = require('../dist/models/Field');
  const { Table } = require('../dist/models/Table');
  const { paymentService } = require('../dist/services/payment/payment.service');
  const { seatingService } = require('../dist/game/seating.service');
  const { fieldManager } = require('../dist/game/field.manager');
  const { tableManager } = require('../dist/game/table.manager');
  const { getTier, TABLE_TIER_LIST } = require('../dist/config/product');
  const { formatUnits } = require('../dist/config/units');
  const { TURN_TIMER, BOT_CONFIG } = require('../dist/config/product');

  TURN_TIMER.humanMs = 50;
  BOT_CONFIG.minThinkMs = 1;
  BOT_CONFIG.maxThinkMs = 5;

  const saldo = async () => (await User.findOne({ telegramId: YOI })).balance.real;

  // =====================================================================
  titulo('Abrir la aplicacion');

  await User.create({
    telegramId: YOI,
    username: 'yo',
    firstName: 'Yo',
    balance: { real: 0, play: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
  });

  ok(`usuario creado con ${formatUnits(await saldo())}`);

  // =====================================================================
  titulo('Depositar');

  try {
    const orden = await paymentService.createDepositOrder({
      telegramId: YOI,
      amount: 20_000,
      provider: 'usdt',
      chain: 'TRC20',
    });
    ok(`orden creada: ${orden.orderId ?? orden.id}`);
    nota(`simulada: ${orden.simulated}`);

    await paymentService.creditDepositOrder(orden.orderId ?? orden.id);
    const tras = await saldo();
    if (tras === 20_000) ok(`saldo acreditado: ${formatUnits(tras)}`);
    else bad(`el deposito no acredito bien: ${formatUnits(tras)}, esperado 20 USDT`);
  } catch (e) {
    bad(`el deposito falla: ${e.message}`);
    nota('Sin deposito no hay nada que probar mas abajo.');
    await fin();
    return;
  }

  // =====================================================================
  titulo('Ver los campos y los tiers');

  const tier = TABLE_TIER_LIST[0];
  ok(`tiers: ${TABLE_TIER_LIST.map((t) => `${t.id}(${t.buyInUsdt} USDT, ${t.fieldSize} jugadores)`).join(', ')}`);
  nota(`campo de un tier: ${tier.fieldSize} participantes. Con poca liquidez, nadie puede entrar.`);

  // =====================================================================
  titulo('Sentarse en una mesa y jugar contra bots');

  const sentado = await seatingService.sitDown({ telegramId: YOI, tierId: 't1' });
  ok(`sentado en ${sentado.tableId}, saldo ${formatUnits(await saldo())}`);

  // SIN ESTO EL CAMPO NO SE COORDINA NUNCA
  tableManager.setFieldCoordinator(() => fieldManager.tick());
  await tableManager.start();

  const darVueltas = async (veces, ms = 12) => {
    for (let i = 0; i < veces; i++) {
      await new Promise((r) => setTimeout(r, ms));
    }
  };

  await darVueltas(60);

  const jugando = await Table.findOne({ tableId: sentado.tableId });
  const mios = jugando.seats.find((s) => s.playerId === String(YOI));
  const bots = jugando.seats.filter((s) => s.kind === 'bot');
  const botsConManos = bots.filter((s) => (s.handsPlayed || 0) > 0);

  nota(`mesa: fase="${jugando.hand.phase}" mano=${jugando.hand.handNumber} bote=${formatUnits(jugando.hand.pot || 0)}`);
  nota(`mis fichas: ${formatUnits(mios ? mios.chips : 0)}   bots: ${bots.length}   bots que han jugado: ${botsConManos.length}`);

  if (botsConManos.length >= 2) ok(`${botsConManos.length} bots jugando en mi mesa`);
  else bad(`solo ${botsConManos.length} bots han jugado`);


  // =====================================================================
  titulo('Levantar y recuperar el saldo');

  const antes = await saldo();
  let meLevante = false;
  for (let i = 0; i < 25 && !meLevante; i++) {
    try {
      const r = await seatingService.standUp(YOI, sentado.tableId);
      meLevante = true;
      nota(`levantado al intento ${i + 1}, devuelto ${formatUnits(r.returned)}`);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  if (meLevante) {
    const despues = await saldo();
    if (despues > antes) ok(`saldo recuperado: ${formatUnits(antes)} -> ${formatUnits(despues)}`);
    else bad(`no se ha recuperado nada: ${formatUnits(antes)} -> ${formatUnits(despues)}`);
  } else {
    bad('NO se puede levantar de la mesa');
  }

  // =====================================================================
  titulo('Entrar en un campo y llenarlo con bots');

  // Un campo pequeño, porque a 300 no llega nadie nunca.
  const OBJETIVO = 8;

  await User.findOneAndUpdate({ telegramId: YOI }, { $set: { 'balance.real': 5_000_000 } });

  const primero = await fieldManager.register(YOI, 't1', 'yo');
  ok(`registrado en ${primero.fieldId} (sala ${primero.position})`);

  const campo = await Field.findOne({ fieldId: primero.fieldId });
  await Field.updateOne(
    { _id: campo._id },
    { $set: { targetField: OBJETIVO } },
  );
  nota(`campo recortado a ${OBJETIVO} para que arranque`);

  const DESDE = 610_000_000;
  for (let i = 0; i < OBJETIVO - 1; i++) {
    const id = DESDE + i;
    await User.findOneAndUpdate(
      { telegramId: id },
      {
        $setOnInsert: {
          telegramId: id,
          username: 'b' + id,
          firstName: 'B' + id,
          balance: { real: 5_000_000, play: 0 },
          stats: {
            handsPlayed: 0, handsWon: 0, tablesJoined: 0,
            freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    try {
      await fieldManager.register(id, 't1', 'b' + id);
    } catch (e) {
      bad(`el bot ${id} no pudo entrar: ${e.message}`);
      break;
    }
  }

  await darVueltas(40);

  const campo2 = await Field.findOne({ fieldId: primero.fieldId });
  nota(`campo: estado="${campo2.status}" sentados=${campo2.seated} vivos=${campo2.playersRemaining} de ${campo2.targetField}`);

  if (campo2.status === 'running' || campo2.status === 'final') {
    ok(`el campo arranco (${campo2.status})`);
  } else {
    bad(`el campo NO ha arrancado: sigue en "${campo2.status}" con ${campo2.seated} de ${campo2.targetField}`);
  }

  // =====================================================================
  titulo('Que el campo reparta el PREMIO');

  // A aqui es donde se pierde. El campo tiene que llegar a un ganador y pagarle.
  nota('dejando correr el campo hasta que termine o se atasque...');

  let termino = false;
  for (let vuelta = 0; vuelta < 260 && !termino; vuelta++) {
    await darVueltas(1, 12);
    const c = await Field.findOne({ fieldId: primero.fieldId });
    if (c.status === 'finished') termino = true;
    if (vuelta % 40 === 0) {
      nota(`  vuelta ${vuelta}: ${c.status} vivos=${c.playersRemaining} eliminados=${c.eliminated}`);
    }
  }

  const final = await Field.findOne({ fieldId: primero.fieldId });

  nota(`estado final: "${final.status}" vivos=${final.playersRemaining} eliminados=${final.eliminated}`);
  nota(`posiciones adjudicadas: ${(final.results || []).length}`);
  nota(`rake registrado: ${formatUnits(final.rakeCollected)}`);
  nota(`bote recogido: ${formatUnits(final.buyInsCollected)}`);

  if (final.status === 'finished') {
    ok('el campo TERMINO');

    const ganador = (final.results || []).find((r) => r.position === 1);
    if (ganador) {
      const g = await User.findOne({ telegramId: ganador.telegramId });
      ok(`ganador ${ganador.telegramId} por la posicion 1, premio ${formatUnits(ganador.amount)}`);
      nota(`su saldo de promocion: ${formatUnits(g.balance.play)}`);
      if (g.balance.play > 0) ok('ha cobrado el premio');
      else bad('el ganador no tiene nada en promocion: no ha cobrado');
    } else {
      bad('el campo termino SIN ganador registrado');
    }

    if (final.rakeCollected > 0) {
      const esperado = Math.floor(final.buyInsCollected * 0.05);
      nota(`rake ${formatUnits(final.rakeCollected)}, el 5 % seria ${formatUnits(esperado)}`);
    } else {
      bad('el campo termino sin cobrar rake');
    }
  } else {
    bad(`EL CAMPO NO TERMINA: se quedo en "${final.status}" con ${final.playersRemaining} vivos`);
    nota(`Y por eso NADIE COBRA. Un Sit'n'Go que no acaba es una promesa sin pago.`);
    nota(`Esperados ${OBJETIVO - 1} posiciones, adjudicadas ${(final.results || []).length}.`);

    const mesas = await Table.find({ 'field.fieldId': primero.fieldId });
    for (const m of mesas) {
      nota(`mesa ${m.tableId}: ${m.status} fase=${m.hand.phase} asientos=${m.seats.length}`);
      for (const s of m.seats) {
        nota(`    asiento ${s.index}: ${s.status} fichas=${s.chips}`);
      }
    }
  }

  tableManager.stop();
  TURN_TIMER.humanMs = 30_000;
  BOT_CONFIG.minThinkMs = 900;

  await fin();
}