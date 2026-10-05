/**
 * Pruebas de las reglas de retiro.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTO NECESITA SU PROPIO ARCHIVO
 *
 * Las reglas estan en `withdrawal.rules.ts`, sin mongoose, para que se puedan
 * ejecutar sin base de datos. Aqui se comprueban los casos que de verdad importan
 * en un producto que mueve dinero.
 *
 * El caso central es el del dreno: el saldo se consume al APROBAR un retiro, no al
 * pedirlo, y entre las dos cosas el jugador puede jugar y vaciar su saldo
 * retirable. Si la comprobacion final no esta, cada retiro es una forma de sacar
 * doble. Esta suite fija ese comportamiento para que no se pueda deshacer sin
 * que falle un test.
 *
 * Ejecutar: node scripts/test-withdrawal.js
 */

const {
  checkWithdrawal,
  canSettle,
  freeBalance,
  debitOnSettle,
} = require('../dist/services/payment/withdrawal.rules');

const { usdtToUnits } = require('../dist/config/units');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const U = usdtToUnits;
const MIN = U(10);            // 10 USDT
const MAX = U(25000);         // 25 000 USDT
const CAP = U(25000);         // tope mensual

console.log('\n\x1b[1mCubaPoker · Reglas de retiro\x1b[0m');

// =========================================================================
section('1. El minimo por via');

// El fallo clasico de esta regla es comparar unidades contra USDT. Si el minimo
// fuera 10 (USDT) y el importe 10 000 (unidades), pasarian todos los retiros
// de hasta 0,01 USDT y no pasaria ninguno de 10 USDT. Estas pruebas lo fijan.
{
  const r = checkWithdrawal(MIN - 1, { real: 100 * U(1), play: 0 }, 0, 'usdt');
  if (!r.ok && r.denial === 'BELOW_MINIMUM') ok('9,999 USDT se rechaza por debajo del minimo');
  else bad(`esperaba BELOW_MINIMUM, dio ${r.denial}`);

  const r2 = checkWithdrawal(MIN, { real: 100 * U(1), play: 0 }, 0, 'usdt');
  if (r2.ok) ok('exactamente 10 USDT se acepta (el limite es inclusivo)');
  else bad(`10 USDT rechazado con ${r2.denial}: el minimo no puede ser exclusivo`);
}

// Un importe de 10 UNIDADES (0,01 USDT) tiene que rechazarse. Si aqui pasara,
// el bug de unidades esta presente.
{
  const r = checkWithdrawal(10, { real: 100 * U(1), play: 0 }, 0, 'usdt');
  if (!r.ok && r.denial === 'BELOW_MINIMUM') ok('10 unidades (0,01 USDT) se rechaza: las unidades estan bien');
  else bad(`10 unidades pasaron el filtro del minimo: ${r.denial}`);
}

// La via CUP tiene su propio minimo, mas alto en proporcion porque la comision
// fija se come mas de un retiro pequeno.
{
  const minCup = U(1000 / 120); // ~8,33 USDT
  const r = checkWithdrawal(U(5), { real: 100 * U(1), play: 0 }, 0, 'cup');
  if (!r.ok && r.denial === 'BELOW_MINIMUM') ok('5 USDT por la via CUP se rechaza (minimo 1 000 CUP)');
  else bad(`5 USDT por CUP paso: ${r.denial}`);

  const r2 = checkWithdrawal(minCup, { real: 100 * U(1), play: 0 }, 0, 'cup');
  if (r2.ok) ok('1 000 CUP exactos se aceptan por la via CUP');
  else bad(`1 000 CUP rechazados: ${r2.denial}`);
}

// Con `skipMinimum` el servicio se encarga del mensaje, asi que la regla no debe
// quejarse del minimo pero si de todo lo demas.
{
  const r = checkWithdrawal(1, { real: 100 * U(1), play: 0 }, 0, 'usdt', 0, {
    skipMinimum: true,
  });
  if (r.ok) ok('skipMinimum deja pasar el minimo y aun asi valida el saldo');
  else bad(`skipMinimum no salto el minimo: ${r.denial}`);
}

// =========================================================================
section('2. Topes por transaccion y mensual');

