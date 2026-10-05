import crypto from 'crypto';
import { CHAINS, DEPOSIT_ADDRESSES, isValidChain, type ChainId } from '../../config/chains';
import { logger } from '../../utils/logger';

/**
 * Lo minimo de una orden que este modulo necesita.
 *
 * NO se importa el modelo de mongoose aqui a proposito. Si se importara, este
 * modulo no se podria ejecutar sin conexion, y su parte interesante (parsear el
 * memo, decidir cuando una transferencia se puede atribuir) es justo lo que hay
 * que poder probar sin base de datos. El patron es el mismo que en
 * `field.atomic.ts`: la aritmetica y las decisiones fuera, la base de datos dentro.
 */
export interface PendingOrder {
  orderId: string;
  /** Importe esperado, en unidades internas. */
  amount: number;
  status: string;
  telegramId: number;
}

/**
 * Pasarela USDT real: vigilancia de la cadena.
 *
 * ------------------------------------------------------------------
 * QUE HACE Y QUE NO HACE
 *
 * La version simulada (en `gateway.ts`) acredita el saldo cuando el operador o el
 * propio usuario pulsan un boton. Esta no: vigila la cadena, encuentra las
 * transferencias que llegan a las direcciones de deposito, y las liga a las ordenes
 * pendientes.
 *
 * ------------------------------------------------------------------
 * POR QUE EL MATCHING ES POR MEMO Y NO POR DIRECCION UNICA
 *
 * Si todas las ordenes compartieran una sola direccion de deposito, no habria
 * forma de saber a quien pertenece cada transferencia: el usuario que espera por
 * 10 USDT y el que espera por 25 podrian recibir a la vez, o el sistema tendria que
 * repartir a ciegas. Es un problema real de los exchanges de cripto que no usan
 * memo/tag.
 *
 * TRON resuelve esto con los **memo (tag)**: al enviar a una direccion de TRON se
 * puede anadir un tag de 34 caracteres que viaja con la transferencia. Cada orden
 * recibe su propio tag, y el matching es exacto. Por eso TRC20 es la red por la
 * que hay que empezar:
 *
 *   - EVM (ERC20, BEP20, Polygon) NO tiene memo. Alli hay que usar una direccion
 *     distinta por orden, lo que significa cientos de direcciones vigiladas, o
 *     aceptar el matching por importe con sus errores.
 *   - Solana tampoco tiene memo util para este caso.
 *
 * Asi que la implementacion cubre TRC20 de verdad y, para las demas, devuelve un
 * error explicito en vez de fingir que funciona. Un sistema de pagos que parece
 * funcionar y no funciona es peor que uno que dice "esto no esta soportado".
 *
 * ------------------------------------------------------------------
 * LO QUE NECESITA PARA FUNCIONAR
 *
 *   - `TRONGRID_API_KEY`: clave de TronGrid (https://trongrid.io).
 *   - `TRON_DEPOSIT_ADDRESS`: la direccion TRON de la plataforma, en base58.
 *
 * Sin la clave, `isConfigured()` devuelve false y la pasarela se niega a crear
 * ordenes, en vez de crearlas que nunca se van a confirmar.
 */

const TRONGRID_BASE = 'https://api.trongrid.io';

/**
 * Las variables de entorno se leen DENTRO de cada funcion, no al cargar el modulo.
 *
 * Es a proposito. Si se leyeran aqui (`const KEY = process.env.X`), el valor se
 * congelaria al importar el fichero, y eso rompe dos cosas:
 *
 *  - Los tests no pueden probar a la vez los caminos de "falta la clave" y "esta
 *    definida", que es justamente lo que hay que comprobar.
 *  - Un despliegue que rota la clave en caliente (que es lo normal) necesitaria
 *    reiniciar el servicio entero, con un campo en juego.
 */
const apiKey = (): string => process.env.TRONGRID_API_KEY || '';
const depositAddress = (): string => process.env.TRON_DEPOSIT_ADDRESS || '';
const usdtContract = (): string =>
  process.env.USDT_CONTRACT_ADDRESS || CHAINS.TRC20.tokenAddress;

/** Cuanto tiempo se espera a la confirmacion de una retirada. */
const TRON_CONFIRMATIONS = 19; // ~1 minuto

/** Ventana de busqueda maxima hacia atras, en microsegundos (epoch de TRON). */
const TRON_LOOKBACK_US = 3_600_000_000; // 1 hora

interface TronTransferEvent {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: number;
  token_info?: {
    address: string;
    decimals: number;
    symbol: string;
  };
  memo?: string;
  type: string;
}

export const usdtGatewayReady = (): boolean => {
  return Boolean(apiKey() && depositAddress());
};

/**
 * Convierte un memo de TRON a una etiqueta nuestra.
 *
 * El memo no puede ser arbitrario si queremos recuperarlo sin ambiguedad, asi que
 * se codifica el id de la orden dentro de los 34 caracteres disponibles. Un tag
 * legible es mejor para el usuario: si alguien quiere verificar el deposito a mano,
 * ve algo parecido a `CP1234ABCD` y no un numero de 34 digitos.
 */
