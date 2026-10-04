/**
 * Configuracion del producto.
 *
 * Concentra las reglas de negocio de las mesas, los freerolls y los bots.
 * Cambiar numeros aqui debe bastar para reajustar el producto sin tocar
 * la logica de juego.
 */

export type TableKind = 'cash' | 'freeroll';
export type TableTierId = 't50' | 't100' | 't300' | 't500';

/**
 * Asientos por mesa fisica.
 *
 * DISTINGUIENDO DOS COSAS QUE SE CONFUNDEN FACIL
 * ------------------------------------------------------------------
 *  - `SEATS_PER_TABLE` (este valor, 7): cuantas personas sentadas hay en una
 *    mesa. Siete es una mesa de poker real. El motor reparte 2 cartas por
 *    jugador y la mesa necesita 5 comunitarias, asi que el techo matematico
 *    es (52 - 5) / 2 = 23; con 7-max nunca se acerca.
 *
 *  - `fieldSize` (en TableTier): cuantos participantes tiene el CAMPO, es
 *    decir cuantos jugadores inscritos en total a lo largo de todas las mesas.
 *    Un field de 500 son unas 72 mesas de 7 que se van fusionando mano a mano
 *    hasta que queda una mesa final de 7. Es un Sit'n'Go multi-mesa, no una
 *    mesa de 500 personas.
 *
 * Confundir ambas cosas fue el error de la iteracion anterior: se anunciaba
 * "mesa de 500 jugadores" cuando no existe tal cosa, y el motor se veia
 * obligado a repartir 23 por tanda para disimularlo.
 */
export const SEATS_PER_TABLE = 7;

/**
 * Reparto del premio de un field entre los primeros puestos, en porcentajes.
 *
 * Suman exactamente 100, lo que significa que el rake NO sale de este premio:
 * el rake se descuenta de los botes de cada mano y el premio es una bolsa
 * aparte, la que financia el operador. Ver `ECONOMY` mas abajo.
 *
 * Payout de un field de 500 con premio 500 CUP, por ejemplo:
 *   1o 225 CUP · 2o 125 · 3o 75 · 4o 45 · 5o 30
 * Los 495 restantes no cobran pero juegan hasta el final.
 */
export const FIELD_PAYOUT = [45, 25, 15, 9, 6] as const;

/**
 * COMO SE FINANCIA EL PREMIO (pendiente de decision de negocio)
 * ------------------------------------------------------------------
 * Los numeros de `TABLE_TIERS` tienen un problema aritmetico que el codigo no
 * puede arreglar. El premio es siempre `fieldSize x 1 CUP`, y el buy-in minimo
 * va de 200 a 2000:
 *
 *   field   premio   buy-in   se recauda   RTP
 *   50      50       200      10 000      0,50 %
 *   100     100      500      50 000      0,20 %
 *   300     300      1000     300 000     0,10 %
 *   500     500      2000     1 000 000   0,05 %
 *
 * El rake del 5% si supera al premio (500 CUP de rake contra 50 de premio en el
 * campo de 50), asi que la cuenta del operador cierra. El problema es el
 * jugador: un RTP del 0,05% significa que pierde el 99,95% de lo que pone.
 * No es un juego, es una entrega de dinero, y ningun jugador lo repetiria dos
 * veces.
 *
 * Para que el RTP fuera de ~95% haria falta un buy-in de ~1 CUP en los cuatro
 * campos, lo que los hace economicamente identicos y deja el ladder sin
 * sentido (jugar en el campo de 500 duraria horas y daria lo mismo que el de 50).
 *
 * LAS TRES SALIDAS, y hay que elegir una antes de escribir el field manager:
 *
 *   A) Bajar el buy-in a ~1 CUP. RTP sano, pero los 4 campos se vuelven
 *      indistinguibles y el stake es tan bajo que el rake de 5% da 0,05 CUP
 *      por mano: no cubre ni el gasto de infra.
 *
 *   B) Que el premio salga de un FONDO promocional y no del bote. Ahi el RTP al
 *      jugador es 100% (o mas) por el premio, y el ingreso del operador es el
 *      rake. Es lo que hacen CoinPoker y similares con los "guaranteed prize
 *      pools". El campo de 500 con premio 500 CUP seria entonces un gancho
 *      promocional de bajo valor, no un negocio. Y como el premio de los
 *      freerolls va a `balance.play` (no retirable), ese mismo fondo puede
 *      alimentar tambien los campos cash sin obligacion de pago.
 *
 *   C) Cambiar la escalera: que el premio crezca con el field en proportion al
 *      buy-in (por ejemplo premio = field x buy-in x 0,95). El campo de 500
 *      pagaria ~950 000 CUP, que ya no es un premio promocional sino un
 *      torneo serio, y exige una caja mucho mayor.
 *
 * Hasta que se elija, los tests de `test-business-rules.js` fallan a proposito
 * en el bloque 2 (economia del campo). No es un test roto: es el aviso de que
 * el producto no es jugable tal como esta.
 */