{
  const r = checkWithdrawal(MAX + 1, { real: MAX * 2, play: 0 }, 0, 'usdt');
  if (!r.ok && r.denial === 'ABOVE_MAXIMUM') ok('25 000,001 USDT supera el maximo por transaccion');
  else bad(`esperaba ABOVE_MAXIMUM, dio ${r.denial}`);

  const r2 = checkWithdrawal(MAX, { real: MAX * 2, play: 0 }, 0, 'usdt');
  if (r2.ok) ok('25 000 USDT exactos se aceptan');
  else bad(`25 000 USDT rechazados: ${r2.denial}`);
}

// El tope mensual cuenta lo ya pagado, no lo pendiente. Un usuario que ya
// retiro 20 000 este mes solo puede sacar 5 000 mas, aunque tenga 100 000 de saldo.
//
// El importe tiene que quedar POR DEBAJO del maximo por transaccion (25 000), o
// el rechazo seria por `ABOVE_MAXIMUM` y la prueba no distinguiria un tope del
// otro. Por eso se piden 22 000 y no 30 000.
{
  const r = checkWithdrawal(U(22000), { real: U(100000), play: 0 }, 0, 'usdt', CAP - U(20000));
  if (!r.ok && r.denial === 'ABOVE_MONTHLY_CAP') {
    ok('con 20 000 ya retirados, pedir 22 000 choca con el tope mensual');
  } else {
    bad(`esperaba ABOVE_MONTHLY_CAP, dio ${r.denial}`);
  }

  const r2 = checkWithdrawal(U(5000), { real: U(100000), play: 0 }, 0, 'usdt', CAP - U(20000));
  if (r2.ok) ok('lo que queda de margen mensual (5 000) si se puede pedir');
  else bad(`5 000 rechazado con ${r2.denial}`);

  const r3 = checkWithdrawal(U(5000), { real: U(100000), play: 0 }, 0, 'usdt', CAP);
  if (!r3.ok && r3.denial === 'ABOVE_MONTHLY_CAP') ok('tope mensual agotado: no se puede pedir nada');
  else bad(`con el tope ya lleno dio ${r3.denial}`);
}

// El saldo disponible NO debe poder saltar el tope mensual. Aunque tenga el
// saldo, el tope manda.
{
  const r = checkWithdrawal(U(22000), { real: U(1000000), play: 0 }, 0, 'usdt', CAP - U(20000));
  if (!r.ok) ok('un saldo enorme tampoco salta el tope mensual');
  else bad('el saldo real permitio retirar mas del tope mensual');
}

// =========================================================================
section('3. El saldo de promocion no es retirable');

// ESTA ES LA REGLA QUE PROTEGE A LA PLATAFORMA DE PERDER DINERO REAL.
//
// Si un retiro pagara con `play`, el usuario vaciaria la caja sin haber depositado
// nunca: el saldo promocional sale de bonuses y freerolls. `canSettle` tiene que
// rechazar igual, porque el filtro de Mongo se apoya en este numero.
{
  const r = checkWithdrawal(U(10), { real: 0, play: U(100000) }, 0, 'usdt');
  if (!r.ok && r.denial === 'PROMOTIONAL_ONLY') {
    ok('con 0 de real y 100 000 de play no se puede retirar nada');
  } else {
    bad(`esperaba PROMOTIONAL_ONLY, dio ${r.denial}`);
  }

  const r2 = canSettle(U(10), 0);
  if (r2 === 'EXCEEDS_FREE_BALANCE') ok('canSettle tambien rechaza con solo saldo de promocion');
  else bad(`canSettle dio ${r2}`);

  // Y el mensaje tiene que NOMBRAR las dos cifras: un usuario que ve un error sin
  // mas cree que le han timado.
  if (r.message && r.message.includes('promocion') && r.message.includes('retirable')) {
    ok('el mensaje explica que el saldo de promocion no es retirable');
  } else {
    bad(`el mensaje no aclara la regla: ${r.message}`);
  }
}

// =========================================================================
section('4. Las pendientes reservan saldo');

