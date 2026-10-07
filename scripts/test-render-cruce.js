/**
 * CRUCE: LO QUE EL RENDER USA CONTRA LO QUE LA API MANDA.
 *
 * Un fallo de render casi siempre es un campo que llega `undefined` donde el codigo hace
 * `.map()`, `.toFixed()` o `.length`. Sin esto no hay forma de saberlo: la pantalla queda
 * en blanco y los cuatro motivos posibles se ven igual.
 *
 * Este script se sienta de verdad, pide la vista de verdad, y compara los dos lados.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

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
  const t = await res.text();
  try {
    return { status: res.status, json: JSON.parse(t) };
  } catch {
    return { status: res.status, json: { _crudo: t.slice(0, 120) } };
  }
}

// Lee los campos que Table.tsx le pide a la vista.
function camposQueUsaElRender() {
  const f = path.join(__dirname, '..', 'mini-app', 'src', 'pages', 'Table.tsx');
  const src = fs.readFileSync(f, 'utf8');
  const usados = new Set();
  for (const m of src.matchAll(/view\.([A-Za-z_][A-Za-z0-9_]*)/g)) usados.add(m[1]);
  for (const m of src.matchAll(/view\.hand\.([A-Za-z_][A-Za-z0-9_]*)/g)) usados.add('hand.' + m[1]);
  return usados;
}

function faltaValor(v) {
  return v === undefined || v === null;
}

(async () => {
  console.log('=== fondo ===');
  let r = await pedir('GET', '/api/me');
  const saldo = r.json?.user?.balance?.total ?? 0;
  console.log(`saldo: ${saldo}`);
  if (saldo < 1000) {
    r = await pedir('POST', '/api/payment/deposit/order', { amount: 5, provider: 'usdt', chain: 'TRC20' });
    const oid = r.json?.orderId;
    if (oid) await pedir('POST', `/api/payment/simulate/${oid}/confirm`, {});
    r = await pedir('GET', '/api/me');
    console.log(`tras deposito: ${r.json?.user?.balance?.total ?? 0}`);
  }

  r = await pedir('GET', '/api/game/my-table');
  if (r.json?.tableId) {
    console.log(`sentado en ${r.json.tableId}: se levanta`);
    await pedir('POST', '/api/game/stand', { tableId: r.json.tableId });
  }

  r = await pedir('POST', '/api/game/sit', { tierId: 't1' });
  const tableId = r.json?.tableId;
  console.log(`sentado: ${tableId} (status ${r.status})`);
  if (!tableId) { console.log(JSON.stringify(r.json)); process.exit(1); }

  // Se espera a que haya mano en curso, que es cuando la vista tiene contenido.
  let vista = null;
  for (let i = 0; i < 25; i++) {
    await dormir(500);
    r = await pedir('GET', `/api/game/view/${tableId}`);
    vista = r.json?.state;
    if (vista && vista.hand && vista.hand.phase !== 'idle') break;
  }

  console.log(`\nfase=${vista?.hand?.phase}  spectator=${r.json?.spectator}`);
  console.log(`claves de la vista: ${Object.keys(vista ?? {}).sort().join(', ')}`);

  const usados = camposQueUsaElRender();
  const faltan = [];
  const hay = [];
  for (const campo of usados) {
    const valor = campo.includes('.')
      ? (vista?.[campo.split('.')[0]] ?? {})[campo.split('.')[1]]
      : vista?.[campo];
    if (faltaValor(valor)) faltan.push(campo);
    else hay.push(campo);
  }

  console.log(`\n=== LO QUE EL RENDER USA (${usados.size} campos) ===`);
  console.log(`presentes (${hay.length}): ${hay.sort().join(', ')}`);
  console.log(`\n!!! FALTAN O SON NULL (${faltan.length}): ${faltan.sort().join(', ')}`);
  if (faltan.length === 0) {
    console.log('\nTodos los campos que usa el render llegan. El fallo, si lo hay, es otro.');
  }

  // Ahora lo que mas revienta: un array vacio donde se hace .map, o un numero en null.
  console.log(`\n=== TIPOS DE LO QUE SE USA EN UN .map O .toFixed ===`);
  for (const campo of usados) {
    const v = campo.includes('.')
      ? (vista?.[campo.split('.')[0]] ?? {})[campo.split('.')[1]]
      : vista?.[campo];
    if (Array.isArray(v)) console.log(`  ${campo}: array de ${v.length}`);
    else if (typeof v === 'number') console.log(`  ${campo}: numero ${v}`);
    else console.log(`  ${campo}: ${typeof v}`);
  }

  process.exit(0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });