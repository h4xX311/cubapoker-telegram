/**
 * Moneda y limites de la cuenta.
 *
 * ------------------------------------------------------------------
 * POR QUE USDT Y NO CUP
 *
 * CoinPoker mantiene el saldo de la cuenta en USDT. Sus terminos:
 *
 *   "Your account balance is the amount of cryptocurrency paid into your
 *    account"
 *   "deposited currency to be collected and exchanged for the equivalent
 *    value in USDT"
 *
 * Guardar el saldo en CUP tiene dos problemas que USDT no tiene:
 *
 *  a) El valor del saldo se mueve solo. Depositas 10 000 CUP y al dia
 *     siguiente valen otra cosa. Eso no es un saldo, es una posicion
 *     cambiaria.
 *
 *  b) Al retirar hay que decidir que tipo de cambio se congela: el del
 *     deposito, el del retiro, o un promedio. CoinPoker no tiene que tomar
 *     esa decision porque su unidad es estable.
 *
 * Con USDT, el deposito en CUP se convierte una vez, al entrar. El saldo queda
 * en USDT y no se mueve con el mercado. CUP es la via de entrada y salida
 * (EnZona, QvaPay); las 5 redes de `chains.ts` son la via de USDT. Ninguna de
 * las dos es la unidad de la cuenta.
 */

/** Unidad de la cuenta. Todo saldo interno se guarda en esto. */
export const ACCOUNT_CURRENCY = 'USDT' as const;

/**
 * Tipo de cambio de referencia: CUP por 1 USDT.
 *
 * DECISION DEL OPERADOR, no tecnica. Cuba tiene tipo oficial (~120) y tipo
 * paralelo (~400), una diferencia de 3,3x que es la decision economica mas
 * importante del proyecto:
 *
 *  - Con el oficial, un deposito de 10 000 CUP acredita 83,33 USDT y al retirar
 *    se pagan 10 000 CUP. Es justo, pero el riesgo de depreciacion del CUP lo
 *    asume el operador.
 *  - Con el paralelo, el usuario conserva el valor de mercado, pero el operador
 *    estaria cotizando en una moneda que no puede tratar legalmente.
 *
 * Se usa el OFICIAL y se deja configurable, que es lo unico defendible sin
 * cobertura cambiaria. Si el CUP se mueve, hay que actualizar esto y revisar
 * los saldos.
 */
export const CUP_PER_USDT = 120;

/** Como se muestra el saldo en la interfaz. */
export const DISPLAY_CURRENCY = 'USDT' as const;

/** Convierte CUP a USDT. Redondea hacia abajo: el operador nunca pierde de más. */
export const cupToUsdt = (cup: number): number =>
  Math.floor((cup / CUP_PER_USDT) * 100) / 100;

/** Convierte USDT a CUP. Redondea hacia arriba: el operador no da de más. */
export const usdtToCup = (usdt: number): number =>
  Math.ceil(usdt * CUP_PER_USDT);

/**
 * Limites de retiro.
 *
 * Copiados de coinpoker.com/deposits-and-withdrawals/withdrawals/ (sept 2026):
 *
 *   USDT:  minimo 10 USDT, maximo 25 000 USDT por transaccion, fee 5 USDT
 *   USDC:  minimo 10 USDT, maximo 25 000 USDT equivalente, fee 0-5 USDT
 *   BTC:   minimo 10 USDT equivalente, ~1 USDT
 *
 * Y el dato que de verdad importa para el usuario: **USDT y USDC en Polygon no
 * tienen commission**. Por eso Polygon debe ser la opcion por defecto en la
 * pantalla de retiro: el resto de redes cuesta 5 USDT, que en un retiro pequeno
 * se come una parte enorme del importe.
 */
export const WITHDRAWALS = {
  /** Minimo por transaccion, en USDT (10 USDT = 1200 CUP). */
  min: 10,

  /** Maximo por transaccion, en USDT. */
  maxPerTransaction: 25_000,

  /**
   * Tope mensual de ganancias retirables, en USDT.
   *
   * En CoinPoker este tope (500 000) aplica solo a ganancias de casino y NO a
   * poker. Aqui si se aplica al poker, porque Cuba no tiene el volumen para
   * asumir un pasivo ilimitado y sin marco legal que proteja al usuario.
   */
  monthlyWinCap: 25_000,

  /**
   * Cadencia de las redes segun CoinPoker.
   *
   * `free: true` significa que el operador no cobra comision de red. Con la
   * tasa actual eso solo es posible en Polygon; en las otras redes el coste
   * real corre de la plataforma y hay que cobrarlo o se opera en negativo.
   */
  networkFees: {
    polygon: { fee: 0, free: true },
    tron: { fee: 1, free: false },
    bep20: { fee: 1, free: false },
    erc20: { fee: 5, free: false },
    solana: { fee: 0.5, free: false },
  } as Record<string, { fee: number; free: boolean }>,

  /** Red por defecto en la pantalla de retiro: la unica gratis. */
  defaultNetwork: 'polygon',
} as const;

/**
 * Depositos minimos por proveedor.
 *
 * En CUP porque es lo que el usuario ve en EnZona, y el minimo lo impone el
 * proveedor, no nosotros. 500 CUP son 4,17 USDT.
 */
export const DEPOSITS = {
  enzona: { minCup: 500, fee: 0.015 },
  qvapay: { minCup: 500, fee: 0.015 },
  /** USDT por red: sin minimo relevante (lo impone la red). */
  usdt: { minUsdt: 5, fee: 0 },
} as const;

/**
 * Promocion de bienvenida: 150% como CoinPoker.
 *
 * Entra en `balance.play` (Promotional Dollars), no en `real`. Si entrara en
 * `real` seria un deposito disfrazado y un agujero de retirada inmediato.
 */
export const WELCOME_BONUS = {
  percentage: 1.5,
  maxUsdt: 2_000,
  /** Vence si no se juega en 30 dias. */
  expiresDays: 30,
} as const;
