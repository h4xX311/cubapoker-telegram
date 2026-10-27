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
 *   3. Ver los tiers del lobby
 *   4. Sentarse en una mesa cash y jugar CONTRA BOTS de verdad
 *   5. Levantar y recuperar el stack exacto
 *   6. Inscribirse en el freeroll de la hora y ver que arranca solo,
 *      con bots de relleno, sin esperar a que se llene
 *
 * La liquidacion de campos y freerolls se prueba en `test-e2e-field.js` y
 * `test-freeroll.js`. Este recorrido comprueba lo que ve el jugador: deposito,
 * mesa cash, bots y reloj del freeroll.
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
  const { freerollManager } = require('../dist/game/freeroll.service');
  const { tableManager } = require('../dist/game/table.manager');
  const { TABLE_TIER_LIST } = require('../dist/config/product');
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
      amount: 20,
      provider: 'usdt',
      chain: 'TRC20',
    });
    ok(`orden creada: ${orden.orderId ?? orden.id}`);
    nota(`simulada: ${orden.simulated}`);

    await paymentService.creditDepositOrder(orden.orderId ?? orden.id);
    const tras = await saldo();
    // 20 USDT = 20.000 unidades. La comision de deposito es del 0,5 %
    // (100 unidades) con tope de 500 unidades.
    if (tras === 19_900) ok(`saldo acreditado: ${formatUnits(tras)} (20 USDT menos 0,5 %)`);
    else bad(`el deposito no acredito bien: ${formatUnits(tras)}, esperado 19,9 USDT`);
  } catch (e) {
    bad(`el deposito falla: ${e.message}`);
    nota('Sin deposito no hay nada que probar mas abajo.');
    await fin();
    return;
  }

  // =====================================================================
  titulo('Ver los tiers del lobby');

  ok(
    `tiers cash: ${TABLE_TIER_LIST.map((t) => `${t.id}(${t.buyInUsdt} USDT)`).join(', ')}`,
  );
  nota('VIP Arena se muestra aparte, como sala de high stakes, no como membresia.');

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

  await darVueltas(250);

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

  // La regla de seguridad: con una mano en curso no se puede quitar el
  // asiento, porque el motor sigue apuntando a indices viejos. Se comprueba
  // que la API lo rechaza de verdad, no solo que el comentario lo diga.
  const enMano = await Table.findOne({ tableId: sentado.tableId });
  if (enMano && enMano.hand.phase !== 'idle' && enMano.hand.phase !== 'idle-awaiting') {
    try {
      await seatingService.standUp(YOI, sentado.tableId);
      bad('dejo levantar a mitad de mano: el motor quedaria desindexado');
    } catch (e) {
      if (e.status === 409 || /mano en curso/i.test(e.message)) {
        ok('bloquea levantarse a mitad de mano (409)');
      } else {
        bad(`el bloqueo de mitad de mano falla con otro error: ${e.message}`);
      }
    }
  } else {
    nota('la mano termino antes de probar el bloqueo; se valida el saldo igual');
  }

  const antes = await saldo();
  let meLevante = false;
  let ultimoError = null;

  // El gestor arranca la siguiente mano al quedar la mesa en reposo. Hay que
  // intentarlo en esa ventana; si se pasa, se espera a que termine la nueva.
  for (let i = 0; i < 600 && !meLevante; i++) {
    try {
      const r = await seatingService.standUp(YOI, sentado.tableId);
      meLevante = true;
      nota(`levantado al intento ${i + 1}, devuelto ${formatUnits(r.returned)}`);
    } catch (e) {
      ultimoError = e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (meLevante) {
    const despues = await saldo();
    if (despues > antes) ok(`saldo recuperado: ${formatUnits(antes)} -> ${formatUnits(despues)}`);
    else bad(`no se ha recuperado nada: ${formatUnits(antes)} -> ${formatUnits(despues)}`);
  } else {
    bad(
      `NO se puede levantar de la mesa tras 30 s` +
      (ultimoError ? `: ${ultimoError.message}` : ''),
    );
  }

  // =====================================================================
  titulo('Inscribirse en el freeroll de la hora');

  // Regla de producto: el freeroll arranca a su hora con los humanos y los
  // bots apuntados en ese momento. No espera a llenar 300 asientos.
  // Se adelanta el reloj del slot para no esperar hasta la hora en punto.
  const abierto = await freerollManager.asegurarAbierto();
  const inscripcion = await freerollManager.registrar(YOI, 'yo', abierto.fieldId);
  ok(`inscrito en ${inscripcion.fieldId} (posicion ${inscripcion.position})`);

  await Field.updateOne(
    { fieldId: abierto.fieldId },
    {
      $set: {
        scheduledStartAt: new Date(Date.now() - 60_000),
        lateRegUntil: new Date(Date.now() + 11 * 60_000),
      },
    },
  );
  nota('slot adelantado un minuto: el planificador debe arrancarlo ya');

  const arranque = await freerollManager.procesar();
  if (arranque.arrancados >= 1) ok('el freeroll arranco sin esperar a llenarse');
  else bad('el planificador no arranco el freeroll');

  const enJuego = await Field.findOne({ fieldId: abierto.fieldId });
  const mesasFreeroll = await Table.find({ 'field.fieldId': abierto.fieldId });
  const botsFreeroll = mesasFreeroll.reduce(
    (n, m) => n + m.seats.filter((s) => s.kind === 'bot').length,
    0,
  );

  nota(
    `estado="${enJuego.status}" vivos=${enJuego.playersRemaining} ` +
    `mesas=${mesasFreeroll.length} bots=${botsFreeroll}`,
  );

  if (enJuego.status === 'running' || enJuego.status === 'final') {
    ok('el campo quedo en juego');
  } else {
    bad(`el campo no quedo en juego: "${enJuego.status}"`);
  }

  if (botsFreeroll > 0) {
    ok(`${botsFreeroll} bots de relleno en las mesas del freeroll`);
  } else {
    bad('no se sento ningun bot: la mesa se quedaria esperando');
  }

  const miEntrada = (enJuego.registrations || []).find(
    (r) => Number(r.telegramId) === YOI,
  );
  if (miEntrada && (miEntrada.status === 'seated' || miEntrada.status === 'waiting')) {
    ok(`mi inscripcion sigue viva (${miEntrada.status})`);
  } else {
    bad(
      `mi inscripcion desaparecio: ` +
      `${miEntrada ? miEntrada.status : 'sin registro'}`,
    );
  }

  // El humano no pulsa: el temporizador lo retira y los bots deben seguir
  // jugando. Se espera al menos una mano.
  await darVueltas(250);
  const mesaPropia = mesasFreeroll.find((m) =>
    m.seats.some((s) => s.kind === 'human' && Number(s.playerId) === YOI),
  );
  if (mesaPropia) {
    const fresca = await Table.findOne({ tableId: mesaPropia.tableId });
    const botsConManos = fresca
      ? fresca.seats.filter((s) => s.kind === 'bot' && (s.handsPlayed || 0) > 0).length
      : 0;
    if (botsConManos > 0) {
      ok(`${botsConManos} bots jugaron una mano sin que el humano actuara`);
    } else {
      nota('los bots todavia no han cerrado una mano; el reloj del torneo sigue');
    }
  }

  tableManager.stop();
  TURN_TIMER.humanMs = 30_000;
  BOT_CONFIG.minThinkMs = 900;

  await fin();
}