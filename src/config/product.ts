/**
 * Configuracion del producto.
 *
 * Concentra las reglas de negocio de las mesas, los freerolls y los bots.
 * Cambiar numeros aqui debe bastar para reajustar el producto sin tocar
 * la logica de juego.
 */

import { usdtToUnits, blindsFor } from './units';

export type TableKind = 'cash' | 'freeroll' | 'centroll';

/**
 * Los cuatro niveles de campo.
 *
 * Antes eran 't50' | 't100' | 't300' | 't500', nombrados por el TAMANO del
 * campo. Ahora escalan por el buy-in (1/5/25/100 USDT) y todos son de 300
 * participantes, asi que el nombre tiene que reflejar lo que los diferencia.
 *
 * OJO: cambiar estos ids rompe los registros de `Field.tierId` y `Table.tierId`
 * de los campos que ya esten guardados. Si hay datos en produccion hay que
 * hacer una migracion de ids, no solo cambiar la constante.
 */
export type TableTierId = 't1' | 't5' | 't25' | 't100' | 'arena';

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
 * FORMATOS DE MESA CASH
 * =====================
 *
 * El motor solo juega No-Limit Hold'em. Dentro de Hold'em si se pueden ofrecer
 * los formatos que un lobby real muestra en cada sala:
 *
 *   7-max  mesa llena, el formato clasico
 *   6-max  mas accion por jugador
 *   HU     Heads-Up, dos jugadores
 *
 * No se anuncian PLO, PLO5, PLO6 ni Short Deck: exigirian un evaluador de
 * Omaha, una baraja de 36 cartas y un ranking distinto. Ponerlos en el lobby
 * sin motor seria vender una mesa que no existe.
 */
export type CashFormatId = '7max' | '6max' | 'hu';

export interface CashFormat {
  id: CashFormatId;
  label: string;
  shortLabel: string;
  maxSeats: number;
}

export const CASH_FORMATS: Record<CashFormatId, CashFormat> = {
  '7max': {
    id: '7max',
    label: '7-max',
    shortLabel: '7-MAX',
    maxSeats: SEATS_PER_TABLE,
  },
  '6max': {
    id: '6max',
    label: '6-max',
    shortLabel: '6-MAX',
    maxSeats: 6,
  },
  hu: {
    id: 'hu',
    label: 'Heads-Up',
    shortLabel: 'HU',
    maxSeats: 2,
  },
};

export const CASH_FORMAT_LIST: CashFormat[] = [
  CASH_FORMATS['7max'],
  CASH_FORMATS['6max'],
  CASH_FORMATS.hu,
];

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
   * El premio de un campo o freeroll se abona a `balance.play`, que NO es
   * retirable directamente: se desbloquea jugando a ratio 1:10 (ver
   * `UNLOCK_RATES` y `services/unlock.service.ts`).
   *
   * Razon: un campo de dinero exige buy-in, pero un freeroll no. Si el premio
   * fuera retirable, ganar un freeroll seria indistinguible de un deposito y un
   * jugador podria repetirlo para sacar dinero sin depositar nunca. Con el
   * ratio, hay que jugar el 90% de las fichas para extraer el 10%.
   */
  prizeToBalance: 'play' as const,

  /** Frase que la UI debe mostrar junto al premio. */
  disclosure:
    'El premio sale del bote del campo: es el 95% de lo que puso todo el mundo ' +
    'en juego, menos el 5% de rake. Se reparte entre los primeros lugares y se ' +
    'abona como saldo de promocion: sirve para jugar en cualquier campo y se ' +
    'desbloquea 1 de cada 10 a saldo retirable jugando.',
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
/**
 * Campos cash en USDT.
 *
 * ------------------------------------------------------------------
 * LOS NIVELES ESCALAN EN BUY-IN
 *
 * El cash es una ring table 7-max: el jugador entra con un buy-in, juega las
 * manos que quiera y se levanta con sus fichas. Los niveles cambian el tamano
 * de la apuesta, no el numero de participantes.
 *
 *   nivel       buy-in       ciegas (USDT)     stack
 *   micro       1 USDT       0,005 / 0,01      100 BB
 *   bajo        5 USDT       0,025 / 0,05      100 BB
 *   medio      25 USDT       0,125 / 0,25      100 BB
 *   alto      100 USDT       0,50 / 1,00       100 BB
 *   VIP Arena 10.000 USDT   50 / 100          100 BB
 *
 * `fieldSize` se conserva para los campos multi-mesa de torneo (freeroll,
 * centroll), que no son cash. El lobby de cash ya no lo muestra.
 *
 * Los 100 USDT del nivel alto son un stack de poker serio. El rake de una mesa
 * de ese nivel es lo que paga la infraestructura.
 */
