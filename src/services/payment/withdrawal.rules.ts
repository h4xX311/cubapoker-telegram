import { WITHDRAWALS, CUP_PER_USDT } from '../../config/currency';
import { usdtToUnits, formatUnits } from '../../config/units';

/**
 * Reglas de retrait, sin base de datos.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA SEPARADO
 *
 * La regla de un retiro tiene tres partes y solo una necesita Mongo:
 *
 *   1. Comprobar el saldo.                  -> necesita leer `User`
 *   2. Comprobar que no se supera lo ya pedido. -> necesita un aggregate
 *   3. Calcular cuanto queda libre.          -> aritmetica pura
 *
 * La parte 3 es la que importa y la que estaba enterrada en el servicio, donde
 * no se podia probar. Aqui esta sola, y `scripts/test-withdrawal.js` la ejecuta
 * sobre los casos que de verdad importan.
 *
 * ------------------------------------------------------------------
 * EL MODELO: EL SALDO SE CONSUME AL APROBAR, NO AL PEDIR
 *
 * Es una decision distinta a la de la mayoria de plataformas, y es la que hace
 * que este archivo tenga la forma que tiene. Al pedir un retiro:
 *
 *   - NO se descuenta nada de `balance.real`.
 *   - Se anota la orden como `pending`, y las pendientes suman contra el saldo.
 *
 * Al aprobar, `settleWithdrawal` descuenta de verdad. Al cancelar, no hay nada
 * que devolver porque el dinero nunca salio.
 *
 * La consecuencia practica es que `balance.real` es una cifra que BAJA entre la
 * solicitud y la aprobacion por una via que este modulo no controla: el jugador
 * puede sentarse a una mesa, y `splitBuyIn` consume `play` primero y luego
 * `real`. Por eso la comprobacion final va en el filtro del `findOneAndUpdate`,
 * y no aqui. Ver el comentario de `settleWithdrawal`.
 */

/** Saldo del usuario en unidades internas. */
export interface Balances {
  /** Retirable: deposits y ganancias desbloqueadas. */
  real: number;
  /** Promocional: no retirable. */
  play: number;
}

/** Por que se rechaza un retiro. */
export type WithdrawalDenial =
  | 'AMOUNT_NOT_POSITIVE'
  | 'BELOW_MINIMUM'
  | 'ABOVE_MAXIMUM'
  | 'ABOVE_MONTHLY_CAP'
  | 'PROMOTIONAL_ONLY'
  | 'EXCEEDS_FREE_BALANCE';

export interface WithdrawalCheck {
  ok: boolean;
  denial?: WithdrawalDenial;
  /** Mensaje para el usuario, ya en sus numeros. */
  message?: string;
  /**
   * Saldo retirable libre: `real` menos lo que ya esta comprometido en pedidos
   * pendientes. Es lo que de verdad puede pedir.
   */
  freeBalance: number;
}

/**
 * Cuanto puede pedir todavia, en unidades internas.
 *
 * La reserva de las pendientes es la parte que no se puede saltar: si no se
 * descontara, un usuario con 100 USDT podria abrir cien pedidos de 100 y el
 * operador veria cien pedidos de retiro saliendo de un mismo saldo.
 *
 * @param real       saldo retirable actual
 * @param pending    suma de los pedidos pendientes, en la misma unidad
 */
export const freeBalance = (real: number, pending: number): number => {
  // El saldo disponible nunca puede ser negativo: un `pending` corrupto (mas
  // grande que el propio saldo) no puede volver la cifra negativa y hacer que
  // cualquier comparacion posterior se comporte de forma rara.
  //
  // El saldo real tambien se recorta a 0. Un `real` negativo en la base de datos
  // es un estado corrupto, y tratarlo como 0 es lo seguro: el usuario no puede
  // retirar, que es lo unico sensato.
  const r = Math.max(0, real);
  const p = Math.max(0, pending);
  return Math.max(0, r - p);
};