export const ECONOMY = {
  /** Buy-in que haria falta para un RTP del 95% con los premios actuales. */
  buyInForHealthyRtp: 1.05,
  /** RTP minimo aceptable para que el campo tenga sentido. */
  minAcceptableRtp: 0.5,
} as const;

/** Numero de plazas premiadas. El resto no cobra, pero juega hasta el final. */
export const PAID_POSITIONS = FIELD_PAYOUT.length;

/**
 * Campos cash con premio garantizado.
 *
 * `fieldSize` es el numero de participantes del campo completo (multi-mesa),
 * NO los asientos de una mesa. El premio es del campo entero y se reparte a las
 * primeras posiciones (ver `FIELD_PAYOUT`).
 */
export interface TableTier {
  id: TableTierId;
  /** Participantes totales del campo (multi-mesa) */
  fieldSize: number;
  /** Premio total garantizado del campo, en CUP */
  guaranteedPrize: number;
  /** Buy-in minimo por jugador para poderouw registrarse */
  minBuyIn: number;
  /** Buy-in por defecto al registrarse */
  defaultBuyIn: number;
  label: string;
  description: string;
}

export const TABLE_TIERS: Record<TableTierId, TableTier> = {
  t50: {
    id: 't50',
    fieldSize: 50,
    guaranteedPrize: 50,
    minBuyIn: 200,
    defaultBuyIn: 500,
    label: 'Campo 50',
    description: '50 participantes · Premio 50 CUP',
  },
  t100: {
    id: 't100',
    fieldSize: 100,
    guaranteedPrize: 100,
    minBuyIn: 500,
    defaultBuyIn: 1000,
    label: 'Campo 100',
    description: '100 participantes · Premio 100 CUP',
  },
  t300: {
    id: 't300',
    fieldSize: 300,
    guaranteedPrize: 300,
    minBuyIn: 1000,
    defaultBuyIn: 2500,
    label: 'Campo 300',
    description: '300 participantes · Premio 300 CUP',
  },
  t500: {
    id: 't500',
    fieldSize: 500,
    guaranteedPrize: 500,
    minBuyIn: 2000,
    defaultBuyIn: 5000,
    label: 'Campo 500',
    description: '500 participantes · Premio 500 CUP',
  },
};

export const TABLE_TIER_LIST: TableTier[] = [
  TABLE_TIERS.t50,
  TABLE_TIERS.t100,
  TABLE_TIERS.t300,
  TABLE_TIERS.t500,
];

/** Escalones de premio del freeroll, en CUP. */
export const FREEROLL_PRIZES = [5, 10, 20, 30, 40, 50] as const;

