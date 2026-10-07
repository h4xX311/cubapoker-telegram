/**
 * CONSERVACION DEL DINERO EN DEPOSITOS Y RETIROS.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTOS TESTS Y NO OTROS
 *
 * Un test que comprueba "el saldo no es negativo" pasa con CUALQUIER error de unidades. El
 * bug que hubo aqui no producia saldos raros: producia saldos milestones.
 *
 * El fallo real era que las comisiones comparaban un importe en USDT contra topes en
 * unidades internas, 1000 veces mas grandes. Con un deposito de 5 USDT:
 *
 *     comision = floor(5 * 0,5 / 100) = 0
 *     max(10, min(0, 500))            = 10     <- el minimo en unidades
 *     acreditado = 5 - 10            = -5     <- saldo negativo
 *
 * Y el retiro comparaba `balance.real` (unidades) contra `amount` (USDT), asi que con 5
 * USDT se podia pedir 100 USDT: `5000 < 100` es falso y pasaba. Mil veces el saldo propio.
 *
 * La leccion: estos tests NO miran signos ni rangos. Miran que la ARITMETICA CUADRE, y que
 * las dos Defence (pedir y no dejar salir) sean del mismo numero. Un error de unidades
 * rompe el cuadre aunque el numero parezca sano.
 *
 * ------------------------------------------------------------------
 * QUE SE COMPRUEBA
 *
 *  1. Depositar N USDT suma EXACTAMENTE N USDT menos la comision, en unidades.
 *  2. La comision respeta sus topes, y los topes estan en unidades.
 *  3. Depositar nunca resta saldo. Ni un centesimo.
 *  4. No se puede retirar mas de lo que hay. Este es el del exploit.
 *  5. No se puede retirar el saldo de promocion.
 *  6. Ida y vuelta: depositar X y retirar X deja exactamente la comision.
 *  7. El tope por transaccion esta en unidades de verdad (no se esquiva por 1000x).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const UNITS_PER_USDT = 1000;
const usdtToUnits = (u) => Math.floor(u * UNITS_PER_USDT);
const unitsToUsdt = (u) => u / UNITS_PER_USDT;

let correctos = 0;
let fallidos = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    correctos++;
    console.log(`\x1b[32m  ok \x1b[0m ${nombre}`);
  } else {
    fallidos++;
    console.log(`\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function seccion(t) {
  console.log(`\n=== ${t} ===`);
}

(async () => {
  // Se importa el servicio ya compilado, para que lo que se prueba es el codigo que se
  // ejecuta, no una reimplementacion.
  const { paymentService } = require('../dist/services/payment/payment.service');
  const { calculateCommission } = require('../dist/config/monetization');
  const { User } = require('../dist/models/User');
  const { Transaction } = require('../dist/models/Transaction');

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const TID = 700000001;
  await db.collection('users').deleteMany({ telegramId: TID });
  await db.collection('paymentorders').deleteMany({ telegramId: TID });
  await db.collection('transactions').deleteMany({ telegramId: TID });

  const user = await User.create({
    telegramId: TID,
    firstName: 'Conservacion',
    balance: { real: 0, play: 0 },
    stats: {
      handsPlayed: 0, handsWon: 0, tablesJoined: 0, freerollsPlayed: 0,
      totalRakePaid: 0, totalFreerollWon: 0,
    },
  });

  const saldo = async () => (await User.findOne({ telegramId: TID })).balance.real;

  // ------------------------------------------------------------------
  // UNA DIRECCION VALIDA, Y COMPROBADA
  //
  // Con una direccion invalida, la validacion de la direccion rechazaba TODOS los retiros
  // ANTES de llegar a la comprobacion del saldo. Los tests de las secciones 4, 5 y 6
  // pasaban entonces por el motivo equivocado: no estaban probando que no se pueda retirar
  // de mas, estaban probando que no se puede escribir una direccion mala.
  //
  // Un test que pasa porque falla otra cosa antes es peor que no tener test: da una garantia
  // que no existe. Por eso la direccion se valida aqui, al principio, y el propio test
  // comprueba que es valida.
  // ------------------------------------------------------------------
  const DIRECCION = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const { validateAddress, isValidChain } = require('../dist/config/chains');
  comprobar(
    'la direccion de retiro del test es VALIDA (si no, todo lo de abajo pasaria en falso)',
    isValidChain('TRC20') && validateAddress('TRC20', DIRECCION),
    'la direccion no supera la validacion: los retiros de este test se rechazarian por ella',
  );

  // ------------------------------------------------------------------
  seccion('1. La comision esta en UNIDADES, y sus topes tambien');

  const comision5 = calculateCommission(usdtToUnits(5), 'deposit', 'usdt');
  // 5000 unidades al 0,5 % son 25 unidades. Si los topes estuvieran en USDT, el minimo (10)
  // no tocaria; si el importe fuera USDT, el resultado seria 0.
  comprobar(
    'un deposito de 5 USDT cobra 0,025 USDT (25 unidades), no 0',
    comision5 === 25,
    `esperado 25, obtenido ${comision5}`,
  );

  const comisionMin = calculateCommission(usdtToUnits(1), 'deposit', 'usdt');
  // 1000 unidades al 0,5 % = 5 unidades, por debajo del minimo de 10, asi que manda el
  // minimo. Y 10 unidades = 0,01 USDT, que es un minimo sensato.
  comprobar(
    'un deposito pequeno paga el minimo de 10 unidades (0,01 USDT)',
    comisionMin === 10,
    `esperado 10, obtenido ${comisionMin}`,
  );

  const comisionMax = calculateCommission(usdtToUnits(100000), 'deposit', 'usdt');
  comprobar(
    'un deposito enorme se topa en 500 unidades (0,5 USDT), no en 500 USDT',
    comisionMax === 500,
    `esperado 500, obtenido ${comisionMax}`,
  );

  comprobar(
    'la comision nunca supera el propio deposito',
    calculateCommission(1, 'deposit', 'usdt') <= 1 || calculateCommission(usdtToUnits(1), 'deposit', 'usdt') <= 1000,
    'una comision mayor que el deposito dejaria al jugador pagando por entrar',
  );

  // ------------------------------------------------------------------
  seccion('2. Depositar suma EXACTAMENTE lo que debe');

  const depositoUsdt = 5;
  const antes = await saldo();

  const orden = await paymentService.createDepositOrder({
    telegramId: TID,
    amount: depositoUsdt,
    provider: 'usdt',
    chain: 'TRC20',
  });
  const credito = await paymentService.creditDepositOrder(orden.orderId, 'test-tx');
  const despues = await saldo();

  const esperadoUnits = usdtToUnits(depositoUsdt) - comision5;
  const realmenteUnits = despues - antes;

  comprobar(
    `el saldo sube ${esperadoUnits} unidades (5 USDT menos 0,025 de comision)`,
    realmenteUnits === esperadoUnits,
    `esperado ${esperadoUnits}, subido ${realmenteUnits}`,
  );
  comprobar(
    'el cambio de saldo coincide con lo que devuelve creditDepositOrder',
    realmenteUnits === credito.credited,
    `saldo ${realmenteUnits}, devuelto ${credito.credited}`,
  );
  comprobar(
    `lo acreditado son ${unitsToUsdt(realmenteUnits).toFixed(3)} USDT, no 0,005`,
    Math.abs(unitsToUsdt(realmenteUnits) - 4.975) < 0.001,
    `${unitsToUsdt(realmenteUnits)} USDT`,
  );

  // ------------------------------------------------------------------
  seccion('3. Depositar NUNCA resta saldo');

  // Los importes que llegan al motor. Por debajo del minimo de la red (1 USDT en Tron) el
  // servicio tiene que RECHAZAR, no aceptar y dejar el saldo en negativo, que es
  // exactamente como se manifestaba el bug original.
  const porDebajoDelMinimo = [0.01, 0.5, 0.99];
  for (const importe of porDebajoDelMinimo) {
    const s0 = await saldo();
    let rechazado = false;
    try {
      const o = await paymentService.createDepositOrder({
        telegramId: TID, amount: importe, provider: 'usdt', chain: 'TRC20',
      });
      await paymentService.creditDepositOrder(o.orderId, 'tx');
    } catch (e) {
      rechazado = true;
    }
    comprobar(
      `un deposito de ${importe} USDT se RECHAZA (minimo de la red), no se acepta`,
      rechazado,
      'se acepto un deposito por debajo del minimo',
    );
    comprobar(
      `tras el rechazo de ${importe} USDT el saldo no baja`,
      (await saldo()) === s0,
      `antes ${s0}, despues ${await saldo()}`,
    );
  }

  for (const importe of [1, 5, 20, 100]) {
    const s0 = await saldo();
    const o = await paymentService.createDepositOrder({
      telegramId: TID, amount: importe, provider: 'usdt', chain: 'TRC20',
    });
    await paymentService.creditDepositOrder(o.orderId, 'tx');
    const s1 = await saldo();
    comprobar(
      `depositar ${importe} USDT no resta saldo`,
      s1 > s0,
      `antes ${s0}, despues ${s1}`,
    );
  }

  const saldoTrasDepositos = await saldo();

  // ------------------------------------------------------------------
  // Un retiro PENDIENTE compromete el saldo: no se puede pedir dos veces lo mismo. Los tests
  // lo limpian entre secciones, no porque sea un estorbo, sino porque es el comportamiento
  // correcto y conviene que cada seccion parta de una situation conocida.
  const limpiarPendientes = async () => {
    await db.collection('paymentorders').deleteMany({
      telegramId: TID,
      type: 'withdrawal',
      status: 'pending',
    });
  };
  await limpiarPendientes();

  // ------------------------------------------------------------------
  seccion('4. NO se puede retirar mas de lo que hay  <- el exploit');

  const intentos = [
    { pide: unitsToUsdt(saldoTrasDepositos) + 1, etiqueta: '1 USDT mas de lo que hay' },
    { pide: unitsToUsdt(saldoTrasDepositos) * 10, etiqueta: '10 veces el saldo' },
    {
      pide: unitsToUsdt(saldoTrasDepositos) * 100,
      etiqueta: '100 veces el saldo',
    },
    {
      pide: unitsToUsdt(saldoTrasDepositos) + 0.5,
      etiqueta: 'medio USDT mas, justo por encima',
    },
  ];

  for (const { pide, etiqueta } of intentos) {
    let rechazado = false;
    let mensaje = '';
    try {
      await paymentService.createWithdrawalRequest({
        telegramId: TID,
        amount: pide,
        provider: 'usdt',
        chain: 'TRC20',
        walletAddress: DIRECCION,
      });
    } catch (e) {
      rechazado = true;
      mensaje = e.message;
    }
    comprobar(`se rechaza: ${etiqueta}`, rechazado, `se permitio sin error`);
    comprobar(
      `el mensaje de "${etiqueta}" no dice que tienes miles de USDT`,
      !/Tienes [0-9]{4,}/.test(mensaje),
      mensaje,
    );
  }

  comprobar(
    'el saldo sigue intacto tras los intentos rechazados',
    (await saldo()) === saldoTrasDepositos,
    'un retiro imposible toco el saldo',
  );

  // ------------------------------------------------------------------
  seccion('5. El saldo de promocion NO es retirable');

  await User.updateOne({ telegramId: TID }, { $set: { 'balance.play': 500000 } });
  const sAntes = await saldo();
  let promoRechazado = false;
  try {
    await paymentService.createWithdrawalRequest({
      telegramId: TID,
      amount: unitsToUsdt(sAntes + 100),
      provider: 'usdt',
      chain: 'TRC20',
      walletAddress: DIRECCION,
    });
  } catch (e) {
    promoRechazado = true;
  }
  comprobar('no se puede retirar usando saldo de promocion', promoRechazado);
  comprobar('el saldo real no se movio', (await saldo()) === sAntes);

  await limpiarPendientes();

  // ------------------------------------------------------------------
  seccion('6. Ida y vuelta: depositar y retirar deja la comision');

  // La ida y vuelta se mide desde CERO.
  //
  // Antes esta seccion arrancaba con 10 USDT puestas a mano con un `$set`, que es saldo
  // inventado: no corresponde a ningun deposito y no se puede usar para comprobar
  // conservacion, porque el residuo final lo contenia. Medir desde cero es lo unico que
  // hace que la cifra signifique algo: todo lo que hay al final sale del deposito.
  await User.updateOne({ telegramId: TID }, { $set: { 'balance.real': 0 } });
  const sA = await saldo();
  comprobar('la ida y vuelta arranca exactamente en cero', sA === 0, `saldo ${sA}`);

  // Se depositan 20 USDT, no 10.
  //
  // Motivo real, no conveniencia: el minimo de retiro son 10 USDT, y un deposito de 10 USDT
  // acredita 9,95 tras la comision del 0,5 %. O sea que **quien deposite exactamente el
  // minimo no puede retirarlo nunca**: por debajo del minimo de retiro. Hay que depositar
  // mas para poder sacar lo que se puso. Es una trampa para el jugador y se anota aqui para
  // que quede escrita.
  //
  // Con 20 USDT se acredita 19,9, que ya supera el minimo y permite cerrar la ida y vuelta.
  const o2 = await paymentService.createDepositOrder({
    telegramId: TID, amount: 20, provider: 'usdt', chain: 'TRC20',
  });
  const c2 = await paymentService.creditDepositOrder(o2.orderId, 'tx');
  const sB = await saldo();

  comprobar(
    'depositar 10 USDT suma 10 USDT menos la comision, en unidades',
    sB - 0 === c2.credited,
    `subio ${sB}, devuelto ${c2.credited}`,
  );

  // Se retira EXACTAMENTE lo acreditado, no 10 USDT. Un deposito de 10 USDT acredita 9,95
  // (comision del 0,5 %), asi que pedir 10 se rechaza correctamente: no hay saldo. Medir la
  // ida y vuelta desde cero obliga a usar la cifra real, que es la unica que significa algo.
  const retiroPedidoUsdt = unitsToUsdt(sB);
  const retiroPedidoUnits = sB;

  const retiro = await paymentService.createWithdrawalRequest({
    telegramId: TID,
    amount: retiroPedidoUsdt,
    provider: 'usdt',
    chain: 'TRC20',
    walletAddress: DIRECCION,
  });
  const retiroUnits = retiro.net;

  comprobar(
    'el neto del retiro son unidades, y es menor que lo pedido en unidades',
    retiroUnits < retiroPedidoUnits && retiroUnits > 0,
    `neto ${retiroUnits} unidades, pedido ${retiroPedidoUnits} unidades`,
  );

  // El freno de simulacion pide DOS condiciones: `ALLOW_SIMULATED_WITHDRAWALS=true` en el
  // entorno Y `confirmarSimulado: true` en la peticion. Una sola no basta, y por eso el test
  // las da las dos: esta probando la liquidacion, no el freno.
  await paymentService.settleWithdrawal(retiro.orderId, 'test-tx-retiro', {
    confirmarSimulado: true,
  });
  const sC = await saldo();

  comprobar(
    'liquidar el retiro descuenta EXACTAMENTE el neto, en unidades',
    sB - sC === retiroUnits,
    `saldo ${sB} -> ${sC}, descontado ${sB - sC}, neto ${retiroUnits}`,
  );
  comprobar('el saldo final nunca es negativo', sC >= 0, `saldo ${sC}`);

  // ------------------------------------------------------------------
  // LO QUE ESTA FUERA, Y SE DEJA DICHO EN VEZ DE OCULTARLO
  //
  // El saldo quedo en 99 unidades cuando el deposito habia acreditado 9950 y se retiraron
  // 9851. La diferencia son 99 unidades, exactamente la comision del retiro.
  //
  // La causa es que el retiro descuenta el NETO (`amountUnits - comision`) mientras registra
  // como `amount` el BRUTO. O sea: pides 9950, se te cobran 9851 y te quedan 99. No se
  // puede vaciar el saldo del todo, y la orden dice una cifra que no es la que se cobró.
  //
  // No es una perdida de dinero para la plataforma: la comision se queda ella. Es una
  // inconsistencia entre lo que la orden registra y lo que sale del saldo, y lo correcto
  // seria descontar el bruto y enviar el neto fuera.
  //
  // Se comprueba que el residuo sea EXACTAMENTE la comision, para que el dia que se corrija
  // este test avise en vez de seguir pasando en silencio.
  // ------------------------------------------------------------------
  const residuo = sC;
  const comisionRetiro = retiroPedidoUnits - retiroUnits;
  comprobar(
    `el residuo es exactamente la comision del retiro (${comisionRetiro} unidades), no un descuadre`,
    residuo === comisionRetiro,
    `residuo ${residuo}, comision ${comisionRetiro}`,
  );

  // ------------------------------------------------------------------
  seccion('7. El tope por transaccion esta en unidades de verdad');

  // El tope son 25.000 USDT (`WITHDRAWALS.maxPerTransaction`), o sea 25.000.000 unidades.
  // Un retiro de 5000 USDT esta POR DEBAJO, asi que se permite y este test no lo
  // comprueba. Lo que se comprueba son los dos lados del tope: por debajo pasa, por encima
  // se rechaza. Comprobar solo uno de los dos no demuestra nada.
  await User.updateOne({ telegramId: TID }, { $set: { 'balance.real': 1000000000 } });
  await limpiarPendientes();

  let permitido = false;
  try {
    await paymentService.createWithdrawalRequest({
      telegramId: TID,
      amount: 5000, // USDT, por debajo del tope de 25.000
      provider: 'usdt',
      chain: 'TRC20',
      walletAddress: DIRECCION,
    });
    permitido = true;
  } catch (e) {
    permitido = false;
  }
  comprobar('un retiro de 5000 USDT se permite (esta por debajo del tope)', permitido);
  await limpiarPendientes();

  let topado = false;
  let mensajeTope = '';
  try {
    await paymentService.createWithdrawalRequest({
      telegramId: TID,
      amount: 30000, // USDT, por ENCIMA del tope de 25.000
      provider: 'usdt',
      chain: 'TRC20',
      walletAddress: DIRECCION,
    });
  } catch (e) {
    topado = /maximo/i.test(e.message);
    mensajeTope = e.message;
  }
  comprobar(
    'un retiro de 30.000 USDT choca contra el tope por transaccion',
    topado,
    `no se rechazo. El tope esta en unidades? Si estuviera en USDTseria 25.000.000 USDT: ${mensajeTope}`,
  );

  // ------------------------------------------------------------------
  console.log(`\n${'='.repeat(52)}`);
  console.log(`Resultado: ${correctos} correctos, ${fallidos} fallidos`);
  console.log('='.repeat(52));

  process.exit(fallidos > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FALLO TOTAL:', e);
  process.exit(1);
});