/**
 * Los limites de `currency.ts` estan en USDT; aqui se trabaja en unidades.
 *
 * ESTA CONVERSION NO ES OPCIONAL. Los limites se convierten UNA vez, al importar
 * el modulo, y no en cada comparacion. Si se dejaran en USDT y se compararan
 * contra un `amount` en unidades, el minimo de 10 USDT (10 000) pasaria a
 * leerse como 10, que son 0,01 USDT: todos los retiros de entre 0,01 y 9,99 USDT
 * pasarian, que es justo lo contrario de lo que se quiere.
 *
 * `usdtToUnits` redondea hacia abajo, asi que un limite nunca queda por debajo
 * de lo que dice el texto: 10 USDT son 10 000 unidades exactas, y 25 000 USDT son
 * 25 000 000 exactas. No hay perdida en ninguno de los dos.
 */
const LIMITS = {
  /** 10 USDT. */
  minUsdt: usdtToUnits(WITHDRAWALS.min),
  /** 25 000 USDT. */
  maxUnits: usdtToUnits(WITHDRAWALS.maxPerTransaction),
  /** 25 000 USDT. */
  monthlyCapUnits: usdtToUnits(WITHDRAWALS.monthlyWinCap),
  /** 1 000 CUP son unas 8,33 USDT, y de ahi a unidades. */
  minCupUnits: usdtToUnits(WITHDRAWALS.minCup / CUP_PER_USDT),
} as const;

/**
 * Decide si un retiro se puede pedir.
 *
 * @param amount      importe pedido, en unidades internas
 * @param balances    saldo del usuario
 * @param pending     suma de retiros ya pendientes, en unidades internas
 * @param method      'usdt' para crypto, cualquier otro para CUP
 * @param paidThisMonth  lo ya retirado y liquidado este mes, para el tope mensual
 */
