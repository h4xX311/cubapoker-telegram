/**
 * Prueba del flujo de pagos en modo simulacion.
 *
 * Ejecuta el recorrido completo sin pasar por Telegram, forzando el middleware
 * de autenticacion, para poder validar la logica de dinero de forma aislada:
 *   crear orden -> confirmar pago -> acreditar saldo -> solicitar retiro
 *
 * Uso:  node scripts/test-payment-flow.js
 * Env:  BASE_URL (default http://localhost:3000)
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.SIMULATION_SECRET || 'cubapoker-dev';

let pass = 0;
let fail = 0;

const ok = (msg) => {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  pass++;
};
const bad = (msg, detail) => {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.log(`      ${detail}`);
  fail++;
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Dev-Auth': process.env.DEV_AUTH_ID || '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  return { status: res.status, data };
}

async function main() {
  console.log('\n\x1b[1mCubaPoker · Prueba del flujo de pagos\x1b[0m');
  console.log(`Servidor: ${BASE}\n`);

  // --- Salud ---
  console.log('\x1b[1m1. Salud del servicio\x1b[0m');
  {
    const { status, data } = await call('GET', '/health');
    if (status === 200) ok(`health: ${data.status} (modo: ${data.paymentMode})`);
    else bad('health no responde', `${status}`);
  }

  // --- Cadenas ---
  console.log('\n\x1b[1m2. Cadenas USDT disponibles\x1b[0m');
  let chains = [];
  {
    const { data } = await call('GET', '/api/payment/chains');
    chains = data?.chains || [];
    const expected = ['TRC20', 'SOL', 'POL', 'BEP20', 'ERC20'];
    const got = chains.map((c) => c.id);
    const missing = expected.filter((e) => !got.includes(e));
    if (missing.length === 0) ok(`5 cadenas disponibles: ${got.join(', ')}`);
    else bad(`faltan cadenas: ${missing.join(', ')}`);
  }

  // --- Autenticación ---
  console.log('\n\x1b[1m3. Seguridad\x1b[0m');
  {
    const res = await fetch(`${BASE}/api/me`);
    if (res.status === 401) ok('endpoint protegido rechaza sin firma');
    else bad('endpoint protegido ACEPTÓ petición sin firma', `status ${res.status}`);
  }

  // --- Validaciones ---
  console.log('\n\x1b[1m4. Validaciones de entrada\x1b[0m');
  {
    const { status } = await call('POST', '/api/payment/deposit/order', { amount: -100, provider: 'usdt' });
    if (status === 400) ok('rechaza monto negativo');
    else bad('aceptó monto negativo', `status ${status}`);
  }
  {
    const { status } = await call('POST', '/api/payment/deposit/order', { amount: 1, provider: 'bitcoin' });
    if (status === 400) ok('rechaza método de pago desconocido');
    else bad('aceptó método desconocido', `status ${status}`);
  }
  {
    const { status } = await call('POST', '/api/payment/deposit/order', { amount: 10, provider: 'usdt', chain: 'FAKE' });
    if (status === 400) ok('rechaza red no soportada');
    else bad('aceptó red inexistente', `status ${status}`);
  }
  {
    const { status } = await call('POST', '/api/payment/withdraw', {
      amount: 10, provider: 'usdt', chain: 'SOL', walletAddress: 'direccion_invalida',
    });
    if (status === 400) ok('rechaza dirección Solana inválida');
    else bad('aceptó dirección inválida', `status ${status}`);
  }

  // --- Flujo de depósito ---
  console.log('\n\x1b[1m5. Flujo de depósito (TRC20)\x1b[0m');
  let orderId = null;
  {
    const { status, data } = await call('POST', '/api/payment/deposit/order', {
      amount: 1000, provider: 'usdt', chain: 'TRC20',
    });
    if (status === 200 && data?.orderId) {
      orderId = data.orderId;
      ok(`orden creada: ${orderId.slice(0, 8)}… (${data.amount} USDT)`);
      if (data.instructions?.direccion) ok(`dirección de depósito: ${data.instructions.direccion.slice(0, 20)}…`);
      else bad('sin dirección de depósito');
    } else {
      bad('no se pudo crear la orden', JSON.stringify(data));
    }
  }

  // Saldo no debe cambiar aun
  {
    const { data } = await call('GET', '/api/me');
    if ((data?.user?.balance?.credits ?? 0) === 0) ok('saldo sigue en 0 antes de confirmar (correcto)');
    else bad('el saldo cambió sin confirmar pago', `saldo: ${data?.user?.balance?.credits}`);
  }

  // Confirmar via simulador
  if (orderId) {
    const { status, data } = await call('POST', `/api/payment/simulate/${orderId}/confirm`, { secret: SECRET });
    if (status === 200) ok('pasarela simulada confirmó el pago');
    else bad('falló la confirmación simulada', JSON.stringify(data));
  }

  // Acreditar
  if (orderId) {
    const { status, data } = await call('POST', '/api/payment/deposit/confirm', { orderId });
    if (status === 200 && !data?.alreadyCredited) {
      ok(`saldo acreditado: +${data.credited} USDT (comisión ${data.commission})`);
      const expected = 1000 - Math.floor(1000 * 0.005);
      if (data.credited === expected) ok(`comisión USDT correcta (0.5% = ${1000 - expected})`);
      else bad(`comisión incorrecta: esperaba ${expected}, obtuvo ${data.credited}`);
    } else {
      bad('no se acreditó el saldo', JSON.stringify(data));
    }
  }

  // Idempotencia
  if (orderId) {
    const { data } = await call('POST', '/api/payment/deposit/confirm', { orderId });
    if (data?.alreadyCredited) ok('doble confirmación no duplica el crédito (idempotente)');
    else bad('riesgo de doble crédito', JSON.stringify(data));
  }

  // --- Retiros ---
  console.log('\n\x1b[1m6. Flujo de retiro\x1b[0m');
  {
    const { status, data } = await call('POST', '/api/payment/withdraw', {
      amount: 999999, provider: 'usdt', chain: 'TRC20', walletAddress: 'T' + 'a'.repeat(33),
    });
    if (status === 400) ok('rechaza retiro mayor al saldo');
    else bad('permitió retiro sin saldo', `status ${status} ${JSON.stringify(data)}`);
  }

  // --- Resultado ---
  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\nError ejecutando la prueba:', e.message);
  console.error('¿El servidor está corriendo? node dist/bot.js');
  process.exit(1);
});