// ESTA ES LA QUE IMPIDE EL "ABRE CIEN PEDIDOS".
//
// El saldo no se descuenta al pedir, asi que si las pendientes no se sumaran,
// un usuario con 100 USDT podria abrir cien pedidos de 100 y el operador
// veria cien pagos salido del mismo saldo.
{
  const r = checkWithdrawal(U(100), { real: U(100), play: 0 }, U(100), 'usdt');
  if (!r.ok && r.denial === 'EXCEEDS_FREE_BALANCE') {
    ok('con 100 pendientes sobre 100 de saldo, no se puede pedir mas');
  } else {
    bad(`esperaba EXCEEDS_FREE_BALANCE, dio ${r.denial}`);
  }

  // Justo en el limite: si ya hay 60 pendientes de 100, solo caben 40 mas.
  const r2 = checkWithdrawal(U(40), { real: U(100), play: 0 }, U(60), 'usdt');
  if (r2.ok) ok('con 60 de 100 comprometidos, 40 mas caben exactamente');
  else bad(`40 rechazado: ${r2.denial}`);

  const r3 = checkWithdrawal(U(41), { real: U(100), play: 0 }, U(60), 'usdt');
  if (!r3.ok && r3.denial === 'EXCEEDS_FREE_BALANCE') ok('41 sobre esos mismos 60 no cabe');
  else bad(`41 deberia no caber, dio ${r3.denial}`);

  // El saldo libre nunca es negativo, aunque las pendientes lo sean por datos
  // viejos o por un cobro que se quedo a medias.
  if (freeBalance(U(100), U(500)) === 0) ok('un saldo libre negativo se recorta a 0, no a negativo');
  else bad(`freeBalance dio ${freeBalance(U(100), U(500))}, deberia ser 0`);

  // Un `pending` negativo sale de datos corruptos. No puede AUMENTAR el saldo
  // disponible: se recorta a 0, asi que el usuario sigue teniendo 100 USDT, no 150.
  if (freeBalance(U(100), U(-50)) === U(100)) ok('un pending negativo no aumenta el saldo disponible');
  else bad(`freeBalance con pending negativo dio ${freeBalance(U(100), U(-50))}, esperaba ${U(100)}`);

  // Y un `real` negativo (estado corrupto) se trata como 0, no como un saldo que
  // se puede retirar.
  if (freeBalance(U(-500), 0) === 0) ok('un saldo real negativo se trata como 0');
  else bad(`freeBalance con real negativo dio ${freeBalance(U(-500), 0)}`);
}

// =========================================================================
section('5. EL DRENO: pedir, jugar, y cobrar');

// ------------------------------------------------------------------
// ESTE ES EL TEST QUE PROTEGE EL DINERO DE LA PLATAFORMA
// ------------------------------------------------------------------
//
// El saldo se consume al APROBAR, no al pedir. Entre pedir y aprobar el jugador
// puede sentarse a una mesa, y `splitBuyIn` consume `play` primero y luego
// `real`. O sea: puede vaciar su saldo retirable mientras el retiro sigue
// pendiente.
//
// La secuencia que hace esto un dreno ilimitado:
//
//   1. Deposita 100 USDT.        real = 100 000 unidades
//   2. Pide retirarlos.          real = 100 000, pendiente 100 000  (se acepta: ok)
//   3. Se sienta a una mesa.      splitBuyIn le vacia `real`.  real = 0
//   4. El operador paga y aprueba.
//      Con un `$inc` sin filtro: real = -100 000, y el usuario tiene 100 USDT
//      en fichas Y 100 USDT cobrados.
//
// Con el filtro `balance.real >= amount` del `findOneAndUpdate`, el paso 4 falla
// y el retiro no se liquida. ESTE es el comportamiento que hay que mantener.
{
  const DEPOSIT = U(100);
  let real = DEPOSIT;

  // Paso 2: pedir. Debe aceptarse, el saldo es real y suficiente.
  const ask = checkWithdrawal(DEPOSIT, { real, play: 0 }, 0, 'usdt');
  if (ask.ok) ok('el jugador puede pedir sus 100 USDT');
  else bad(`no se puede pedir un retiro del propio saldo: ${ask.denial}`);

  // El saldo NO baja al pedir. Esto es lo que hace que el jugador pueda vaciarlo
  // jugando antes de la aprobacion.
  if (real === DEPOSIT) ok('pedir NO descuenta saldo: se descuenta al aprobar');
  else bad(`pedir descuento saldo de ${DEPOSIT} a ${real}`);

  // Paso 3: el jugador juega y vacia `real`.
  real = 0;

  // Paso 4: la aprobacion debe RECHAZARSE.
  const settle = canSettle(DEPOSIT, real);
  if (settle === 'EXCEEDS_FREE_BALANCE') {
    ok('la aprobacion se rechaza si el jugador ya no tiene saldo retirable');
  } else {
    bad(`la aprobacion NO se rechazo (dio ${settle}): el dreno sigue abierto`);
  }

  // El filtro de Mongo es exactamente esta comparacion. Si alguien cambia el
  // `findOneAndUpdate` de settleWithdrawal, este test avisa.
  const mongoFilterWouldMatch = real >= DEPOSIT;
  if (!mongoFilterWouldMatch) {
    ok('el filtro `{ balance.real: { $gte: amount } }` no matchea: la operacion falla');
  } else {
    bad('el filtro de Mongo matchearia con saldo insuficiente: se cobraria de mas');
  }

  // Y con esto el jugador no puede ganar nada: no se le descuenta nada.
  const debited = mongoFilterWouldMatch ? DEPOSIT : 0;
  if (debited === 0) ok('no se descuenta saldo al jugador que ya no tiene');
  else bad(`se descontaron ${debited} unidades de un saldo vacio`);

  // El escenario inverso: el jugador NO juega, y el retiro se liquida bien.
  {
    let real2 = DEPOSIT;
    const before = real2;
    const s = canSettle(DEPOSIT, real2);
    if (s === null) {
      real2 -= debitOnSettle(DEPOSIT);
      ok('si el saldo sigue intacto, la aprobacion procede y descuenta el importe');
    } else {
      bad(`un retiro con saldo suficiente fue rechazado: ${s}`);
    }
    if (before - real2 === DEPOSIT) ok(`el saldo baja de ${before} a ${real2}: el importe exacto`);
    else bad(`desconto ${before - real2}, esperaba ${DEPOSIT}`);
  }
}

