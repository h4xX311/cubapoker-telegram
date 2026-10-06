/**
 * Test del freno de simulacion en los retiros.
 *
 * ------------------------------------------------------------------
 * QUE PROTEGE
 *
 * Que en modo simulacion no se pueda marcar un retiro como pagado. Y no por
 *esthetics: `POST /api/admin/withdrawals/:orderId/approve` NO mueve dinero, solo marca
 * la orden y descuenta el saldo, porque el envio lo hace el operador por fuera.
 *
 * Sin freno, ese endpoint en simulacion producia el peor resultado posible de un
 * lanzamiento en modo prueba: el panel decia "aprobado", el operador entendia que el
 * sistema habia procesado un pago y mandaba USDT de verdad contra una orden de
 * mentira. No es un descuadre contable, es dinero real pagado a cambio de nada.
 *
 * ------------------------------------------------------------------
 * POR QUE HACE FALTA EL FLAG DE ENTORNO Y LA CONFIRMACION A LA VEZ
 *
 * Porque son dos cosas distintas y hacen falta las dos:
 *
 *   - El flag \`ALLOW_SIMULATED_WITHDRAWALS\` es deliberado y se escribe a mano. No
 *     viene puesto por arrancar el sistema.
 *   - \`confirmarSimulado: true\` va en cada peticion, asi que no se liquida un lote
 *     entero de golpe por un clic de mas.
 *
 * Con una sola de las dos, la otra seAnimalseria sola. Un boton que dijera "liquidar
 * simulado" y lo hiciera sin preguntas seria justo el accidente que hay que evitar.
 *
 * Ejecutar: MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_sim node scripts/test-sim-guard.js
 */

process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:37017/cubapoker_sim';

// El bot arranca polling de Telegram al importarse, asi que esto va ANTES de cargar
// nada del proyecto.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const mongoose = require('mongoose');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const note = (m) => console.log(`      \x1b[2m${m}\x1b[0m`);

const finish = async () => {
  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch { /* nada que hacer al salir */ }
  process.exit(fail > 0 ? 1 : 0);
};

main().catch(async (e) => {
  console.error('\n\x1b[31mEl test reviento antes de terminar:\x1b[0m');
  console.error(e);
  fail++;
  await finish();
});

const TELEGRAM_ID = 720_000_000;
const SALDO_INICIAL = 50_000;   // 50 USDT en unidades internas
const IMPORTE = 20_000;          // 20 USDT

/**
 * Carga el servicio de pago con un entorno concreto.
 *
 * `SIMULATION_ENABLED` y `ALLOW_SIMULATED_WITHDRAWALS` se leen al CARGAR el modulo,
 * asi que para probarlos en las dos direcciones hay que tirar la copia de la cache de
 * require. Sin esto, el test solo mediria una de las ramas.
 */
const cargarServicio = () => {
  delete require.cache[require.resolve('../dist/services/payment/payment.service')];
  delete require.cache[require.resolve('../dist/services/payment/gateway')];
  return require('../dist/services/payment/payment.service');
};

let ORDENES = null;
const cargarOrdenes = () => {
  // Una sola vez. Mongoose no deja registrar dos veces el mismo modelo, y aqui no hace
  // falta recargarlo: lo unico que cambia entre ramas son las variables de entorno, que
  // se leen en `payment.service` y `gateway`.
  if (!ORDENES) {
    ORDENES = require('../dist/models/PaymentOrder').PaymentOrder;
  }
  return ORDENES;
};

/**
 * Prepara un usuario con saldo y una orden de retiro pendiente.
 * Devuelve el `orderId` para poder liquidarla.
 */
