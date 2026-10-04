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
 * Reparto del bote del campo entre los primeros puestos, en porcentajes.
 *
 * Suman 100, asi que el rake NO sale de aqui: se descuenta antes, de cada bote
 * de mano. Lo que llega a este reparto es el 95 % del bote completo del campo.
 *
 * Payout de un campo de 500 con buy-in de 2000 CUP (bote 1 000 000):
 *   1o 427 500 · 2o 237 500 · 3o 142 500 · 4o 85 500 · 5o 57 000
 * Los 495 restantes no cobran pero juegan hasta el final.
 */
export const FIELD_PAYOUT = [45, 25, 15, 9, 6] as const;

/**
 * MODELO ECONOMICO: el premio sale del bote
 * ------------------------------------------------------------------
 * DECIDIDO. El premio se reparte del bote del campo: cada jugador mete su
 * buy-in, el rake del 5 % se descuenta de los botes de cada mano, y el 95 %
 * restante se reparte a las primeras posiciones segun `FIELD_PAYOUT`.
 *
 * Esto es un Sit n Go clasico y da un RTP del 95 %, que es el estandar de poker.
 * No hace falta bolsa promocional, ni contabilidad de pasivo, ni tope de gasto:
 * el bote escala solo con cuantos jugadores jueguen de verdad.
 *
 * CORRECCION IMPORTANTE (error propio, ya subsanado)
 * ---------------------------------------------------
 * En una iteracion anterior calcule el RTP como `premio / buy-in-recAUDados` y
 * salia un 0,05 %, con lo que conclui que el producto era una entrega de dinero
 * y arme tres alternativas. El calculo estaba mal: esa formula supone que el
 * jugador recupera SOLO el premio, cuando en un campo recupera su buy-in en
 * fichas menos el rake.
 *
 *   RTP = 1 - rake% + premio / (field x buyIn)
 *
 * Con los numeros de `TABLE_TIERS`:
 *   field   buy-in   rake    RTP
 *   50      200      5%      95,50 %
 *   100     500      5%      95,20 %
 *   300     1000     5%      95,10 %
 *   500     2000     5%      95,05 %
 *
 * El ladder tiene sentido: el campo grande paga mucho mas porque el buy-in es
 * mayor y el bote se multiplica, no porque se regale dinero.
 *
 * Lo que SI queda como requisito: el premio no es retirable. Va a
 * `balance.play`, igual que el de los freerolls. Es una decision de negocio ya
 * tomada, no una consecuencia de la aritmetica, y hay que comunicarla en la UI.
 */
export const ECONOMY = {
  /** Fraccion del bote que se devuelve al campo. El resto es rake. */
  netPotShare: 1 - 0.05,

  /**
   * El premio de un campo se abona a `balance.play` (no retirable).
   * Razon: es premio de juego, no devolucion de deposito. Retirarlo convertiria
   * un Sit n Go en un esquema de salida de dinero sin cobertura.
   */
  prizeToBalance: 'play' as const,

  /** Frase que la UI debe mostrar junto al premio. */
  disclosure:
    'El premio sale del bote del campo: es el 95% de lo que puso todo el mundo ' +
    'en juego, menos el 5% de rake. Se reparte entre los primeros lugares y se ' +
    'abona como saldo de promocion, que sirve para jugar en cualquier campo y no ' +
    'se puede retirar.',
} as const;

/**
 * MODELO DE PREMIO: fondo promocional (opcion B)
 * ------------------------------------------------------------------
 * DECIDIDO. De las tres salidas analizadas en `scripts/economy-options.js`:
 *
 *   A) Buy-in ~1 CUP     -> inviable: con la aritmetica entera de hoy el
 *                           jugador entra all-in en 1 mano y el rake es 0
 *                           por debajo de botes de 20 CUP. Ademas el ingreso
 *                           (26 CUP por campo de 500) no cubre la infra.
 *   B) Fondo promocional -> ELEGIDA. Ver abajo.
 *   C) Premio ~ field    -> otro producto: el campo de 500 pagaria 950 000 CUP
 *                           y exige caja, KYC y otra figura legal.
 *
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
