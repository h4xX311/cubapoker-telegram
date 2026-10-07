/**
 * EL FLUJO EXACTO, COMO EL USUARIO REAL.
 *
 * El usuario real es el que entra por Telegram con su ID de verdad. Todo lo que se ha
 * probado hasta ahora usaba `600000001`, que es el usuario de DESARROLLO. El camino del
 * usuario real nunca se habia recorrido entero, y es el unico que importa.
 *
 * Se recorre el camino que hace la pantalla, en orden: sesion -> deposito -> confirmacion ->
 * acreditacion -> sentarse -> ver la mesa -> actuar. Y al final, el saldo.
 *
 * ------------------------------------------------------------------
 * UNA SOLA URL, Y POR QUE IMPORTA
 *
 * El bot sirve la web Y la API en el mismo puerto (3000). Antes se probaba la API en 3000 y
 * la web en 5173 (Vite), y en produccion en Render. Tres sitios distintos, y cada uno con su
 * version del codigo: la API con los arreglos de hoy, la web con el bundle viejo, y Render
 * con todo viejo. Era imposible saber que estabas probando.
 *
 * Ahora todo se sirve desde `localhost:3000` con el codigo de hoy. Si esto pasa, lo que estas
 * viendo en el navegador es exactamente lo mismo. Es la unica forma de que "funciona aqui" y
 * "funciona alla" sean la misma frase.
 */
require('dotenv').config();

const BASE = 'http://localhost:3000';
// El ID real del usuario. Cambiarlo para probar con otro.
const TID = process.argv[2] || '8780669267';
const H = { 'x-dev-auth': TID, 'Content-Type': 'application/json' };

async function llamar(metodo, ruta, cuerpo) {
  const res = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: H,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const t = await res.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { _noJson: t.slice(0, 150) }; }
  return { status: res.status, json: j };
}

const p = (n, t) => console.log(`\n\x1b[36m--- ${n}. ${t}\x1b[0m`);
const ok = (c) => (c ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFALLA\x1b[0m');

(async () => {
  console.log(`\x1b[1mFLUJO DEL USUARIO REAL ${TID}\x1b[0m`);

  p(1, 'Sesion');
  let r = await llamar('GET', '/api/me');
  if (r.json?._noJson) { console.log(`  \x1b[31mNO ES JSON\x1b[0m`); process.exit(1); }
  let saldo = r.json?.user?.balance?.total ?? 0;
  console.log(`  saldo: ${saldo}`);

  p(2, 'Depositar 5 USDT');
  r = await llamar('POST', '/api/payment/deposit/order', { amount: 5, provider: 'usdt', chain: 'TRC20' });
  console.log(`  estado ${r.status} ${ok(r.status < 300)} ${JSON.stringify(r.json).slice(0, 150)}`);
  const oid = r.json?.orderId;
  if (!oid) { console.log('  SIN ORDEN: aqui se rompe el flujo.'); process.exit(1); }

  p(3, 'Confirmar (el "banco" confirma)');
  r = await llamar('POST', `/api/payment/simulate/${oid}/confirm`, {});
  console.log(`  estado ${r.status} ${ok(r.status < 300)}`);

  p(4, 'Acreditar');
  r = await llamar('POST', '/api/payment/deposit/confirm', { orderId: oid });
  console.log(`  estado ${r.status} ${ok(r.status < 300)} ${JSON.stringify(r.json).slice(0, 140)}`);

  p(5, 'Saldo tras el deposito');
  r = await llamar('GET', '/api/me');
  saldo = r.json?.user?.balance?.total ?? 0;
  console.log(`  saldo: ${saldo} (${(saldo / 1000).toFixed(3)} USDT) ${ok(saldo > 0)}`);

  p(6, 'Sentarse en una mesa (Jugar ahora)');
  r = await llamar('POST', '/api/game/sit', { tierId: 't1' });
  console.log(`  estado ${r.status} ${ok(r.status < 300)} ${JSON.stringify(r.json).slice(0, 150)}`);
  const tid = r.json?.tableId;
  if (!tid) { console.log('  NO SE SENTO.'); process.exit(1); }

  p(7, 'Ver la mesa');
  r = await llamar('GET', `/api/game/view/${tid}`);
  const st = r.json?.state;
  console.log(`  fase=${st?.hand?.phase} bote=${st?.hand?.pot} ocupados=${st?.occupied} bots=${st?.bots}`);
  console.log(`  cartas=${(st?.myCards ?? []).length} miTurno=${st?.isMyTurn}`);

  // Si me toca, juego. Fold es siempre legal y no arriesga.
  if (st?.isMyTurn) {
    p(8, 'Actuar (fold)');
    r = await llamar('POST', '/api/game/action', { tableId: tid, action: 'fold' });
    console.log(`  estado ${r.status} ${ok(r.status < 300)} ${JSON.stringify(r.json).slice(0, 100)}`);
    console.log(`  (nota: el backend devuelve "state"? ${r.json?.state ? 'SI' : 'NO'})`);
  } else {
    p(8, 'Turno');
    console.log(`  no es mi turno todavia (hay bots jugando). Turno actual: ${JSON.stringify(st?.hand?.currentPlayerId)}`);
  }

  console.log(`\n${'='.repeat(48)}`);
  console.log(`FINAL: saldo ${saldo} · mesa ${tid}`);
  console.log('='.repeat(48));
  process.exit(0);
})().catch((e) => { console.error('FALLO TOTAL:', e); process.exit(1); });