export interface TableTier {
  id: TableTierId;
  /**
   * Participantes del campo (multi-mesa), 300 en todos los niveles.
   * Solo lo usan los campos de torneo; una ring table cash no tiene fieldSize.
   */
  fieldSize: number;
  /**
   * Buy-in por jugador, en UNIDADES INTERNAS (1/1000 de USDT).
   *
   * Ojo: no es USDT. Las fichas del motor son enteras y un stack de 1 USDT con
   * ciega de 0,02 no es representable en USDT enteros. Ver `config/units.ts`.
   */
  buyInUnits: number;

  /** Buy-in en USDT, solo para la interfaz y los textos. */
  buyInUsdt: number;

  label: string;
  description: string;

  /**
   * Ciegas en unidades internas.
   *
   * Se guardan aqui y no se derivan en el momento de crear la mesa, porque una
   * ciega que dependa del redondeo en cada creacion puede dar dos valores
   * distintos para el mismo tier, y eso hace que dos mesas del mismo nivel
   * jueguen con stacks perceived distintos.
   */
  blinds: { small: number; big: number };

  /** Stack de referencia en ciegas grandes, para mostrarlo en la UI. */
  stackInBigBlinds: number;

  /**
   * Sala VIP Arena. No es una membresía: es una mesa de cash premium.
   *
   * La UI la pinta distinta y el motor de rake marca sus manos para pagar el
   * profit share semanal. No se compra acceso: se juega con el buy-in.
   */
  vipArena?: boolean;

  /** Porcentaje del rake de esta sala que se devuelve como profit share. */
  arenaProfitSharePercent?: number;

  /**
   * Tope de rake por mano, en unidades internas, según cuántos jugadores
   * recibieron cartas. Es el esquema de CoinPoker: el tope sube con el número
   * de jugadores porque el bote puede ser mayor.
   *
   * Sin esto, el tope global de 100 unidades (0,10 USDT) hacía que una mesa de
   * 50/100 USDT pagara el mismo rake máximo que la micro. La sala VIP Arena
   * habría sido decorativa.
   */
  rakeCaps?: {
    headsUp: number;
    threeToFour: number;
    fivePlus: number;
  };
}

/**
 * VIP ARENA
 * =========
 *
 * En CoinPoker, VIP Arena es una SALA de cash de high stakes, no un plan que se
 * compra. Los jugadores reciben un profit share semanal por el rake que
 * generan. Se puede sumar al 3-Bet Club: no son el mismo producto.
 *
 * Ciegas 50/100 USDT y buy-in de 10.000 USDT = 100 BB. Es el escalón de
 * entrada de la sala real. Para un jugador nuevo es inalcanzable, y está bien:
 * la sala se muestra como objetivo, no se le vende una membresía falsa.
 */
export const VIP_ARENA = {
  id: 'arena' as const,
  label: 'VIP Arena',
  buyInUsdt: 10_000,
  blinds: { small: 50, big: 100 },
  profitSharePercent: 15,
  description:
    'Mesa premium de high stakes. Los jugadores reciben un 15 % del rake ' +
    'que generan, pagado cada lunes. No es una membresía: se entra con el buy-in.',
} as const;

/**
 * Construye un tier.
 *
 * Las unidades internas se calculan UNA vez, al cargar el modulo, con
 * `usdtToUnits()`. Es deterministico y no depende de cuando se llame.
 *
 * El `stackInBigBlinds` es informacion de UI: el stack en unidades dividido
 * entre la ciega grande. Con buy-in de 1 USDT y ciega de 0,02, son 50 BB, que es
 * un stack normal de poker.
 */
const tier = (
  id: TableTierId,
  label: string,
  buyInUsdt: number,
): TableTier => ({
  id,
  fieldSize: 300,
  buyInUsdt,
  buyInUnits: usdtToUnits(buyInUsdt),
  blinds: blindsFor(buyInUsdt),
  // Stack en ciegas grandes: unidades / ciega grande. Con 1 USDT y ciega de
  // 0,02 son 50 BB.
  stackInBigBlinds: Math.round(
    usdtToUnits(buyInUsdt) / blindsFor(buyInUsdt).big,
  ),
  label,
  description: `Ring table 7-max · buy-in ${buyInUsdt} USDT`,
});

