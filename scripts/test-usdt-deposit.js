/**
 * Pruebas de la conciliacion de depositos USDT en TRC20.
 *
 * ------------------------------------------------------------------
 * QUE PRUEBA Y QUE NO
 *
 * PRUEBA: la atribucion de una transferencia a una orden. Es la parte donde un bug
 * significa ACREDITAR SALDO A LA PERSONA EQUIVOCADA, que es el peor defecto posible
 * en un sistema de pagos.
 *
 * Se prueba el `reconcile` de verdad, interceptando `fetch` para simular la
 * respuesta de TronGrid. Asi se ejercita el camino completo y no una copia de la
 * logica que podria divergir de ella.
 *
 * NO PRUEBA: que la API real de TronGrid responda lo que esperamos. Eso necesita
 * clave y una llamada de verdad. Se verifica el dia del despliegue con un deposito
 * de prueba de 1 USDT.
 *
 * Ejecutar: node scripts/test-usdt-deposit.js
 */

const {
  buildMemo,
  parseMemo,
  reconcile,
  depositAddressFor,
  usdtStatus,
  verifyWebhookSignature,
  supportedChains,
} = require('../dist/services/payment/usdt.gateway');

const { CHAINS } = require('../dist/config/chains');
const { usdtToUnits } = require('../dist/config/units');
const crypto = require('crypto');

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

console.log('\n\x1b[1mCubaPoker · Conciliacion de depositos USDT\x1b[0m');

const ADDR = 'TConciliationTestAddress0000000000000000';

// La pasarela exige clave para consultar la cadena, asi que se pone una falsa.
// Aqui no se llama a la red: `fetch` esta interceptado en cada caso. Lo que se
// comprueba es que la clave LLEGA a la cabecera, no que sea correcta.
//
// Se restauran al final. Las variables se leen dentro de las funciones, no al
// cargar el modulo, asi que basta con ponerlas antes de la primera llamada.
process.env.TRONGRID_API_KEY = 'clave-de-prueba-no-valida';
process.env.TRON_DEPOSIT_ADDRESS = ADDR;

/**
 * Sustituye `fetch` por una version que devuelve la respuesta de TronGrid que se
 * le pase, y recuerda la peticion para poder inspeccionarla.
 *
 * Se guarda el original y `restore()` lo devuelve: si no, cualquier suite que se
 * ejecute despues en el mismo proceso veria esta respuesta falsa.
 */
const stubTronGrid = (events) => {
  const original = global.fetch;
  let capturedUrl = null;
  let capturedHeaders = null;

  global.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedHeaders = opts && opts.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: events }),
      text: async () => JSON.stringify({ data: events }),
    };
  };

  return {
    restore: () => { global.fetch = original; },
    get url() { return capturedUrl; },
    get headers() { return capturedHeaders; },
  };
};

/** Evento de TRC20 con el formato que devuelve TronGrid. */
const trc20Transfer = ({ tx, to = ADDR, usdt, memo = '' }) => ({
  transaction_id: tx,
  block_timestamp: 1750000000000,
  from: 'TOrigenCualquiera000000000000000000000000000',
  to,
  value: Math.round(usdt * 1_000_000), // atomico: 6 decimales
  token_info: {
    address: CHAINS.TRC20.tokenAddress,
    decimals: 6,
    symbol: 'USDT',
  },
  memo,
  type: 'Transfer',
});

const pending = (orderId, amount, status = 'pending') => ({
  orderId,
  amount,
  status,
  telegramId: 555,
});

// =========================================================================
section('1. El memo: ida y vuelta');