export const buildMemo = (orderId: string): string => {
  const clean = orderId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 32);
  const memo = `CP${clean}`.slice(0, 34);

  // Un id que se limpia hasta dejar solo "CP" no identifica a nadie, asi que se
  // lanza aqui y no en el momento de la conciliacion, donde el error llegaria
  // tarde y sin relacion apparent con su causa. Los ids los genera esta propia
  // plataforma, asi que un id vacio es un bug de programacion, no entrada de
  // usuario: es mejor que se vea al arrancar.
  if (memo.length <= 2) {
    throw new Error(
      `buildMemo: el id "${orderId}" no deja ningun caracter utilizable para el memo.`,
    );
  }

  return memo;
};

/**
 * Lee el id de orden de un memo.
 *
 * Devuelve `null` si el memo no es nuestro. La comprobacion es que empiece por
 * `CP`: un memo de otro servicio que pasara por la misma direccion no debe
 *isodesignarse a ninguna orden nuestra.
 */
export const parseMemo = (memo: string): string | null => {
  if (!memo || !memo.startsWith('CP')) return null;
  const body = memo.slice(2);
  if (body.length === 0) return null;

  // En minusculas porque `buildMemo` pone el prefijo y el cuerpo en mayusculas y
  // los ids de orden se guardan en minusculas: es la unica normalizacion que hace
  // que la ida y la vuelta coincidan.
  //
  // OJO: la comparacion del PREFIJO es sensible a mayusculas a proposito. TRON
  // devuelve el memo tal cual se escribio y `buildMemo` siempre escribe "CP", asi
  // que un "cp..." en minusculas es de otro servicio y no nuestro. Aceptarlo seria
  // atribuir a ciegas.
  return body.toLowerCase();
};

/** Una transferencia detectada, ya normalizada a unidades internas. */
export interface DetectedDeposit {
  txHash: string;
  /** Importe en unidades internas (1 USDT = 1000). */
  amount: number;
  /** Id de la orden, si el memo lo traia. */
  orderId: string | null;
  confirmations: number;
  timestamp: Date;
  chain: ChainId;
}

/**
 * Busca transferencias de USDT entrantes.
 *
 * Consulta el endpoint de eventos de TRON filtrando por el contrato de USDT, que
 * es lo que llega a la direccion de deposito: una transferencia de TRX (la moneda
 * nativa) no se acepta, porque `USDT_CONTRACT_ADDRESS` ya filtra.
 *
 * OJO con el filtro de importe. Si dos ordenes del mismo importe estan pendientes a
 * la vez, un memo ausente o equivocado no se puede atribuir con certeza. En ese
 * caso se devuelve el `txHash` pero `orderId: null`, y es el operador quien tiene
 * que decidir a quien se acredita. Es preferible un saldo sin acreditar que un
 * saldo acreditado a la persona equivocada.
 */
