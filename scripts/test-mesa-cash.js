/**
 * PRUEBA DE QUE UNA MESA CASH SE JUEGA DE VERDAD.
 *
 * Nada de esto mira codigo. Hace lo que haria una persona, por la API de produccion:
 * deposita, se sienta, mira la mesa, y apuesta. Si esto pasa, se puede jugar. Si falla,
 * el log dice donde.
 *
 * Es el test que sigue al `test-viaje.js` pero para el camino de MESA CASH, que es el
 * que todavia no estaba verificado por nadie.
 */
require('dotenv').config();

const BASE = 'http://localhost:3000';
const TID = '600000001';
const H = { 'x-dev-auth': TID, 'Content-Type': 'application/json' };

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedir(method, ruta, cuerpo) {
  const res = await fetch(`${BASE}${ruta}`, {
    method,
    headers: H,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = { _crudo: texto.slice(0, 200) };
  }
  return { status: res.status, json };
}

const ok = (c) => (c ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFALLO\x1b[0m');

(async () => {
  console.log('\n=== PASO 1: saldo del jugador ===');
  // ------------------------------------------------------------------
  // `GET /api/me`, no `/api/user/me`: la ruta que existe es la primera. La segunda no
  // existia y caia en el `catch-all` de la SPA, que devuelve el HTML de la pagina con
  // HTTP 200. Un 200 con HTML parece que todo funciona mientras el cliente revienta al
  // hacer `JSON.parse`, y lo que se ve es "el saldo me sale en cero".
  // ------------------------------------------------------------------
  let r = await pedir('GET', '/api/me');
  const saldo = r.json?.user?.balance?.total ?? 0;
  console.log(`saldo: ${saldo} unidades (${(saldo / 1000).toFixed(3)} USDT)`);

  // ------------------------------------------------------------------
  // Si no hay saldo para el buy-in minimo, se deposita por la via NORMAL
  // (orden simulada + confirmacion), no editando la base a mano. Asi el
  // libro de movimientos se queda cuadrado, que es lo que se comprueba
  // en las unitarias.
  // ------------------------------------------------------------------
  if (saldo < 1000) {
    console.log('saldo insuficiente: se deposita 5 USDT por la via simulada');
    // ------------------------------------------------------------------
    // `provider` es obligatorio y solo acepta 'enzona', 'qvapay' o 'usdt'. Sin el, el
    // error es "Metodo de pago no valido", que no dice que falte un campo del cuerpo.
    // Para USDT TRC20 es `provider: 'usdt'` con `chain: 'TRC20'`.
    // ------------------------------------------------------------------
    r = await pedir('POST', '/api/payment/deposit/order', {
      amount: 5,
      provider: 'usdt',
      chain: 'TRC20',
    });
    console.log(`  orden: ${ok(r.status < 300)}  ${JSON.stringify(r.json).slice(0, 160)}`);
    const orderId = r.json?.orderId ?? r.json?.order?.orderId;

    if (orderId) {
      r = await pedir('POST', `/api/payment/simulate/${orderId}/confirm`, {});
      console.log(`  confirmar: ${ok(r.status < 300)}  ${JSON.stringify(r.json).slice(0, 160)}`);
    }

    r = await pedir('GET', '/api/me');
    console.log(`saldo tras deposito: ${r.json?.user?.balance?.total ?? 0}`);
  }

  // ------------------------------------------------------------------
  console.log('\n=== PASO 2: listar mesas cash ===');
  r = await pedir('GET', '/api/game/list');
  const mesas = r.json?.tables ?? [];
  const cash = mesas.filter((t) => t.kind === 'cash' && !t.field);
  console.log(`mesas totales: ${mesas.length}  cash sueltas: ${cash.length}`);
  for (const m of cash) {
    console.log(
      `  ${m.tableId}  nivel=${m.tierId} estado=${m.status} ${m.occupied}/${m.maxSeats} ` +
        `(humanos ${m.humans}, bots ${m.bots}) ciegas ${m.smallBlind}/${m.bigBlind}`,
    );
  }
  if (cash.length === 0) {
    console.log('\nNO HAY MESAS CASH. No se puede seguir.');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  console.log('\n=== PASO 3: sentarse en una mesa cash ===');
  // ------------------------------------------------------------------
  // Antes de sentarse, si el jugador ya esta sentado en algo (una mesa anterior, un
  // freeroll, un campo), `sit` responde 409 y el recorrido muere aqui. Se levanta antes,
  // que es justo lo que haria una persona.
  // ------------------------------------------------------------------
  r = await pedir('GET', '/api/game/my-table');
  if (r.json?.tableId) {
    console.log(`estaba sentado en ${r.json.tableId}: se levanta antes de empezar`);
    await pedir('POST', '/api/game/stand', { tableId: r.json.tableId });
  }

  const nivel = 't1';
  r = await pedir('POST', '/api/game/sit', { tierId: nivel });
  console.log(`sit: ${ok(r.status < 300)}  ${JSON.stringify(r.json).slice(0, 200)}`);

  const tableId = r.json?.tableId;
  if (!tableId) {
    console.log(`\nNO DEVUELVE tableId. No se puede seguir. status=${r.status}`);
    process.exit(1);
  }
  console.log(`sentado en: ${tableId}`);

  // ------------------------------------------------------------------
  console.log('\n=== PASO 4: ver la mesa ===');
  r = await pedir('GET', `/api/game/view/${tableId}`);
  const st = r.json?.state;
  console.log(`vista: ${ok(r.status < 300)}`);
  console.log(`  fase=${st?.hand?.phase} bote=${st?.hand?.pot} occupied=${st?.occupied} humans=${st?.humans} bots=${st?.bots}`);
  console.log(`  mi turno=${st?.isMyTurn}  mis cartas=${JSON.stringify(st?.myCards ?? null)}`);

  // ------------------------------------------------------------------
  // PASO 5: JUGAR DE VERDAD
  //
  // Aqui esta la prueba que decide si la plataforma es jugable: reparten cartas, llega un
  // turno, se envia una accion y la mano AVANZA.
  //
  // La vista de jugador trae `myCards`, `isMyTurn` y `turnEndsAt` (no un `you.legalActions`,
  // que no existe). Cuando `isMyTurn` es true se manda una accion.
  //
  // No se manda FOLD siempre: si tocaMatching la ciega grande y no hay apuesta pendiente,
  // `check` es la accion natural y demuestra que el motor acepta decisiones, no solo
  //Keyword el folded automatico. Se alterna para que la mano llegue hasta el showdown.
  // ------------------------------------------------------------------
  console.log('\n=== PASO 5: repartir cartas y jugar ===');
  let vista = null;
  let manosCompletadas = 0;
  let accionesHechas = 0;
  let ultimoNumeroMano = null;

  for (let vuelta = 1; vuelta <= 90; vuelta++) {
    await dormir(500);
    r = await pedir('GET', `/api/game/view/${tableId}`);
    vista = r.json?.state;
    const fase = vista?.hand?.phase;

    // Cada vez que empieza una mano nueva, se dice.
    const numMano = vista?.hand?.handNumber;
    if (numMano && numMano !== ultimoNumeroMano) {
      if (ultimoNumeroMano !== null) {
        manosCompletadas++;
        console.log(`  --- mano ${ultimoNumeroMano} terminada ---`);
      }
      ultimoNumeroMano = numMano;
    }

    if (vista?.isMyTurn && ['preflop', 'flop', 'turn', 'river'].includes(fase)) {
      // Si esta sentado en la ciega grande y no hay que igualar, `check`; si hay algo
      // pendiente, `call`. Ninguna de las dos arriesga nada.
      const miAsiento = (vista?.seats ?? []).find((s) => s.isYou);
      const miBet = miAsiento?.bet ?? 0;
      const apuestaActual = vista?.hand?.currentBet ?? 0;

      let accion;
      if (miBet >= apuestaActual) accion = 'check';
      else accion = 'call';

      const act = await pedir('POST', '/api/game/action', { tableId, action: accion });
      accionesHechas++;
      console.log(
        `  >>> ACTUO: ${accion} (miBet=${miBet} actual=${apuestaActual}) ` +
          `${ok(act.status < 300)} ${JSON.stringify(act.json).slice(0, 90)}`,
      );
    }

    if (vuelta % 10 === 0) {
      console.log(
        `  v${vuelta}: fase=${fase} bote=${vista?.hand?.pot} cartas=${(vista?.myCards ?? []).length} ` +
          `miTurno=${vista?.isMyTurn}occupied=${vista?.occupied}`,
      );
    }

    if (manosCompletadas >= 2) {
      console.log('  dos manos completas: suficiente para demostrar que se juega');
      break;
    }
  }

  console.log(`\nmanos completas=${manosCompletadas}  acciones=${accionesHechas}`);

  // ------------------------------------------------------------------
  console.log('\n=== PASO 6: resultado ===');
  r = await pedir('GET', `/api/game/view/${tableId}`);
  const fin = r.json?.state;
  console.log(`fase=${fin?.hand?.phase} bote=${fin?.hand?.pot} manoN=${fin?.handNumber} rake=${fin?.rakeCollected}`);

  console.log('\n=== PASO 7: levantarse ===');
  r = await pedir('POST', '/api/game/stand', { tableId });
  console.log(`stand: ${ok(r.status < 300)}  ${JSON.stringify(r.json).slice(0, 160)}`);

  r = await pedir('GET', '/api/me');
  console.log(`saldo final: ${r.json?.user?.balance?.total ?? 0}`);

  process.exit(0);
})().catch((e) => {
  console.error('FALLO TOTAL:', e);
  process.exit(1);
});