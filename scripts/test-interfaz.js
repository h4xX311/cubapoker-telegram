/**
 * RECORRIDO EXACTO DE LA INTERFAZ, PASO A PASO.
 *
 * No prueba codigo: reproduce las llamadas que hace la Mini App, en el mismo orden, con los
 * mismos cuerpos. Si esta pantalla falla, el recorrido falla aqui y al reves.
 *
 * La diferencia con `test-viaje.js` es que este va por la MONEDA y el SALDO: deposita, mira
 * que se acredite, se sienta y comprueba que se puede jugar.
 */
require('dotenv').config();

const BASE = 'http://localhost:3000';
const H = { 'x-dev-auth': '600000001', 'Content-Type': 'application/json' };

async function llamar(metodo, ruta, cuerpo) {
  const res = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: H,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const t = await res.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { _noEsJson: t.slice(0, 120) }; }
  return { status: res.status, json: j };
}

const paso = (n, t) => console.log(`\n\x1b[36m--- PASO ${n}: ${t}\x1b[0m`);
const ok = (c) => (c ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFALLA\x1b[0m');

(async () => {
  // ------------------------------------------------------------------
  paso(1, 'La pantalla de arranque pide la sesion');
  let r = await llamar('GET', '/api/me');
  console.log(`  estado ${r.status} ${ok(r.status === 200)}`);
  if (r.json?._noEsJson) {
    console.log(`  \x1b[31mNO ES JSON: ${r.json._noEsJson}\x1b[0m`);
    console.log('  (eso es el fallo de /api/me: llega HTML donde deberia llegar el saldo)');
    process.exit(1);
  }
  const saldo0 = r.json?.user?.balance?.total ?? 0;
  console.log(`  saldo: ${saldo0} unidades (${(saldo0 / 1000).toFixed(3)} USDT)`);

  // ------------------------------------------------------------------
  paso(2, 'El jugador elige 5 USDT y pulsa Depositar');
  r = await llamar('POST', '/api/payment/deposit/order', {
    amount: 5, provider: 'usdt', chain: 'TRC20',
  });
  console.log(`  estado ${r.status} ${ok(r.status < 300)}`);
  console.log(`  ${JSON.stringify(r.json).slice(0, 220)}`);

  const orderId = r.json?.orderId;
  if (!orderId) {
    console.log('\n  NO HAY ORDEN. No se puede seguir: la pantalla se queda aqui.');
    process.exit(1);
  }
  const ordenCreada = r.json;
  console.log(`  importe declarado en la orden: ${ordenCreada.amount} ${ordenCreada.currency}`);
  console.log(`  checkoutUrl: ${ordenCreada.checkoutUrl?.slice(0, 80)}`);

  // ------------------------------------------------------------------
  paso(3, 'La pantalla de pago simulado confirma ("el banco confirma")');
  r = await llamar('POST', `/api/payment/simulate/${orderId}/confirm`, {});
  console.log(`  estado ${r.status} ${ok(r.status < 300)}`);
  console.log(`  ${JSON.stringify(r.json).slice(0, 220)}`);

  // ------------------------------------------------------------------
  paso(4, 'La pantalla acredita el saldo ("la app acredita al detectar la orden pagada")');
  r = await llamar('POST', '/api/payment/deposit/confirm', { orderId });
  console.log(`  estado ${r.status} ${ok(r.status < 300)}`);
  console.log(`  ${JSON.stringify(r.json).slice(0, 260)}`);

  // ------------------------------------------------------------------
  paso(5, 'Comprobar que el saldo se ha acreditado de verdad');
  r = await llamar('GET', '/api/me');
  const saldo1 = r.json?.user?.balance?.total ?? 0;
  const subido = saldo1 - saldo0;
  console.log(`  saldo antes: ${saldo0} · despues: ${saldo1} · subido: ${subido}`);
  console.log(`  subiu algo: ${ok(subido > 0)}`);
  console.log(`  esperado ~4975 unidades (5 USDT menos 0,5 %)`);
  if (subido <= 0) {
    console.log('\n  \x1b[31mEL DEPOSITO NO ACREDITO NADA. Ese es el "no me cobra".\x1b[0m');
  } else if (subido !== 4975) {
    console.log(`  \x1b[33msube ${subido}, no 4975: hay una diferencia de ${4975 - subido}\x1b[0m`);
  }

  // ------------------------------------------------------------------
  paso(6, 'El jugador entra a la mesa "Jugar ahora"');
  r = await llamar('POST', '/api/game/sit', { tierId: 't1' });
  console.log(`  estado ${r.status} ${ok(r.status < 300)}`);
  console.log(`  ${JSON.stringify(r.json).slice(0, 220)}`);
  const tableId = r.json?.tableId;
  if (!tableId) {
    console.log('\n  NO SE SENTO. No se puede jugar.');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  paso(7, 'La pantalla de mesa pide la vista');
  r = await llamar('GET', `/api/game/view/${tableId}`);
  const st = r.json?.state;
  console.log(`  estado ${r.status} ${ok(r.status < 300)}`);
  console.log(`  spectator=${r.json?.spectator} fase=${st?.hand?.phase} bote=${st?.hand?.pot}`);
  console.log(`  ocupados=${st?.occupied} humanos=${st?.humans} bots=${st?.bots}`);
  console.log(`  mis cartas=${JSON.stringify(st?.myCards ?? null)} miTurno=${st?.isMyTurn}`);
  console.log(` ，保证 que hay una pantalla que pintar: seats=${Array.isArray(st?.seats) ? st.seats.length : 'NO ES ARRAY'}`);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RECORRIDO: saldo ${saldo0} -> ${saldo1} · mesa ${tableId}`);
  console.log('='.repeat(50));

  process.exit(0);
})().catch((e) => {
  console.error('FALLO TOTAL:', e);
  process.exit(1);
});