export const fetchIncomingTransfers = async (
  depositAddress: string,
  sinceMs: number = Date.now() - TRON_LOOKBACK_US / 1000,
): Promise<DetectedDeposit[]> => {
  if (!apiKey()) {
    throw new Error('TRONGRID_API_KEY no esta definida: no se pueden consultar depositos.');
  }

  const contract = usdtContract();

  const url =
    `${TRONGRID_BASE}/v1/contracts/${contract}/events` +
    `?event_name=Transfer` +
    `&only_confirmed=false` +
    `&limit=200` +
    `&min_timestamp=${sinceMs}`;

  // La API key va en la cabecera, no en la query: las URLs quedan en los logs de
  // proxy y de error, y una clave filtrada por ahi es una clave filtrada.
  const response = await fetch(url, {
    headers: {
      'TRON-PRO-API-KEY': apiKey(),
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TronGrid respondio ${response.status}: ${body.slice(0, 200)}`);
  }

  const json: any = await response.json();
  const raw: TronTransferEvent[] = json?.data || [];

  const out: DetectedDeposit[] = [];

  for (const ev of raw) {
    // Solo entran las transferencias hacia la direccion de la plataforma. Una
    // salida (un retiro) tiene `to` distinto y no debe contar como deposito.
    if (ev.to !== depositAddress) continue;

    // Los eventos de TRC20 traen `token_info.decimals`; el valor viene en
    // unidades atomicas (6 para USDT en TRON).
    const decimals = ev.token_info?.decimals ?? 6;
    const units = Number(ev.value) / 10 ** decimals;

    out.push({
      txHash: ev.transaction_id,
      amount: Math.floor(units * 1000),
      orderId: parseMemo(ev.memo || ''),
      confirmations: TRON_CONFIRMATIONS,
      timestamp: new Date(ev.block_timestamp),
      chain: 'TRC20',
    });
  }

  return out;
};

/**
 * Una pasada de conciliacion: busca depositos y los liga a ordenes pendientes.
 *
 * Devuelve el numero de ordenes acreditadas. No lo hace ella misma: devuelve la
 * lista de coincidencias y es `payment.service` quien la llama con la logica de
 * credito, para que el camino de simulacion y el real compartan el mismo sitio.
 *
 * @param lookup  funcion que, dado un id de orden, devuelve la orden pendiente o
 *                `null`. Se inyecta para no meter mongoose en este modulo, igual
 *                que en `field.atomic.ts`: asi se puede probar sin base de datos.
 */
export const reconcile = async (
  lookup: (orderId: string) => Promise<PendingOrder | null>,
  options: {
    depositAddress?: string;
    since?: number;
    onMatch?: (
      order: PendingOrder,
      deposit: DetectedDeposit,
    ) => Promise<void>;
  } = {},
): Promise<{
  matched: number;
  unmatched: DetectedDeposit[];
  scanned: number;
}> => {
  const address =
    options.depositAddress || depositAddress();

  if (!address) {
    throw new Error(
      'TRON_DEPOSIT_ADDRESS no esta definida: no se puede saber que transferencias ' +
      'son depositos y cuales son de otro servicio que use la misma direccion.',
    );
  }

  const transfers = await fetchIncomingTransfers(address, options.since);
  let matched = 0;
  const unmatched: DetectedDeposit[] = [];

  for (const deposit of transfers) {
    if (!deposit.orderId) {
      // Sin memo no hay forma de saber a quien pertenece. No se adivina.
      unmatched.push(deposit);
      logger.warn(
        `Deposito de ${deposit.amount / 1000} USDT (${deposit.txHash}) sin memo ` +
        'reconocible. Queda sin acreditar: hay que decidirlo a mano.',
      );
      continue;
    }

    const order = await lookup(deposit.orderId);
    if (!order) {
      unmatched.push(deposit);
      logger.warn(
        `Deposito con memo ${deposit.orderId} (${deposit.txHash}) no corresponde a ` +
        'ninguna orden pendiente. Puede ser un pago de mas o una orden ya cerrada.',
      );
      continue;
    }

    // Si el importe no coincide con lo pedido, no se acredita. Es el caso que
    // mas problemas da en la practica: el usuario envia de mas o de menos, y
    // acreditar la diferencia sin perguntar es una fuente de disputas.
    if (deposit.amount !== order.amount) {
      unmatched.push(deposit);
      logger.warn(
        `Deposito ${deposit.txHash} por ${deposit.amount / 1000} USDT no coincide ` +
        `con la orden ${order.orderId} por ${order.amount / 1000} USDT. ` +
        'No se acredita automaticamente.',
      );
      continue;
    }

    // Y que no se haya acreditado antes. El `status` lo comprueba `creditDeposit`,
    // pero se filtra aqui para no gastar una escritura por una transferencia ya
    // vista.
    if (order.status !== 'pending') {
      continue;
    }

    matched++;
    if (options.onMatch) {
      await options.onMatch(order, deposit);
    }
  }

  return { matched, unmatched, scanned: transfers.length };
};

/**
 * Devuelve las redes para las que esta pasarela puede funcionar de verdad.
 *
 * Por ahora solo TRC20, y no por pereza: es la unica con memo, que es lo que hace
 * posible atribuir una transferencia a una orden sin direccion propia.
 */
export const supportedChains = (): ChainId[] => ['TRC20'];

/**
 * El proveedor de esta pasarela, para encajar con el tipo de `gateway.ts`.
 *
 * Es una constante y no un import para no arrastrar `gateway.ts` (y con el su
 * simulacion) a un modulo que solo va contra la cadena.
 */
export const USDT_PROVIDER = 'usdt' as const;

/**
 * Comprobacion de disponibilidad, para mostrar en el panel del operador.
 *
 * Devuelve tambien el motivo de la falta, porque "no funciona" sin explicar por
 * que hace que un operador pierda media hora probando cosas.
 */
export const usdtStatus = (): {
  ready: boolean;
  reason: string;
  chains: ChainId[];
} => {
  const missing: string[] = [];
  if (!apiKey()) missing.push('TRONGRID_API_KEY');
  if (!depositAddress()) missing.push('TRON_DEPOSIT_ADDRESS');

  return {
    ready: missing.length === 0,
    reason:
      missing.length === 0
        ? 'Configurada. Vigilando TRC20.'
        : `Falta definir: ${missing.join(', ')}. No se acreditaran depositos.`,
    chains: supportedChains(),
  };
};

/** Exportado para los tests: la direccion de deposito configurada por cadena. */
export const depositAddressFor = (chain: ChainId): string => {
  if (!isValidChain(chain)) throw new Error(`Cadena desconocida: ${chain}`);
  if (chain === 'TRC20') {
    return depositAddress() || DEPOSIT_ADDRESSES.TRC20;
  }
  return DEPOSIT_ADDRESSES[chain];
};

/**
 * Firma de webhook entrante, para cuando se conecte un servicio que notifique
 * en vez de hacer polling.
 *
 * Se calcula con HMAC-SHA256 sobre el cuerpo crudo, en hex, y se compara en tiempo
 * constante. Es la misma forma que usan EnZona y QvaPay.
 */
export const verifyWebhookSignature = (
  rawBody: string,
  signature: string,
  secret: string,
): boolean => {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Reexportado para que quien use esta pasarela no tenga que importar `chains`. */
export { CHAINS };