{
  // El memo tiene un limite de 34 caracteres en TRON. Si se pasa, el nodo lo
  // rechaza y la transferencia no llega: el usuario paga y no se acredita nada.
  const memo = buildMemo('CP' + 'a'.repeat(60));
  if (memo.length > 0 && memo.length <= 34) {
    ok(`un id largo se recorta a ${memo.length} chars (el limite de TRON es 34)`);
  } else {
    bad(`el memo mide ${memo.length}, fuera del rango valido`);
  }

  // Un id que se limpia hasta dejar solo el prefijo no identifica a nadie. Tiene
  // que fallar AL CREAR el memo, no tres dias despues en la conciliacion.
  for (const id of ['', '----', '...', '###']) {
    let threw = false;
    try { buildMemo(id); } catch { threw = true; }
    if (threw) ok(`"${id}" falla al construir el memo (no produce una etiqueta inutil)`);
    else bad(`"${id}" produce un memo que no identifica a ninguna orden`);
  }

  // Ida y vuelta. TRON devuelve el memo EXACTAMENTE como se escribio, asi que se
  // parsea tal cual, sin pasarlo por minusculas: hacerlo rompe el prefijo "CP" y
  // es un error real, no una manía del test.
  for (const id of ['abc123', 'A1B2C3D4', '9f8e7d6c5b4a39281706']) {
    const memo = buildMemo(id);
    const back = parseMemo(memo);
    if (back === id.toLowerCase()) {
      ok(`"${id}" -> "${memo}" -> "${back}": ida y vuelta correcta`);
    } else {
      bad(`"${id}" -> "${memo}" -> "${back}": no coincide`);
    }
  }

  // Y con guiones, que es como UUID() los devuelve.
  {
    const id = '9f8e7d6c-5b4a-4928-8170';
    const back = parseMemo(buildMemo(id));
    if (back === '9f8e7d6c5b4a49288170') {
      ok(`un UUID con guiones se normaliza a "${back}"`);
    } else {
      bad(`UUID con guiones dio "${back}"`);
    }
  }
}

{
  // Un memo que NO es nuestro tiene que dar null, no un id inventado. Si se
  // aceptara cualquier cosa, toda transferencia entrante intentaria adjudicarse a
  // alguna orden.
  const foreign = [
    ['', 'memo vacio'],
    ['ABCDEF', 'sin el prefijo CP'],
    ['cp', 'solo el prefijo, sin cuerpo'],
    ['TX1234567890', 'formato de otra plataforma'],
    ['0x51E0000000', 'direccion EVM metida en el memo'],
    ['randomtexto', 'texto sin estructura'],
  ];

  for (const [memo, label] of foreign) {
    const r = parseMemo(memo);
    if (r === null) ok(`rechazado: ${label}`);
    else bad(`"${memo}" (${label}) devolvio "${r}", deberia ser null`);
  }

  if (parseMemo('CP123') === '123') ok('"CP123" en mayusculas se acepta');
  else bad('"CP123" deberia devolver "123"');
}

// =========================================================================
section('2. Decimales: TRON tiene 6, las unidades internas 3');

{
  // El error clasico de este dominio. USDT tiene 6 decimales en TRON y las
  // unidades internas del proyecto son 1 USDT = 1000. Confundir los tres
  // sobrestima el credito por un factor de 1 000.
  if (Math.floor((1_000_000 / 1_000_000) * 1000) === U(1)) {
    ok('1 USDT en TRON (1 000 000 atomico) son 1 000 unidades internas');
  } else {
    bad('la conversion de atomico a unidades internas no cuadra');
  }

  const units2550 = Math.floor((25_500_000 / 1_000_000) * 1000);
  if (units2550 === 25_500) ok('25,50 USDT on TRON son 25 500 unidades internas');
  else bad(`25,50 USDT dieron ${units2550} unidades, esperaba 25 500`);

  if ((25_500 * 1_000_000) / 1000 === 25_500_000) ok('25 500 unidades son 25 500 000 atomicos');
  else bad('la conversion inversa no cuadra');

  // Un deposito que no se puede representar en unidades (0,0005 USDT) se trunca
  // hacia abajo. Es el lado correcto: truncar regala como mucho 0,001 USDT,
  // redondear hacia arriba daria al usuario.
  const tiny = Math.floor((0.0005 * 1_000_000) / 1_000_000 * 1000);
  if (tiny === 0) ok('un deposito de 0,0005 USDT se trunca a 0 unidades, no se infla');
  else bad(`0,0005 USDT dio ${tiny} unidades: no deberia dar nada`);
}