/**
 * Topes de rake por mano, en unidades internas.
 *
 * Se toman de la tabla pública de CoinPoker. Para las ciegas que no aparecen
 * exactamente se usa el escalón inmediatamente inferior, que es el conservador
 * para el jugador. En la micro se escala a la mitad del escalón 0,01/0,02.
 *
 * Los topes son por mano y dependen de cuántos jugadores recibieron cartas:
 * heads-up, 3-4 y 5+.
 */
const capsUsdt = (
  headsUp: number,
  threeToFour: number,
  fivePlus: number,
): NonNullable<TableTier['rakeCaps']> => ({
  headsUp: usdtToUnits(headsUp),
  threeToFour: usdtToUnits(threeToFour),
  fivePlus: usdtToUnits(fivePlus),
});

export const TABLE_TIERS: Record<TableTierId, TableTier> = {
  // Micro: 1000 unidades con ciega grande de 10 -> 100 BB de stack.
  t1: {
    ...tier('t1', 'Micro', 1),
    rakeCaps: capsUsdt(0.025, 0.06, 0.10),
  },
  t5: {
    ...tier('t5', 'Bajo', 5),
    // Ciegas 0,025/0,05: se usa el escalón 0,02/0,05.
    rakeCaps: capsUsdt(0.13, 0.30, 0.50),
  },
  t25: {
    ...tier('t25', 'Medio', 25),
    // Ciegas 0,125/0,25: se usa el escalón 0,10/0,25.
    rakeCaps: capsUsdt(0.50, 1.20, 2.00),
  },
  t100: {
    ...tier('t100', 'Alto', 100),
    // Ciegas 0,50/1,00.
    rakeCaps: capsUsdt(1.25, 3.00, 5.00),
  },

  // VIP Arena: ciegas 50/100 USDT, buy-in 10.000 USDT (100 BB). No se compra
  // una membresía para entrar; se entra con el buy-in y se cobra profit share
  // por el rake generado.
  arena: {
    ...tier('arena', 'VIP Arena', VIP_ARENA.buyInUsdt),
    vipArena: true,
    arenaProfitSharePercent: VIP_ARENA.profitSharePercent,
    // Escalón 50/100+ de CoinPoker: 0,50 / 0,60 / 0,60 BB.
    rakeCaps: capsUsdt(50, 60, 60),
    description: VIP_ARENA.description,
  },
};

export const TABLE_TIER_LIST: TableTier[] = [
  TABLE_TIERS.t1,
  TABLE_TIERS.t5,
  TABLE_TIERS.t25,
  TABLE_TIERS.t100,
  TABLE_TIERS.arena,
];

/**
 * Escalones de freeroll, en USDT.
 *
 * El premio entra en `balance.play` (Promotional Dollars): no se retira
 * directamente, se desbloquea jugando a ratio 1:10. Ver `UNLOCK_RATES`.
 *
 * WHY THESE AND NOT 5-50 CUP
 * -------------------------
 * Los numeros anteriores (5, 10, 20, 30, 40, 50 CUP) estaban calibrados a una
 * moneda que ya no es la de la cuenta. Con la cuenta en USDT, un premio de 50
 * CUP son 0,42 USDT: menos que una ronda de un centroll. Es un premio que no
 * justifica entrar.
 *
 * La escala de aqui da algo con lo que se puede seguir jugando: ganar el
 * escalon de 50 USDT da 50 USDT de promocion, con lo que se pueden comprar
 * cinco entradas de campo micro o cincuenta centrolls. El freeroll tiene que
 * ser una via de entrada, no un premio symbolic.
 */
export const FREEROLL_PRIZES = [1, 3, 10, 25, 50, 200] as const;

/**
 * Campo objetivo para que arranque un freeroll.
 *
 * 300 son 43 mesas de 7: grande, pero llega a mesa final en un rato. Un campo
 * de 500 (72 mesas) tardaria horas en llenarse con la base de usuarios de un
 * proyecto nuevo, y la gente se cansaria esperando.
 */
export const FREEROLL_TARGET_FIELD = 300;

/**
 * Techo duro de inscritos por freeroll.
 *
 * "Ilimitado" no puede ser ilimitado de verdad. Con 20 000 inscritos harian
 * falta casi 3 000 mesas y el campo tardaria horas en llegar a mesa final; sin
 * tope, el mismo usuario podria abrir campos en bucle y acaparar los premios.
 *
 * El tope protege al operador. Por eso hay que anunciarlo en la UI: si el
 * jugador se inscribe y el campo se cierra a 900, tiene que saberlo antes.
 */