const montarRetiro = async (PaymentOrder, orderId) => {
  const { User } = require('../dist/models/User');

  await User.deleteMany({ telegramId: TELEGRAM_ID });
  await User.create({
    telegramId: TELEGRAM_ID,
    username: 'usuario',
    firstName: 'Usuario',
    balance: { real: SALDO_INICIAL, play: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0,
      freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await PaymentOrder.create({
    orderId,
    provider: 'usdt',
    telegramId: TELEGRAM_ID,
    type: 'withdrawal',
    amount: IMPORTE,
    currency: 'USDT',
    chain: 'TRC20',
    status: 'pending',
    simulated: true,
    walletAddress: 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return orderId;
};

/**
 * Es un `instanceof` contra la MoneyError de la CARGA ACTUAL.
 *
 * Al recargar `payment.service` se crea una clase `MoneyError` nueva, y la de la
 * primera carga no dice nada sobre los errores de la ultima. Comparar contra la que se
 * acaba de cargar es lo unico que no miente.
 */
const esMoneyError = (error, clase) =>
  !!error && error instanceof clase;

const saldoReal = async () => {
  const { User } = require('../dist/models/User');
  const u = await User.findOne({ telegramId: TELEGRAM_ID });
  return u?.balance.real ?? 0;
};

async function main() {
  console.log('\n\x1b[1mCubaPoker · Freno de simulacion en los retiros\x1b[0m');
  note(`MONGODB_URI = ${process.env.MONGODB_URI}`);

  section('0. Conexion');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  note(`MongoDB ${hello.version} en ${mongoose.connection.host}:${mongoose.connection.port}`);
  await mongoose.connection.dropDatabase();
  ok('conectado y base de datos vaciada');

  const { MoneyError } = cargarServicio();

  // ===================================================================
  section('1. En simulacion, sin ningun permiso: RECHAZA');

  delete process.env.ALLOW_SIMULATED_WITHDRAWALS;
  delete process.env.SIMULATE_PAYMENTS;   // sin definir = simulacion activada
  let svc = cargarServicio();
  let MoneyErrorActual = svc.MoneyError;
  let ord = cargarOrdenes();

  note('SIMULATE_PAYMENTS sin definir, ALLOW_SIMULATED_WITHDRAWALS sin definir');

  await montarRetiro(ord, 'sim-sin-permiso');

  let fallo = null;
  try {
    await svc.paymentService.settleWithdrawal('sim-sin-permiso');
  } catch (e) {
    fallo = e;
  }

  if (esMoneyError(fallo, MoneyErrorActual)) {
    ok(`rechaza con MoneyError: "${fallo.message.slice(0, 70)}..."`);
  } else {
    bad(`NO ha rechazado: ${fallo ? fallo.message : 'ha liquidado el retiro'}`);
  }

  if (fallo && fallo.status === 409) ok('el error es un 409, no un 500: es una orden invalida');
  else bad(`el codigo de estado es ${fallo?.status}, esperado 409`);

  // Lo que de verdad importa: que no se haya movido nada.
  if (await saldoReal() === SALDO_INICIAL) {
    ok(`el saldo sigue en ${SALDO_INICIAL}: no se ha descontado nada`);
  } else {
    bad(`el saldo es ${await saldoReal()}, y deberia seguir en ${SALDO_INICIAL}`);
  }

  const ordenTrasRechazo = await ord.findOne({ orderId: 'sim-sin-permiso' });
  if (ordenTrasRechazo.status === 'pending') ok('la orden sigue `pending`: no se marco como pagada');
  else bad(`la orden quedo en "${ordenTrasRechazo.status}"`);

  // ===================================================================
  section('2. Con el flag puesto pero SIN confirmar en la peticion: RECHAZA');

  // Este es el caso peligroso: el operador abrio el panel, vio el aviso y pulso el
  // boton sin marcar la casilla. Con solo el flag puesto, pasaria.
  process.env.ALLOW_SIMULATED_WITHDRAWALS = 'true';
  svc = cargarServicio();
  MoneyErrorActual = svc.MoneyError;
  ord = cargarOrdenes();

  note('ALLOW_SIMULATED_WITHDRAWALS=true, pero sin `confirmarSimulado`');

  await montarRetiro(ord, 'sim-sin-confirmar');

  fallo = null;
  try {
    await svc.paymentService.settleWithdrawal('sim-sin-confirmar');
  } catch (e) {
    fallo = e;
  }

  if (esMoneyError(fallo, MoneyErrorActual)) {
    ok('rechaza igualmente: el flag solo no basta');
  } else {
    bad(`NO ha rechazado: ${fallo ? fallo.message : 'ha liquidado el retiro'}`);
  }

  if (fallo && fallo.message.includes('confirmarSimulado')) {
    ok('el mensaje dice que falta la confirmacion, no el flag');
  } else {
    bad(`el mensaje no menciona que falta: "${fallo?.message}"`);
  }

  if (await saldoReal() === SALDO_INICIAL) ok('el saldo sigue intacto');
  else bad(`el saldo es ${await saldoReal()}, deberia ser ${SALDO_INICIAL}`);

  // ===================================================================
  section('3. Flag Y confirmacion: aqui si se liquida');

  process.env.ALLOW_SIMULATED_WITHDRAWALS = 'true';
  svc = cargarServicio();
  MoneyErrorActual = svc.MoneyError;
  ord = cargarOrdenes();

  note('ALLOW_SIMULATED_WITHDRAWALS=true y confirmarSimulado: true');

  await montarRetiro(ord, 'sim-con-todo');

  let errorLiquidar = null;
  try {
    await svc.paymentService.settleWithdrawal('sim-con-todo', undefined, {
      confirmarSimulado: true,
    });
  } catch (e) {
    errorLiquidar = e;
  }

  if (!errorLiquidar) {
    ok('con las dos condiciones, liquida: el operador puede pagar de verdad a proposito');
  } else {
    bad(`con las dos condiciones NO liquida: ${errorLiquidar.message}`);
  }

  if (await saldoReal() === SALDO_INICIAL - IMPORTE) {
    ok(`el saldo baja a ${SALDO_INICIAL - IMPORTE}: se descontaron ${IMPORTE}`);
  } else {
    bad(`el saldo es ${await saldoReal()}, esperado ${SALDO_INICIAL - IMPORTE}`);
  }

  const ordenLiquidada = await ord.findOne({ orderId: 'sim-con-todo' });
  if (ordenLiquidada.status === 'paid') ok('la orden queda `paid`');
  else bad(`la orden quedo en "${ordenLiquidada.status}"`);

  // ===================================================================
  section('4. En produccion: no hace falta ninguna de las dos');

  // `SIMULATE_PAYMENTS=false` es el modo real. Ahi el retiro se liquida siempre, que
  // es lo que tiene que pasar cuando de verdad hay un pasarela conectada.
  process.env.SIMULATE_PAYMENTS = 'false';
  delete process.env.ALLOW_SIMULATED_WITHDRAWALS;
  svc = cargarServicio();
  MoneyErrorActual = svc.MoneyError;
  ord = cargarOrdenes();

  note('SIMULATE_PAYMENTS=false');

  await montarRetiro(ord, 'prod-normal');

  let errorProd = null;
  try {
    await svc.paymentService.settleWithdrawal('prod-normal');
  } catch (e) {
    errorProd = e;
  }

  if (!errorProd) {
    ok('en produccion liquida sin confirmar nada: es el camino normal');
  } else {
    bad(`en produccion NO liquida: ${errorProd.message}`);
  }

  if (await saldoReal() === SALDO_INICIAL - IMPORTE) {
    ok(`el saldo baja a ${SALDO_INICIAL - IMPORTE}`);
  } else {
    bad(`el saldo es ${await saldoReal()}, esperado ${SALDO_INICIAL - IMPORTE}`);
  }

  // ===================================================================
  section('5. El freno no tapa los otros errores');

  // Un freno mal puesto que se comiera los errores de verdad seria peor que no
  // tenerlo: ocultaria el fallo que de verdad hay que arreglar.
  process.env.SIMULATE_PAYMENTS = 'false';
  svc = cargarServicio();
  MoneyErrorActual = svc.MoneyError;
  ord = cargarOrdenes();

  await montarRetiro(ord, 'saldo-insuficiente');

  // Se vacia la cartera sin tocar la orden: el filtro del `findOneAndUpdate` no
  // cumplira y el retiro tiene que rechazarse por falta de saldo, no por el freno.
  const { User } = require('../dist/models/User');
  await User.updateOne({ telegramId: TELEGRAM_ID }, { $set: { 'balance.real': 100 } });
  await ord.updateOne({ orderId: 'saldo-insuficiente' }, { $set: { status: 'pending' } });

  let errorSaldo = null;
  try {
    await svc.paymentService.settleWithdrawal('saldo-insuficiente');
  } catch (e) {
    errorSaldo = e;
  }

  if (esMoneyError(errorSaldo, MoneyErrorActual) && errorSaldo.status === 409) {
    ok('sin saldo suficiente sigue rechazando, y por el motivo real');
    ok(`"${errorSaldo.message.slice(0, 60)}..."`);
  } else {
    bad(`el rechazo por falta de saldo no se da bien: ${errorSaldo?.message}`);
  }

  // Y una orden ya liquidada.
  await ord.updateOne({ orderId: 'prod-normal' }, { $set: { status: 'paid' } });
  let errorYaPaga = null;
  try {
    await svc.paymentService.settleWithdrawal('prod-normal');
  } catch (e) {
    errorYaPaga = e;
  }

  if (esMoneyError(errorYaPaga, MoneyErrorActual) && errorYaPaga.status === 400) {
    ok('una orden ya liquidada no se liquida dos veces');
  } else {
    bad(`una orden ya pagada no se rechaza bien: ${errorYaPaga?.message}`);
  }

  // Una orden que no existe.
  let errorNoExiste = null;
  try {
    await svc.paymentService.settleWithdrawal('no-existe');
  } catch (e) {
    errorNoExiste = e;
  }

  if (esMoneyError(errorNoExiste, MoneyErrorActual) && errorNoExiste.status === 404) {
    ok('una orden inexistente da 404, no un error genérico');
  } else {
    bad(`una orden inexistente no da 404: ${errorNoExiste?.message}`);
  }

  await finish();
}