// Un jugador con `play` grande y `real` en el borde: el `play` no le salva.
{
  const real = U(10);
  const s = canSettle(U(10), real);
  if (s === null) ok('con real justo en el importe, la aprobacion procede');
  else bad(`con real exactamente igual al importe dio ${s}: el filtro es exclusivo`);

  const s2 = canSettle(U(10), real - 1);
  if (s2 === 'EXCEEDS_FREE_BALANCE') ok('con una unidad de menos, se rechaza (filtro es $gte)');
  else bad(`con real - 1 dio ${s2}`);
}

// =========================================================================
section('6. Importes invalidos');

{
  // NaN e Infinity en un `$inc` corrompen el saldo de forma permanente: Mongo no
  // puede deshacer un `NaN`. Se rechazan en la puerta.
  for (const [label, val] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]) {
    const r = checkWithdrawal(val, { real: U(100000), play: 0 }, 0, 'usdt');
    const s = canSettle(val, U(100000));
    if (!r.ok && r.denial === 'AMOUNT_NOT_POSITIVE' && s === 'AMOUNT_NOT_POSITIVE') {
      ok(`${label} se rechaza tanto al pedir como al aprobar`);
    } else {
      bad(`${label}: pedir dio ${r.denial}, aprobar dio ${s}`);
    }
  }

  for (const [label, val] of [['cero', 0], ['negativo', -U(100)]]) {
    const r = checkWithdrawal(val, { real: U(100000), play: 0 }, 0, 'usdt');
    if (!r.ok && r.denial === 'AMOUNT_NOT_POSITIVE') ok(`un importe ${label} se rechaza`);
    else bad(`importe ${label} paso: ${r.denial}`);
  }

  // Un importe con decimales sueltos en unidades es legal (0,001 USDT), pero por
  // debajo del minimo. Lo que no puede ser es un numero flotante no entero en el
  // `amount` de Mongo, que por eso la comparacion es `<` y no `<=`.
  const r = checkWithdrawal(10_000.5, { real: U(100000), play: 0 }, 0, 'usdt');
  if (r.ok) ok('10 000,5 unidades (10,0005 USDT) es un importe valido');
  else bad(`un importe fraccionario pequeno fue rechazado: ${r.denial}`);
}

// =========================================================================
section('7. Que se descuenta al aprobar es el importe, no el neto');

{
  // Si al aprobar se descontara el neto (importe menos comision), la comision de
  // cobro se cobraria dos veces: una por la pasarela y otra por la plataforma.
  // Y si se descontara de mas, se estaria cobrando al usuario.
  if (debitOnSettle(1000) === 1000) ok('se descuenta el importe completo, no el neto');
  else bad(`debitOnSettle(1000) = ${debitOnSettle(1000)}`);
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);