export const FREEROLL_MAX_FIELD = 900;

/**
 * Reparto del freeroll segun posicion final (porcentaje del bote).
 *
 * Suma 100 porque el freeroll no aplica rake: todo el bote se reparte. Es lo
 * unico que hace que un freeroll sea un giveaway real.
 */
export const FREEROLL_PAYOUT = [50, 30, 20] as const;

// ==========================================================================
// CENTROLLS
// ==========================================================================

/**
 * Centroll: buy-in de 0,01 USDT que consume saldo REAL.
 *
 * ------------------------------------------------------------------
 * QUE RESUELVE
 *
 * El freeroll de CubaPoker era gratis de verdad, sin ninguna via de ingresos:
 * el operador pagaba el premio y no cobraba nada a cambio. CoinPoker tiene
 * esta pieza y es la que hace su freeroll rentable:
 *
 *   "CoinPoker Centrolls: $0.01 Buy-Ins"
 *   "These events require you to have a real money balance of at least $0.01"
 *
 * El bucle es: deposito -> centroll -> saldo de promocion -> centroll o
 * freeroll. El centroll es el punto por el que entra el dinero real, y el
 * freeroll es el que lo devuelve como saldo de promocion.
 *
 * Con el cambio a USDT, 0,01 USDT = 10 unidades internas (1 USDT = 1000).
 * Cabe en el ledger sin redondear y es accesible para un usuario cubano.
 */
export const CENTROLL = {
  /** Buy-in en USDT. 0,01 = 10 unidades internas. */
  buyInUsdt: 0.01,

  /**
   * Fichas iniciales de cada jugador del centroll.
   *
   * NO salen del buy-in: el buy-in es dinero de la casa (0,01 USDT) y las
   * fichas son de torneo. Con 1.000 fichas y las ciegas derivadas del stack
   * (5/10) el centroll es un torneo de 100 ciegas grandes; si el stack saliera
   * del buy-in serian 10 fichas y ciegas 1/2, o sea all-in preflop. Las fichas
   * no tocan el bote: el premio se calcula sobre `buyInsCollected`.
   */
  startingChips: 1000,

  /**
   * TICKETS, no fichas.
   *
 * En CoinPoker el premio de un centroll es una entrada a un satelite, nunca
   * dinero: "Do centrolls have cash prizes? No, all prizes in your centrolls are
   * paid in the form of tickets".
   *
   * Aqui el equivalente al ticket es `balance.play`: acceso a mas centrolls y
   * freerolls, que es exactamente la misma funcion sin la contabilidad extra de
   * un inventario de tickets. El premio NO se convierte en saldo retirable mas
   * que por la via normal de juego (1:10).
   */
  prizeToBalance: 'play' as const,

  /**
   * Porcentaje del bote que se reparte como premio. 30 = 30%.
   *
   * En un campo lleno de 100 jugadores, 30% del bote equivale a 30 veces el
   * buy-in; por eso el nombre historico `prizeMultiplier`. La UI lo muestra
   * como porcentaje para que siga siendo correcto con campos a medio llenar.
   */
  prizeMultiplier: 30,

  /** Campo objetivo del centroll. Mas pequeno que el freeroll: es un bucle rapido. */
  targetField: 100,

  /** Techo duro. Mas bajo que el del freeroll: son mucho mas frecuentes. */
  maxField: 300,

  /**
   * Jugadores minimos por mesa para arrancar.
   *
   * Un centroll no puede esperar a juntar 100 humanos: con un solo jugador se
   * queda abierto para siempre. Cada mesa que tenga al menos un humano se
   * completa con bots hasta este minimo y arranca. Los bots no pagan buy-in;
   * si ganan una posicion, su premio se queda en la casa (ver `settleField`).
   */
  minPlayersPerTable: 2,

  /** Cuantas veces se puede reentrar por 0,01 USDT, como CoinPoker. */
  maxRebuys: 5,
} as const;

/**
 * Premio del centroll a partir del bote recaudado, en unidades enteras.
 *
 * Es la UNICA formula del premio. La usan `centrollService.status()` (lo que
 * ve el jugador) y `fieldManager.settleField()` (lo que se paga de verdad).
 * Estaban separadas y no lo estaban: la liquidacion trataba el centroll como
 * un campo de cash y repartia el 95 % del bote a `balance.real`.
 */
export const centrollPrizeUnits = (potUnits: number): number =>
  Math.max(0, Math.floor((potUnits * CENTROLL.prizeMultiplier) / 100));

