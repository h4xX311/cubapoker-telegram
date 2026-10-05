/**
 * Lanza todas las suites y reporta el resultado conjunto.
 *
 * Se ejecuta en un runner propio, y no con `a && b && c` en el script de npm,
 * por dos razones:
 *
 *  1. Con `&&` la primera suite que falla corta las siguientes. Una prueba que
 *     falla por un motivo concreto (una regla sin implementar, un dato que hay
 *     que revisar) impedia ejecutar las del motor, que detectan bugs reales.
 *
 *  2. El codigo de salida debe reflejar si ALGUNA suite fallo, no solo la
 *     ultima.
 */

const { spawnSync } = require('child_process');

const SUITES = [
  { name: 'Cadenas y comisiones', file: 'test-chains.js' },
  { name: 'Reglas de negocio', file: 'test-business-rules.js' },
  { name: 'Reparto y RTP', file: 'test-payout.js' },
  { name: 'Reglas del campo', file: 'test-field.js' },
  { name: 'Atomicidad de posiciones', file: 'test-field-atomic.js' },
  { name: 'Reglas de retiro', file: 'test-withdrawal.js' },
  { name: 'Depositos USDT en TRC20', file: 'test-usdt-deposit.js' },
  { name: 'Motor de poker', file: 'test-engine.js' },
];

const results = [];

for (const suite of SUITES) {
  console.log(`\n${'='.repeat(60)}\n${suite.name}\n${'='.repeat(60)}`);

  const run = spawnSync(process.execPath, [`scripts/${suite.file}`], {
    stdio: 'inherit',
  });

  results.push({ name: suite.name, code: run.status ?? 1 });
}

console.log(`\n${'='.repeat(60)}\nResumen\n${'='.repeat(60)}`);

let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFALLA\x1b[0m';
  console.log(`  ${mark}  ${r.name}`);
  if (r.code !== 0) failed++;
}

if (failed > 0) {
  console.log(
    `\n${failed} suite(s) con fallos.\n` +
      'Revisa si el fallo es un bug real o una regla de negocio todavia sin ' +
      'implementar, y si es lo segundo, se para el runner en vez de dejar que ' +
      'las demas suites no se ejecuten.',
  );
}

process.exit(failed > 0 ? 1 : 0);
