/**
 * Pruebas de la logica pura: cadenas, validacion de direcciones y comisiones.
 * No requieren base de datos ni servidor, asi que corren en cualquier entorno.
 *
 * Uso: node scripts/test-chains.js
 */

const { CHAINS, CHAIN_LIST, validateAddress, toAtomic, fromAtomic } = require('../dist/config/chains');
const { calculateCommission } = require('../dist/config/monetization');

let pass = 0;
let fail = 0;

const ok = (msg) => { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; };
const bad = (msg, detail) => {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.log(`      ${detail}`);
  fail++;
};

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mCubaPoker · Pruebas de cadenas y comisiones\x1b[0m');

section('1. Catálogo de cadenas');
{
  const expected = ['TRC20', 'SOL', 'POL', 'BEP20', 'ERC20'];
  const got = CHAIN_LIST.map(c => c.id);
  const missing = expected.filter(e => !got.includes(e));
  if (!missing.length) ok(`5 cadenas: ${got.join(', ')}`);
  else bad(`faltan: ${missing.join(', ')}`);

  const unique = new Set(got).size === got.length;
  if (unique) ok('sin duplicados');
  else bad('hay cadenas duplicadas');
}

section('2. Validación de direcciones por familia');
{
  // --- Acepta lo que debe ---
  if (validateAddress('TRC20', 'T' + 'a'.repeat(33))) ok('TRC20 acepta dirección válida (T + 33 chars)');
  else bad('TRC20 rechaza dirección válida');

  const evm = '0x' + 'a1b2c3d4'.repeat(5);
  for (const chain of ['ERC20', 'BEP20', 'POL']) {
    if (validateAddress(chain, evm)) ok(`${chain} acepta dirección EVM (0x + 40 hex)`);
    else bad(`${chain} rechaza dirección EVM válida`);
  }

  if (validateAddress('SOL', 'So11111111111111111111111111111111111111112')) ok('SOL acepta dirección Base58');
  else bad('SOL rechaza dirección Base58 válida');

  // --- Rechaza lo que no debe ---
  if (!validateAddress('TRC20', 'a'.repeat(34))) ok('TRC20 rechaza dirección sin prefijo T');
  else bad('TRC20 acepta dirección sin prefijo T');

  if (!validateAddress('TRC20', '0x' + 'a'.repeat(40))) ok('TRC20 rechaza dirección EVM');
  else bad('TRC20 acepta una dirección EVM');

  if (!validateAddress('ERC20', '0x123')) ok('ERC20 rechaza dirección corta');
  else bad('ERC20 acepta dirección demasiado corta');

  if (!validateAddress('ERC20', evm.replace('0x', ''))) ok('ERC20 rechaza dirección sin 0x');
  else bad('ERC20 acepta dirección sin 0x');

  if (!validateAddress('ERC20', '0x' + 'z'.repeat(40))) ok('ERC20 rechaza hex no válido');
  else bad('ERC20 acepta caracteres no hex');

  if (!validateAddress('SOL', '0x' + 'a'.repeat(40))) ok('SOL rechaza dirección EVM');
  else bad('SOL acepta una dirección EVM');

  // 0, O, I, l no existen en Base58: es la trampa clásica de copiar-pegar
  if (!validateAddress('SOL', '0OIl' + 'a'.repeat(30))) ok('SOL rechaza caracteres prohibidos en Base58');
  else bad('SOL acepta 0/O/I/l, que no son Base58');

  if (!validateAddress('SOL', 'a'.repeat(31))) ok('SOL rechaza dirección demasiado corta');
  else bad('SOL acepta dirección corta');

  // La cadena equivocada es el error que cuesta dinero
  if (!validateAddress('SOL', 'T' + 'a'.repeat(33))) ok('SOL rechaza dirección de Tron');
  else bad('SOL acepta una dirección de Tron');

  if (!validateAddress('POL', 'T' + 'a'.repeat(33))) ok('POL rechaza dirección de Tron');
  else bad('POL acepta una dirección de Tron');
}

section('3. Decimales por cadena');
{
  // BEP20 usa 18 decimales, el resto 6. Confundirlo = perdida de fondos.
  if (CHAINS.BEP20.decimals === 18) ok('BEP20 usa 18 decimales');
  else bad(`BEP20 debería usar 18 decimales, usa ${CHAINS.BEP20.decimals}`);

  for (const c of ['TRC20', 'ERC20', 'POL', 'SOL']) {
    if (CHAINS[c].decimals === 6) ok(`${c} usa 6 decimales`);
    else bad(`${c} debería usar 6 decimales, usa ${CHAINS[c].decimals}`);
  }

  const atomic = toAtomic(1, 'BEP20');
  if (atomic === 1000000000000000000n) ok('1 USDT en BEP20 = 10^18 unidades');
  else bad(`conversión BEP20 incorrecta: ${atomic}`);

  const atomic6 = toAtomic(1, 'TRC20');
  if (atomic6 === 1000000n) ok('1 USDT en TRC20 = 10^6 unidades');
  else bad(`conversión TRC20 incorrecta: ${atomic6}`);

  if (fromAtomic(1234567n, 'TRC20') === 1.234567) ok('fromAtomic reconstruye el decimal');
  else bad('fromAtomic incorrecto');
}

section('4. Comisiones');
{
  // La tasa se aplica sobre el monto, pero con suelo y techo.
  // Caso donde la tasa manda (por encima del minimo):
  if (calculateCommission(5000, 'deposit', 'usdt') === 25) ok('depósito USDT: 0.5% de 5000 = 25');
  else bad(`depósito USDT incorrecto: ${calculateCommission(5000, 'deposit', 'usdt')}`);

  if (calculateCommission(5000, 'deposit', 'enzona') === 75) ok('depósito EnZona: 1.5% de 5000 = 75');
  else bad(`depósito EnZona incorrecto: ${calculateCommission(5000, 'deposit', 'enzona')}`);

  if (calculateCommission(5000, 'withdrawal', 'enzona') === 150) ok('retiro EnZona: 3% de 5000 = 150');
  else bad(`retiro EnZona incorrecto: ${calculateCommission(5000, 'withdrawal', 'enzona')}`);

  // Montos donde el minimo de 10 CUP gana sobre la tasa (0.5% de 1000 = 5)
  if (calculateCommission(1000, 'deposit', 'usdt') === 10) ok('depósito USDT pequeño: gana el mínimo de 10');
  else bad(`esperaba 10 por mínimo, obtuvo ${calculateCommission(1000, 'deposit', 'usdt')}`);

  // Retiros tienen minimo propio de 20 (1% de 1000 = 10)
  if (calculateCommission(1000, 'withdrawal', 'usdt') === 20) ok('retiro USDT pequeño: gana el mínimo de 20');
  else bad(`esperaba 20 por mínimo, obtuvo ${calculateCommission(1000, 'withdrawal', 'usdt')}`);

  // Techo aplicado
  if (calculateCommission(1000000, 'deposit', 'enzona') === 500) ok('depósito: gana el techo de 500');
  else bad(`techo no aplicado: ${calculateCommission(1000000, 'deposit', 'enzona')}`);

  if (calculateCommission(1000000, 'withdrawal', 'enzona') === 1000) ok('retiro: gana el techo de 1000');
  else bad(`techo de retiro no aplicado: ${calculateCommission(1000000, 'withdrawal', 'enzona')}`);

  // USDT siempre debe salir mas barato que los metodos fiat
  const usdt = calculateCommission(5000, 'withdrawal', 'usdt');
  const fiat = calculateCommission(5000, 'withdrawal', 'enzona');
  if (usdt < fiat) ok(`USDT sale mas barato que CUP en retiros (${usdt} < ${fiat})`);
  else bad('USDT no es mas barato que los metodos fiat');
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