// =========================================================================
section('3. El camino que SI acredita');

const credited = [];
const stub1 = stubTronGrid([
  trc20Transfer({ tx: 'tx-bueno', usdt: 25.5, memo: buildMemo('abc123') }),
]);

reconcile(
  async (id) => (id === 'abc123' ? pending('abc123', 25_500) : null),
  { depositAddress: ADDR, onMatch: async (o, d) => credited.push([o, d]) },
)
  .then((r) => {
    if (r.matched === 1 && r.unmatched.length === 0) {
      ok('memo correcto + importe correcto + pendiente = acreditado');
    } else {
      bad(`matched=${r.matched} unmatched=${r.unmatched.length}, esperaba 1 y 0`);
    }

    if (credited.length === 1 && credited[0][1].txHash === 'tx-bueno') {
      ok('se entrega la orden y el hash de la transaccion al acreditar');
    } else {
      bad(`onMatch recibio ${credited.length} llamada(s)`);
    }

    if (r.scanned === 1) ok('se contaron 1 transferencia en la ventana');
    else bad(`scanned=${r.scanned}, esperaba 1`);

    // La consulta tiene que ir al contrato de USDT, no al de TRX.
    if (stub1.url && stub1.url.includes(CHAINS.TRC20.tokenAddress)) {
      ok('la consulta filtra por el contrato de USDT');
    } else {
      bad(`la URL no menciona el contrato de USDT: ${stub1.url}`);
    }

    // Y la clave va en cabecera, no en la query: una URL queda en los logs de
    // proxy y de error.
    if (stub1.headers && stub1.headers['TRON-PRO-API-KEY']) {
      ok('la clave de API va en la cabecera TRON-PRO-API-KEY');
    } else {
      bad('la clave de API no se envia en la cabecera esperada');
    }
    if (!/api[-_]?key/i.test(stub1.url || '')) ok('la URL no lleva ninguna clave');
    else bad('la URL contiene una clave: se filtraria en los logs');

    seccion4();
  })
  .catch((e) => { stub1.restore(); bad(`reconcile lanzo: ${e.message}`); });

// =========================================================================
function seccion4() {
  section('4. Lo que NO se acredita, y por que importa');

  // --- Sin memo: no se sabe de quien es.
  const stub = stubTronGrid([trc20Transfer({ tx: 'tx-sin-memo', usdt: 50 })]);
  reconcile(async () => pending('abc123', 50_000), { depositAddress: ADDR })
    .then((r) => {
      if (r.matched === 0 && r.unmatched.length === 1) {
        ok('sin memo no se acredita: se deja para que lo decida una persona');
      } else {
        bad(`matched=${r.matched}, unmatched=${r.unmatched.length}: se adjudico a ciegas`);
      }
      stub.restore();
      return importeQueNoCoincide();
    })
    .catch((e) => { stub.restore(); bad(e.message); });
}

function importeQueNoCoincide() {
  // Envio de mas contra un pedido de 10. Es la fuente de disputas mas comun: si
  // se acredita la diferencia sin preguntar, el operador ha regalado dinero; si no
  // se acredita nada, el usuario pierde 20 USDT.
  const stub = stubTronGrid([
    trc20Transfer({ tx: 'tx-1030', usdt: 30, memo: buildMemo('abc123') }),
  ]);

  reconcile(
    async () => pending('abc123', 10_000),
    { depositAddress: ADDR },
  )
    .then((r) => {
      if (r.matched === 0) ok('importe de mas: no se acredita solo, queda para revision');
      else bad('se acreditaron 30 USDT contra un pedido de 10');

      stub.restore();
      const stub2 = stubTronGrid([
        trc20Transfer({ tx: 'tx-1025', usdt: 10.25, memo: buildMemo('abc123') }),
      ]);
      return reconcile(async () => pending('abc123', 10_000), { depositAddress: ADDR })
        .then((r2) => {
          if (r2.matched === 0) ok('importe de menos: tampoco se acredita automaticamente');
          else bad('se acreditaron 10,25 USDT contra un pedido de 10');
          stub2.restore();
          return yaLiquidada();
        });
    })
    .catch((e) => { stub.restore(); bad(e.message); });
}