export const checkWithdrawal = (
  amount: number,
  balances: Balances,
  pending: number,
  method: 'usdt' | 'cup',
  paidThisMonth = 0,
  options: { skipMinimum?: boolean } = {},
): WithdrawalCheck => {
  const free = freeBalance(balances.real, pending);
  const deny = (
    denial: WithdrawalDenial,
    message: string,
  ): WithdrawalCheck => ({ ok: false, denial, message, freeBalance: free });

  // Un importe no entero o no positivo es un bug del cliente, no un intento de
  // fraude, pero se rechaza igual: un `amount` NaN acabaria en un `$inc: NaN`
  // que corrompe el saldo para siempre.
  if (!Number.isFinite(amount) || amount <= 0) {
    return deny('AMOUNT_NOT_POSITIVE', 'El monto debe ser mayor que cero.');
  }

  // El minimo depende de la via, y las dos cifras estan YA en unidades porque
  // vienen de `LIMITS`, no de `currency.ts`. Comparar aqui contra
  // `WITHDRAWALS.min` seria el error de unidades del que habla el aviso de arriba.
  //
  // `skipMinimum` existe porque el servicio ya comprueba el minimo por via con
  // mensajes propios, y duplicar la comprobacion aqui haria que el usuario viera
  // dos mensajes distintos segun el camino que tomara.
  const min = method === 'usdt' ? LIMITS.minUsdt : LIMITS.minCupUnits;
  if (!options.skipMinimum && amount < min) {
    return deny(
      'BELOW_MINIMUM',
      method === 'usdt'
        ? `El minimo de retiro es ${WITHDRAWALS.min} USDT.`
        : `El minimo de retiro por este metodo es ${WITHDRAWALS.minCup} CUP.`,
    );
  }

  // Tope por transaccion: protege al operador de un error de tecleo que vacie la
  // caja en una sola llamada. Los retiros grandes se parten en varios.
  if (amount > LIMITS.maxUnits) {
    return deny(
      'ABOVE_MAXIMUM',
      `El maximo por retiro es ${WITHDRAWALS.maxPerTransaction} USDT. ` +
      'Divide el retiro en varios.',
    );
  }

  // Tope mensual de ganancias. Es una medida de juego responsable, no de
  // tesoreria: frena a quien gana mucho y lo retira todo de golpe. No aplica a la
  // devolucion de un deposito, que por eso se comprueba aparte en el servicio.
  const monthlyRoom = LIMITS.monthlyCapUnits - paidThisMonth;
  if (monthlyRoom <= 0) {
    return deny(
      'ABOVE_MONTHLY_CAP',
      `Has alcanzado el tope mensual de ganancias retirables ` +
      `(${WITHDRAWALS.monthlyWinCap} USDT).`,
    );
  }
  if (amount > monthlyRoom) {
    return deny(
      'ABOVE_MONTHLY_CAP',
      `Solo te quedan ${formatUnits(monthlyRoom)} USDT de ganancia retirable ` +
      'este mes. Puedes retirar el resto en meses siguientes.',
    );
  }

  // EL SALDO QUE CUENTA ES `real`, NUNCA `real + play`.
  //
  // Si se admitiera `play`, el usuario vaciaria la plataforma sin haber depositado
  // nunca: el saldo promocional se genera de bonuses y de freerolls, y se
  // retirase se estaria cobrando dinero que la plataforma no ha recibido.
  //
  // El mensaje dice las dos cifras a proposito. Un usuario con 5 000 de `play` y
  // 0 de `real` que ve "saldo insuficiente" sin mas pensa que le han timado; ver
  // "tus 5 000 de promocion no son retirables" lo entiende.
  if (balances.real < amount) {
    return deny(
      'PROMOTIONAL_ONLY',
      `Solo puedes retirar saldo real. Tienes ${formatUnits(balances.real)} USDT ` +
      `retirables (tu saldo de promocion de ${formatUnits(balances.play)} USDT ` +
      'no es retirable).',
    );
  }

  // Y por ultimo, lo libre despues de las pendientes.
  //
  // OJO: se usa `balances.real`, NO `free`, para decidir el mensaje. `real >= amount`
  // ya se ha comprobado antes, asi que si llegamos aqui con `balances.real < amount`
  // seria el saldo el que limita y no las pendientes. Comparar con `free` daria el
  // mensaje equivocado en el caso de saldo justo.
  if (free < amount) {
    return deny(
      'EXCEEDS_FREE_BALANCE',
      balances.real < amount
        ? 'Saldo insuficiente.'
        : 'Saldo insuficiente considerando retiros pendientes en proceso: ' +
          `ya tienes ${formatUnits(pending)} USDT comprometidos y solo te ` +
          `quedan ${formatUnits(free)} USDT libres.`,
    );
  }

  return { ok: true, freeBalance: free };
};

/**
 * Cuanto se le descuenta al usuario cuando el operador aprueba un retiro.
 *
 * Todo el importe, no el neto: la comision la cobra la pasarela de cobro, no la
 * plataforma, asi que el saldo del usuario baja por el total. Cobrar tambien la
 * comision seria cobrarla dos veces.
 */
export const debitOnSettle = (amount: number): number => amount;

/**
 * Si un retiro se puede liquidar ahora mismo.
 *
 * Es la segunda mitad del problema, y la que no hacia el modulo anterior.
 * Entre pedir y aprobar el jugador puede jugar y vaciar `real`, asi que la
 * comprobacion se repite aqui contra el saldo DEL MOMENTO, no contra el que
 * tenia cuando pidio.
 *
 * @returns por que no, o `null` si se puede
 */
export const canSettle = (
  amount: number,
  realNow: number,
): WithdrawalDenial | null => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'AMOUNT_NOT_POSITIVE';
  }
  if (realNow < amount) {
    return 'EXCEEDS_FREE_BALANCE';
  }
  return null;
};
