/**
 * Numeros de CubaPoker alineados con CoinPoker.
 *
 * Datos sacados de coinpoker.com (septiembre-octubre 2026):
 *
 * RAKE
 *   Cash Games ...... 5%
 *   Torneos ......... 2%-8%
 *   All-In or Fold .. cuota fija, sin porcentaje
 *   Splash Pots ..... 0,1 BB por mano (solo en mesas con splash)
 *
 * MONEDA
 *   La cuenta vive en USDT. Depositos en BTC/ETH/SOL/tarjeta se convierten a
 *   USDT (T&C: "deposited currency to be collected and exchanged for the
 *   equivalent value in USDT").
 *
 * FREEROLLS
 *   Buy-in ............ $0
 *   Premios .......... sobre todo TICKETS de torneo ($0,20 / $0,50 / $1 / $2)
 *   Premios en dinero ... "hasta $300 o mas con eventos especiales"
 *   Cadencia .......... cada 30-90 minutos, 15 al dia
 *   Duracion ......... 2-3 horas
 *   Reentrada ........ NO (freezeout)
 *
 * CENTROLLS
 *   Buy-in ............ $0,01
 *   Requisito ........ saldo real de al menos $0,01
 *   Premios .......... TICKETS a satelitos, no dinero
 *   Reentrada ........ si, $0,01
 *
 * Ejecutar: node scripts/coinpoker-benchmarks.js
 */

const out = [];
const p = (s = '') => out.push(s);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// Tipo de cambio elegido: oficial configurable, 120 CUP = 1 USD.
const CUP_PER_USDT = 120;

p('='.repeat(78));
p('CubaPoker vs CoinPoker · numeros');
p('='.repeat(78));
p('');
p('Tipo de cambio: ' + CUP_PER_USDT + ' CUP = 1 USDT (oficial, configurable)');
p('');

// =========================================================================
p('-'.repeat(78));
p('1. RAKE: ya coincide');
p('-'.repeat(78));
p('');
p('  Cash games   CoinPoker 5%    CubaPoker 5%    coincide');
p('  Torneos      CoinPoker 2-8%  CubaPoker 5%    dentro del rango');
p('  Freerolls    CoinPoker 0%    CubaPoker 0%    coincide (ver seccion 4)');
p('');
p('  El rake no cambia. Lo que cambia son los stakes.');

p('');
p('-'.repeat(78));
p('2. ESCALERA DE STAKES EN USDT');
p('-'.repeat(78));
p('');
p('Los campos de ahora van en CUP: buy-in de 200 a 2000 CUP. En USDT son');
p('entradas de 1,67 a 16,67 USDT, que no corresponde a nada reconocible.');
p('');
p('Propuesta, con el equivalente en CUP para el usuario坟墓ano:');
p('');
p('  nivel      buy-in   ciegas     stack   campo   bote bruto   rake    1o lugar');
p('  ' + '-'.repeat(74));

const LADDER = [
  { name: 'Micro',     buyIn: 1 },
  { name: 'Bajo',      buyIn: 5 },
  { name: 'Medio',     buyIn: 25 },
  { name: 'Alto',      buyIn: 100 },
];

for (const l of LADDER) {
  const bb = l.buyIn >= 25 ? l.buyIn / 100 : l.buyIn / 50;
  const sb = bb / 2;
  const bbText = bb >= 1 ? bb.toFixed(2) : bb.toFixed(3);
  const sbText = sb >= 1 ? sb.toFixed(2) : sb.toFixed(3);
  const field = 300;
  const gross = field * l.buyIn;
  const rake = Math.floor(gross * 0.05);
  const net = gross - rake;
  const first = Math.floor(net * 0.45);

  p(
    '  ' + pad(l.name, 9) +
    padL(l.buyIn + ' USDT', 8) +
    pad(sbText + '/' + bbText, 11) +
    padL(Math.round(l.buyIn / bb) + ' BB', 7) +
    padL(field, 7) +
    padL(gross.toLocaleString('es-ES'), 13) +
    padL(rake.toLocaleString('es-ES'), 9) +
    padL(first.toLocaleString('es-ES'), 12),
  );
}

p('');
p('  En CUP, al usuario cubano le cuesta:');
p('');
for (const l of LADDER) {
  p('    ' + pad(l.name, 9) + padL(Math.round(l.buyIn * CUP_PER_USDT).toLocaleString('es-ES') + ' CUP', 12));
}

p('');
p('  Lectura:');
p('');
p('  - Micro (1 USDT = 120 CUP) entra con el deposito minimo de EnZona, que');
p('    esta en 500 CUP. Es el nivel de entrada real para un usuario cubano.');
p('  - Alto (100 USDT = 12 000 CUP) es un stack serio, comparable a lo que');
p('    CoinPoker llama "mid stakes".');
p('  - El rake del campo de 300 con buy-in de 25 USDT son 375 USDT: es un');
p('    ingreso serio por campo, y es lo que paga la infraestructura.');

// =========================================================================
p('');
p('-'.repeat(78));
p('3. CAMPOS: 4 niveles con el mismo target');
p('-'.repeat(78));
p('');
p('Hoy los 4 campos tienen el mismo buy-in por jugador (2000 CUP el mas alto)');
p('y lo que escala es el numero de participantes. Eso hace que el campo de 50');
p('y el de 500 difieran solo en la duracion.');
p('');
p('Propuesta: 4 niveles de buy-in, todos con field de 300 participantes.');
p('');
p('  Por que 300 y no 50/100/500:');
p('    - 50 participantes = 8 mesas. Un campo tan pequeno se llena en minutos y');
p('      termina rapido: es un SNG exprido, no un campo.');
p('    - 500 participantes = 72 mesas. Con la base de usuarios de un proyecto');
p('      nuevo, un campo de 500 tardaria horas en llenarse y la gente se');
p('      cansaria esperando.');
p('    - 300 = 43 mesas: grande, pero llega a mesa final en un rato.');
p('');
p('  Y "ilimitado" no existe: hay un techo, porque un campo sin tope es un');
p('  problema operativo (ver FREEROLL_MAX_FIELD).');