/**
 * Participantes objetivo para que arranque el campo de un freeroll.
 *
 * El freeroll se ofrece como "ilimitado", y para el jugador lo es: no paga
 * nada. Pero un campo sin tope es un problema operativo. Con 20 000 inscritos
 * hacen falta casi 3 000 mesas de 7 y el campo tardaria horas en llegar a mesa
 * final, con los jugadores sentados esperando. Ademas, sin tope cerrado, un
 * mismo usuario podria abrir campos en bucle y acaparar los premios de
 * promocion (que, al ser no retirables, son dinero promotional y no real).
 *
 * 300-seat: unas 43 mesas de 7. Es un campo grande que se resuelve en un
 * intervalo razonable y hace que el premio de 50 CUP se sienta competitivo.
 */
export const FREEROLL_TARGET_FIELD = 300;

/** Techo duro de inscritos por freeroll. Pasado esto, se cierra el campo. */
export const FREEROLL_MAX_FIELD = 900;

/** Reparto del freeroll segun posicion final (porcentaje del bote). */
export const FREEROLL_PAYOUT = [50, 30, 20] as const;

/**
 * REGLAS DE SALDO
 * ------------------------------------------------------------------
 * El saldo ganado en freeroll entra a `balance.play`, que NO es retirable.
 * Solo `balance.real` (CUP de verdad) puede retirarse. Esta distincion es la
 * que hace que los freerolls sirvan de gancho sin generar obligaciones de pago.
 */
export const BALANCE = {
  /** En mesas cash se consume primero el saldo play */
  playFirstOnCashTables: true,
  minBuyInCUP: 200,
} as const;

/**
 * Bots que rellenan las mesas.
 *
 * `winRate` esta deliberadamente por debajo de 0.5: un bot que gana mas de lo
 * que pierde empobrece a los jugadores reales, y uno que pierde en exceso se
 * convierte en una giveaway detectable. Se calibra entre 0.42 y 0.48 para que
 * la mesa se sienta viva sin generar dinero ni regalar dinero.
 */
export const BOT_CONFIG = {
  enabled: true,
  winRateMin: 0.42,
  winRateMax: 0.48,
  /** Minutos que un bot tarda en actuar */
  minThinkMs: 900,
  maxThinkMs: 2600,
  /**
   * Tope de bots por mesa.
   *
   * Con 7-max el maximo legal es 6 huecos (si el unico humano es el que esta
   * sentado). El valor anterior (60) venia de cuando se creian mesas de 500
   * jugadores: era imposible de tener 60 bots en una mesa, y ademas habria
   * convertido cualquier campo pequeno en una mesa de solo bots.
   */
  maxBotsPerTable: SEATS_PER_TABLE - 1,
  /** Proporcion objetivo de bots respecto a humanos (0.6 = 60%) */
  botRatio: 0.6,
  /** Cada cuanto el gestor revisa y rellena las mesas */
  tickMs: 2000,
  /** Nombres para bots (neutros, sin acentos para evitar problemas de encoding) */
  names: [
    'ElPro', 'Marta', 'CubanKing', 'LaEstrena', 'ReyDeOros', 'Nube',
    'Coco', 'Yeni', 'ElGato', 'Solares', 'Trinidad', 'Habana',
    'Vega', 'Punto', 'Cauto', 'Zafiro', 'Bermuda', 'Coral',
    'Cobre', 'Duna', 'Guaro', 'Isla', 'Jabeque', 'Canales',
    'Tropico', 'Cafetal', 'Guarapo', 'Malecon', 'Almendron', 'Cimarron',
  ] as readonly string[],
} as const;

/**
 * Rake por tipo de mesa.
 * El freeroll no aplica rake: es el coste de adquisicion.
 */
export const RAKE = {
  cashPercentage: 5,
  cashMax: 100,
  minPot: 10,
  freerollPercentage: 0,
} as const;

/** Tiempo maximo para actuar antes de que el bot juegue por el usuario. */
export const TURN_TIMER = {
  humanMs: 30_000,
  botMs: 2_000,
  warnBeforeMs: 10_000,
} as const;

export const getTier = (id: string): TableTier | undefined => TABLE_TIERS[id as TableTierId];