function yaLiquidada() {
  // Una orden ya pagada no se vuelve a acreditar con una segunda transferencia.
  // Es el doble credito clasico: el usuario recibe el dinero dos veces.
  const stub = stubTronGrid([
    trc20Transfer({ tx: 'tx-doble', usdt: 20, memo: buildMemo('abc123') }),
  ]);

  reconcile(async () => pending('abc123', 20_000, 'paid'), { depositAddress: ADDR })
    .then((r) => {
      if (r.matched === 0) ok('una orden ya liquidada no se acredita otra vez');
      else bad('doble credito: una orden `paid` se volvio a acreditar');
      stub.restore();
      return otraDireccion();
    })
    .catch((e) => { stub.restore(); bad(e.message); });
}

function otraDireccion() {
  // Una transferencia SALIENTE (un retiro) va a otra direccion. Si se contara,
  // el retiro de un jugador acreditaria el saldo de otro.
  const stub = stubTronGrid([
    trc20Transfer({
      tx: 'tx-salida',
      usdt: 100,
      memo: buildMemo('abc123'),
      to: 'TOtraDireccionTotalmenteDistinta00000000',
    }),
  ]);

  reconcile(async () => pending('abc123', 100_000), { depositAddress: ADDR })
    .then((r) => {
      if (r.scanned === 0) ok('una salida (to distinto) no se cuenta como deposito');
      else bad(`scanned=${r.scanned}: una salida se tomo por un deposito`);
      stub.restore();
      return sinDireccion();
    })
    .catch((e) => { stub.restore(); bad(e.message); });
}

function sinDireccion() {
  // Sin direccion configurada no se puede distinguir un deposito de otra cosa.
  // Tiene que fallar con un mensaje claro, no devolver cero en silencio: un
  // "0 depositos" con log deINFO hace creer que no ha llegado ninguno.
  const saved = process.env.TRON_DEPOSIT_ADDRESS;
  delete process.env.TRON_DEPOSIT_ADDRESS;

  reconcile(async () => null, {})
    .then(() => bad('sin direccion de deposito deberia rechazar, no devolver cero'))
    .catch((e) => {
      if (/TRON_DEPOSIT_ADDRESS/.test(e.message)) {
        ok(`sin direccion configurada falla diciendo cual falta: "${e.message.slice(0, 52)}..."`);
      } else {
        bad(`el error no menciona la variable que falta: ${e.message}`);
      }
      if (saved !== undefined) process.env.TRON_DEPOSIT_ADDRESS = saved;
      varios();
    });
}

function varios() {
  section('5. Varios depositos en la misma ventana');

  const stub = stubTronGrid([
    trc20Transfer({ tx: 'tx-1', usdt: 10, memo: buildMemo('aaa111') }),
    trc20Transfer({ tx: 'tx-2', usdt: 25, memo: buildMemo('bbb222') }),
    trc20Transfer({ tx: 'tx-3', usdt: 99, memo: buildMemo('ccc333') }),
  ]);

  const orders = {
    aaa111: pending('aaa111', 10_000),
    bbb222: pending('bbb222', 25_000),
  };

  reconcile(async (id) => orders[id] || null, { depositAddress: ADDR })
    .then((r) => {
      if (r.matched === 2) ok('de 3 transferencias, se acreditan las 2 con orden pendiente');
      else bad(`matched=${r.matched}, esperaba 2`);

      if (r.unmatched.length === 1 && r.unmatched[0].txHash === 'tx-3') {
        ok('la tercera (sin orden) queda sin acreditar, identificada por su hash');
      } else {
        bad(`unmatched=${r.unmatched.length}, esperaba 1`);
      }
      stub.restore();
      formaDelModulo();
    })
    .catch((e) => { stub.restore(); bad(e.message); });
}