// =========================================================================
p('');
p('-'.repeat(78));
p('4. FREEROLLS: aqui hay un problema de fondo');
p('-'.repeat(78));
p('');
p('Que hace CoinPoker:');
p('');
p('  - Freeroll: buy-in $0. Premios SOBRE TODO TICKETS de torneo:');
p('      20 x $0,50 · 30 x $0,20 · 5 x $2 · 5 x $1');
p('  - El dinero en un freeroll es la excepcion, no la regla:');
p('      "From freerolls, you can win cash prizes, up to $300 or more with');
p('       special promotion events."');
p('  - Centroll: buy-in $0,01, premios 100% tickets, con reentrada.');
p('');
p('Que hace CubaPoker ahora:');
p('');
p('  - 6 escalones de 5 a 50 CUP de premio, todos en efectivo (saldo play).');
p('  - "Ilimitado", 300 de objetivo.');
p('');
p('TRES DIFERENCIAS');
p('');
p('  a) TICKETS vs EFECTIVO. CoinPoker reparte tickets, que son entradas a');
p('     torneos. Un ticket no es dinero: no genera pasivo contable ni');
p('     obligacion de pago. Si CubaPoker paga 5-50 CUP de dinero real en cada');
p('     freeroll, el operador paga efectivo por una entrada gratis.');
p('');
p('  b) CENTROLLS. CoinPoker tiene un nivel de $0,01 que exige saldo REAL.');
p('     Es la pieza que hace rentable el freeroll: el jugador deposita, usa');
p('     una fraccion de su saldo para jugar y gana tickets/ fichas. CubaPoker');
p('     no tiene equivalente: su freeroll es gratis de verdad, asi que no hay');
p('     ninguna via de ingresos del freeroll.');
p('');
p('  c) CADENCIA. CoinPoker corre 15 freerolls al dia, cada 30-90 minutos,');
p('     de 2-3 horas. CubaPoker tiene uno que dura lo que dura un campo de');
p('     300 con objetivo de 300: puede ser horas o dias.');

p('');
p('-'.repeat(78));
p('5. LO QUE PROPONGO');
p('-'.repeat(78));
p('');
p('a) SALDO PLAY = TICKETS. Mantener el saldo no retirable, pero llamarlo y');
p('   medirlo como lo que es: fichas de promocion que dan acceso a freerolls y');
p('   centrolls. NO es dinero. Los freerolls no pagan efectivo salvo que el');
p('   operador lance una promo concreta con presupuesto.');
p('');
p('b) ANADIR CENTROLLS A $0,01. Es la via de ingresos que falta. Buy-in de');
p('   1,2 CUP (0,01 USDT), consume saldo REAL, y su premio son fichas de');
p('   promocion con las que se juega mas centrolls y freerolls. El bucle es:');
p('   deposito -> centro -> fichas -> centro/freeroll.');
p('');
p('c) CALIBRAR LOS ESCALONES DE FREEROLL en fichas, no en CUP de efectivo.');
p('   Escala de referencia (valor en USDT de la ficha ganada):');
p('');
p('     escalon   field   premio      1o lugar      equivalente CUP');
p('     ' + '-'.repeat(66));
const FR = [
  { name: 'Mini',    field: 100, prize: 1 },
  { name: 'Pequeño', field: 200, prize: 3 },
  { name: 'Medio',   field: 300, prize: 10 },
  { name: 'Grande',  field: 500, prize: 25 },
  { name: 'Mayor',   field: 1000, prize: 50 },
  { name: 'Top',     field: 2000, prize: 200 },
];
for (const f of FR) {
  const first = Math.floor(f.prize * 0.45);
  p(
    '     ' + pad(f.name, 10) + padL(f.field, 8) + padL(f.prize + ' USDT', 13) +
    padL(first + ' USDT', 13) + padL(Math.round(first * CUP_PER_USDT) + ' CUP', 18),
  );
}
p('');
p('  Con field de 2000 y premio de 200 USDT, el ganador recibe 90 USDT =');
p('  10 800 CUP. Un freeroll en Cuba no puede pagar eso de forma sostenible.');
p('');
p('  Y aqui esta el problema que hay que decidir:');
p('');
p('  Un field de 2000 con 200 USDT de premio es un premio REAL. Si ese saldo');
p('  de promocion no es retirable (como ahora), esta bien: es marketing.');
p('  Pero si un usuario puede retirarlo, el operador owes 90 USDT por cada');
p('  ganador de un evento gratis, y eso no lo cubre ningun rake.');
p('');
p('  Con un solo freeroll al dia y un premio de 200 USDT, son 200 USDT/dia');
p('  = 6 000 USDT/mes solo en ese evento. Con 15 eventos al dia (como');
p('  CoinPoker), serian 90 000 USDT/mes.');

p('');
p('-'.repeat(78));
p('6. LO QUE NO CAMBIA');
p('-'.repeat(78));
p('');
p('  - Moneda de la cuenta: USDT.');
p('  - Rake: 5% cash, 0% freeroll.');
p('  - 7-max y estructura multi-mesa.');
p('  - El saldo doble: `real` retirable, `play` no retirable.');
p('  - Las 5 redes USDT de entrada/salida.');
p('  - El RTP del 95% en los campos de dinero.');
p('');
p('  El cambio es de MAGNITUD y de MECANICA del freeroll, no de la moneda.');

console.log(out.join('\n'));
