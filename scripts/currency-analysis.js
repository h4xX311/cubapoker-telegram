/**
 * Analiza el cambio de moneda de la cuenta: CUP -> USDT.
 *
 * Conclusion de la investigacion: CoinPoker mantiene el saldo de la cuenta en
 * USDT. Sus terminos y condiciones lo dicen explicitamente:
 *
 *   "Your account balance is the amount of cryptocurrency paid into your
 *    account"
 *   "deposited currency to be collected and exchanged for the equivalent
 *    value in USDT"
 *
 * Es decir: aunque deposites BTC, ETH o SOL, todo se convierte a USDT y la
 * cuenta vive en USDT. Los depositos en fiat (tarjeta, Luxon) tambien se
 * convierten a USDT.
 *
 * Esto script imprime las implicaciones de hacer lo mismo aqui.
 */

const out = [];
const p = (s = '') => out.push(s);

// Tipo de cambio de referencia. Cuba tiene tipo oficial y tipo paralelo, y son
// muy distintos (120 vs ~400 CUP por USD). Este numero hay que revisarlo con
// el operador: de el depende cuanto recibe un usuario al retirar.
const OFFICIAL = 120;
const PARALLEL = 400;

p('='.repeat(74));
p('Moneda de la cuenta: USDT (modelo CoinPoker)');
p('='.repeat(74));
p('');
p('Que dice CoinPoker (T&C, deposits-and-withdrawals):');
p('  "Your account balance is the amount of cryptocurrency paid into your');
p('   account"');
p('  "deposited currency to be collected and exchanged for the equivalent');
p('   value in USDT"');
p('');
p('Traduccion: todo se convierte a USDT y la cuenta vive en USDT. Da igual si');
p('entras por BTC, ETH, SOL o tarjeta. La unidad de la cuenta es una sola.');
p('');

p('-'.repeat(74));
p('1. Por que NO se puede guardar en CUP');
p('-'.repeat(74));
p('');
p('Guardar el saldo en CUP tiene dos problemas que USDT no tiene:');
p('');
p('  a) El valor del saldo cambia solo. Si depositas 1000 CUP y al dia');
p('     siguiente el tipo se mueve, tus 1000 CUP valen otra cosa. No es un');
p('     saldo, es una posicion cambiaria.');
p('');
p('  b) Al retirar hay que decidir que tipo se congela: el del deposito, el');
p('     del retiro, o un promedio. CoinPoker no tiene que tomar esa decision');
p('     porque su unidad es estable.');
p('');
p('Con USDT, el deposito en CUP se convierte una vez, al entrar. El saldo');
p('queda en USDT y no se mueve con el mercado.');
p('');

p('-'.repeat(74));
p('2. El problema real: que tipo de cambio usar');
p('-'.repeat(74));
p('');
p(`  Tipo oficial de cambio:  ${OFFICIAL} CUP = 1 USD`);
p(`  Tipo paralelo:           ${PARALLEL} CUP = 1 USD`);
p(`  Diferencia:             ${(PARALLEL / OFFICIAL).toFixed(1)}x`);
p('');
p('Es una diferencia de 3,3x. NO es un detalle: es la decision economica mas');
p('importante del proyecto.');
p('');
p('  - Con el oficial (120), un usuario que deposita 10 000 CUP tiene 83 USDT.');
p('    Al retirar recibe 10 000 CUP. Es justo, pero el CUP de facto se');
p('    deprecia.');
p('');
p('  - Con el paralelo (400), 10 000 CUP son 25 USDT y al retirar vuelve a');
p('    10 000 CUP. El usuario conserva el valor de mercado. Pero el operador');
p('    esta pagando y cobrando en una moneda que no puede tratar legalmente.');
p('');
p('Referencia de como se ve en cada tipo:');
p('');

for (const cup of [1000, 5000, 10000, 50000, 100000]) {
  const of = cup / OFFICIAL;
  const pa = cup / PARALLEL;
  p(
    '    ' + String(cup).padStart(7) + ' CUP  ->  ' +
    of.toFixed(2).padStart(7) + ' USDT (oficial)  /  ' +
    pa.toFixed(2).padStart(6) + ' USDT (paralelo)',
  );
}

p('');
p('-'.repeat(74));
p('3. Los numeros de poker hay que rehacerlos');
p('-'.repeat(74));
p('');
p('Hoy los campos estan en CUP: buy-in de 200 a 2000 CUP. En USDT eso son');
p('entradas de 1,67 a 16,67 USDT, y el campo de 500 con buy-in de 2000 CUP');
p('seria un bote de 8 333 USDT. Los numeros no significan lo mismo.');
p('');
p('Con buy-in de 5 USDT (que es un stack de poker normal):');
p('');
p('    field   buy-in    bote bruto    rake 5%     bote neto     1o lugar');
for (const f of [50, 100, 300, 500]) {
  const buyIn = 5;
  const gross = f * buyIn;
  const rake = Math.floor(gross * 0.05);
  const net = gross - rake;
  p(
    '    ' + String(f).padEnd(8) + String(buyIn).padEnd(10) +
    String(gross).padStart(9) + ' USDT' +
    String(rake).padStart(10) + ' USDT' +
    String(net).padStart(11) + ' USDT' +
    String(Math.floor(net * 0.45)).padStart(12) + ' USDT',
  );
}

p('');
p('  Con 5 USDT el campo de 500 deja al ganador 1125 USDT. Es un stack de');
p('  poker serio, comprable con 600 CUP, y el rake del 5% da 125 USDT por');
p('  campo.');
p('');
p('  En CUP, para el usuario equivaldria a 135 000 CUP de premio. Que es');
p('  mucho mas de lo que las mesasfree actuales (50-500 CUP).');
p('');

p('-'.repeat(74));
p('4. Que hay que cambiar en el codigo');
p('-'.repeat(74));
p('');
p('  User.balance.real / balance.play');
p('    Los dos siguen siendo correctos (retirable vs no retirable). Lo que');
p('    cambia es la UNIDAD: los dos pasan a ser USDT.');
p('');
p('  TABLE_TIERS');
p('    minBuyIn y defaultBuyIn en USDT. Los numeros de 200/500/1000/2000 CUP');
p('    se reescriben.');
p('');
p('  deposit.service / gateway');
p('    Un deposito en CUP pasa a convertirse a USDT ANTES de acreditar.');
p('    Un deposito en USDT se acredita tal cual (las 5 cadenas siguen siendo');
p('    validas: son la via de entrada, no la unidad de la cuenta).');
p('    Un retiro en CUP convierte USDT -> CUP al tipo vigente.');
p('');
p('  withdrawal');
p('    Sigue consumiendo solo balance.real. La unidad no cambia la regla.');
p('');
p('  UI');
p('    Muestra el saldo en USDT y el equivalente en CUP como referencia');
p('    secundaria, que es lo que hace un exchange.');
p('');
p('  chains.ts');
p('    No cambia. Las 5 cadenas son metodos de entrada/salida de USDT.');
p('');

p('-'.repeat(74));
p('5. Lo que NO cambia');
p('-'.repeat(74));
p('');
p('  - El saldo doble real/play y su regla de no retirabilidad.');
p('  - Las 5 redes USDT para deposito/retiro.');
p('  - El rake del 5% y el reparto 45/25/15/9/6.');
p('  - El RTP del 95%: es independiente de la unidad.');
p('  - El 7-max y la estructura multi-mesa.');
p('');
p('  El RTP no depende de si el saldo esta en CUP o en USDT: es una propiedad');
p('  del reparto, no de la moneda.');

console.log(out.join('\n'));