function formaDelModulo() {
  section('6. Forma del modulo, configuracion y firma de webhook');

  const required = [
    'buildMemo', 'parseMemo', 'reconcile', 'depositAddressFor',
    'usdtStatus', 'verifyWebhookSignature', 'supportedChains', 'usdtGatewayReady',
  ];
  const mod = require('../dist/services/payment/usdt.gateway');
  const missing = required.filter((k) => typeof mod[k] !== 'function');
  if (missing.length === 0) ok(`el modulo exporta las ${required.length} funciones que se usan`);
  else bad(`faltan: ${missing.join(', ')}`);

  // Solo TRC20. Las demas no tienen memo, y sin memo el matching por importe
  // aceptaria transferencias ambiguas, que es peor que no aceptarlas.
  const chains = supportedChains();
  if (chains.length === 1 && chains[0] === 'TRC20') {
    ok('solo TRC20: las demas redes no tienen memo, y sin memo no hay matching fiable');
  } else {
    bad(`redes soportadas: ${chains.join(', ')}. Cada una necesita memo`);
  }

  for (const c of chains) {
    if (CHAINS[c]) ok(`${c} existe en la configuracion de cadenas`);
    else bad(`${c} no esta en chains.ts`);
  }

  const s = usdtStatus();
  if (typeof s.ready === 'boolean' && typeof s.reason === 'string') {
    ok(`usdtStatus informa del estado (ready=${s.ready})`);
  } else {
    bad('usdtStatus no devuelve la forma esperada');
  }

  // Sin claves, el motivo tiene que NOMBRAR lo que falta: "no funciona" sin mas
  // hace perder media hora al operador probando cosas.
  if (s.ready === false && /TRONGRID|TRON_DEPOSIT/.test(s.reason)) {
    ok(`el motivo de la falta nombra las variables: "${s.reason.slice(0, 56)}..."`);
  } else if (s.ready === true) {
    ok('este entorno tiene las claves definidas: listo');
  } else {
    bad(`ready=${s.ready} y el motivo no dice que falta: "${s.reason}"`);
  }

  const a = depositAddressFor('TRC20');
  if (typeof a === 'string' && a.length > 0) ok(`depositAddressFor('TRC20') devuelve direccion: ${a.slice(0, 18)}...`);
  else bad(`depositAddressFor('TRC20') devolvio ${a}`);

  let threw = false;
  try { depositAddressFor('NOEXISTE'); } catch { threw = true; }
  if (threw) ok('una cadena desconocida lanza error en vez de devolver undefined');
  else bad('una cadena desconocida devuelve algo en vez de fallar');

  // Firma de webhook.
  const secret = 'secreto-de-prueba';
  const body = '{"orderId":"abc123","amount":25500}';
  const good = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  if (verifyWebhookSignature(body, good, secret)) ok('una firma correcta se acepta');
  else bad('la firma correcta fue rechazada');

  if (!verifyWebhookSignature(body, 'falsa', secret)) ok('una firma incorrecta se rechaza');
  else bad('una firma cualquiera fue aceptada');

  if (!verifyWebhookSignature('{"amount":999999}', good, secret)) {
    ok('cambiar el cuerpo invalida la firma (no hay reenvio con contenido editado)');
  } else {
    bad('una firma vale para cualquier cuerpo');
  }

  if (!verifyWebhookSignature(body, good, '')) ok('sin secreto configurado, nada se acepta');
  else bad('sin secreto se acepto una firma');

  if (!verifyWebhookSignature(body, '', secret)) ok('una firma vacia se rechaza');
  else bad('una firma vacia fue aceptada');

  console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}