/**
 * Rates de desbloqueo de `balance.play` a saldo retirable.
 *
 * ------------------------------------------------------------------
 * MODELO COINPOKER, CON UNA EXCEPCION DELIBERADA
 *
 * CoinPoker (coinpoker.com/help/promotional-dollars/):
 *
 *   | Game        | Unlock Ratio |
 *   | Cash Games  | 1:10         |
 *   | Tournaments | 1:1          |
 *
 * Aplicamos 1:10 a TODO, incluidos los campos. La razon es que en CubaPoker los
 * freerolls y los campos dan ENTRADA GRATIS: con 1:1, ganar un freeroll
 * produciria saldo retirable sin haber depositado nunca, que es un dreno
 * directo. Con 1:10 el premio es P$ y hay que jugarlas para extraer valor,
 * perdiendo el 90% por el camino.
 *
 * Es una adaptacion consciente, no un descuido. Si alguna vez hay eventos
 * con entrada de pago (torneos con buy-in de saldo real), 1:1 es
 * razonable ahi y se puede anadir como contexto nuevo.
 */
export const UNLOCK_RATES = {
  /** Mesas cash y campos Sit'n'Go: 1 de cada 10. */
  cash: 0.1,
  /** Freerolls: tambien 1:10, por el argumento del drenaje. */
  freeroll: 0.1,
  /** Centrolls: 1:10 tambien, porque dan entrada de pago pero el premio es P$. */
  centroll: 0.1,
} as const;

/** Contextos en los que se puede desbloquear `balance.play`. */
export type UnlockContext = keyof typeof UNLOCK_RATES;
/**
 * REGLAS DE SALDO
 * ------------------------------------------------------------------
 * El saldo ganado en freeroll entra a `balance.play`, que NO es retirable.
 * Solo `balance.real` (USDT de verdad) puede retirarse. Esta distincion es la
 * que hace que los freerolls sirvan de gancho sin generar obligaciones de pago.
 */
export const BALANCE = {
  /** En mesas cash se consume primero el saldo play */
  playFirstOnCashTables: true,
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
  /**
   * Nombres base de los bots. Mezcla nombres de pila y nicks de poker, como en
   * cualquier sala: no todos los jugadores se llaman igual ni todos usan un alias.
   * Sin acentos para evitar problemas de encoding.
   */
  names: [
    'ElPro', 'Marta', 'CubanKing', 'LaEstrena', 'ReyDeOros', 'Nube',
    'Coco', 'Yeni', 'ElGato', 'Solares', 'Trinidad', 'Habana',
    'Vega', 'Punto', 'Cauto', 'Zafiro', 'Bermuda', 'Coral',
    'Cobre', 'Duna', 'Guaro', 'Isla', 'Jabeque', 'Canales',
    'Tropico', 'Cafetal', 'Guarapo', 'Malecon', 'Almendron', 'Cimarron',
  ] as readonly string[],
  /**
   * Sufijos para los nombres repetidos. Un nick de poker real usa anos, ciudades
   * o apodos ("Marta79", "ElGatoHabana"), no un contador ("Marta2"), que es la
   * senal mas obvia de que el rival es un bot. Las cadenas vacias permiten que
   * el nombre base aparezca solo.
   */
  nickSuffixes: [
    '', '', '',
    '79', '88', '90', '92', '95', '99', '07', '10', '21', '23',
    'Cuba', 'Habana', 'Cubano', 'Cubana', 'delSol', 'delMar',
    'Trinidad', 'Matanzas', 'Holguin', 'Camaguey', 'Cienfuegos',
    'Varadero', 'Pinar', 'Tropic', 'Cayo', 'Palma', 'Caney',
  ] as readonly string[],
} as const;

/**
 * Rake por tipo de mesa.
 *
 * `cashMax` es solo el tope de seguridad heredado para un tier sin topes
 * configurados. Las ring tables usan `rakeCapFor()`, que aplica el tope de
 * CoinPoker según la sala y los jugadores. El freeroll no aplica rake: es el
 * coste de adquisición.
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

/**
 * Tope de rake de una mano según la sala y cuántos jugadores recibieron
 * cartas. `RAKE.cashMax` queda solo como red de seguridad para datos viejos o
 * un tier sin topes configurados.
 */
export const rakeCapFor = (
  tierId: string | undefined,
  players: number,
): number => {
  const caps = getTier(tierId ?? '')?.rakeCaps;
  if (!caps) return RAKE.cashMax;
  if (players <= 2) return caps.headsUp;
  if (players <= 4) return caps.threeToFour;
  return caps.fivePlus;
};
