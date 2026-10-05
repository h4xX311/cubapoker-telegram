import { User } from '../models/User';
import { UNLOCK_RATES, type UnlockContext } from '../config/product';
import { logger } from '../utils/logger';

/**
 * Desbloqueo de Promotional Dollars (P$) a saldo retirable.
 *
 * ------------------------------------------------------------------
 * QUE ES ESTO, EN UNA FRASE
 *
 * `balance.play` (las P$) no es dinero bloqueado para siempre: es dinero que se
 * puede convertir en dinero real, pero solo JUGANDO. Es el mecanismo de
 * CoinPoker y sustituye a la regla que teniamos antes ("el premio del freeroll
 * no se retira nunca"), que era mas simple pero dejaba al usuario con un saldo
 * que no podia usar para nada.
 *
 * ------------------------------------------------------------------
 * EL MECANISMO DE COINPOKER
 *
 * De coinpoker.com/help/promotional-dollars/:
 *
 *   "This Promotional Dollar balance is not withdrawable, but this currency
 *    can become withdrawable through playing CoinPoker games."
 *
 *   | Game       | Unlock Ratio |
 *   | Cash Games | 1:10         |
 *   | Tournaments| 1:1          |
 *
 * Con la explicacion del 1:10: "You buy in for $1 of Promotional Dollars, wager
 * $1, and cash out later for $1. This means that $0.10 of your cash-out amount
 * will be added to your regular Total Balance, and $0.90 will return to your
 * Promotional Balance."
 *
 * ------------------------------------------------------------------
 * POR QUE COBRAMOS EN EL BUY-IN Y NO EN LAS GANANCIAS
 *
 * CoinPoker lo hace sobre el cash-out. Aqui se cobra al comprar la entrada.
 *
 * Es una diferencia deliberada, con tres ventajas:
 *
 *  1. No necesita seguir el origen de cada ficha para saber cuanto es P$ y
 *     cuanto es dinero real. En una mesa con buy-in mixto, las fichas son de las
 *     dos cosas a la vez y el motor no lleva esa cuenta.
 *
 *  2. No se puede abusar de la conversion: la tasa es plana sobre el VOLUMEN
 *     jugado, no sobre las ganancias. Un jugador que gana mucho no desbloquea
 *     mas por unidad jugada. El unico modo de desbloquear mas es jugar mas, y
 *     jugar mas significa arriesgar.
 *
 *  3. Es monotono: la conversion ocurre exactamente una vez por buy-in, sin
 *     depender de cuando termina una mano ni de si el jugador se va a mitad.
 *
 * El efecto neto es el mismo que en CoinPoker (se extrae ~10% de las P$ que se
 * jueguen), pero sin la complejidad de rastrear el origen del saldo.
 *
 * ------------------------------------------------------------------
 * POR QUE 1:10 Y NO 1:1 EN LOS CAMPOS
 *
 * En CoinPoker los torneos desbloquean 1:1. Aqui NO, y la razon es especifica
 * de este producto: los campos y freerolls de CubaPoker dan ENTRADA GRATIS. Con
 * 1:1, un freeroll seria dinero retirable sin haber depositado nunca, que es un
 * dreno. Con 1:10, el premio del freeroll es P$ y hay que jugarlas para sacarle
 * valor, y se pierde el 90% en el camino.
 */

/** Resultado de intentar desbloquear. */
export interface UnlockResult {
  /** Cuanto se desconto de `play`. */
  fromPlay: number;
  /** Cuanto de eso se convirtio en saldo retirable. */
  unlocked: number;
  /** Cuanto de `play` se consumio y NO se_unlockeo. */
  consumed: number;
}

export const unlockService = {
  /**
   * Reparte un buy-in entre `play` y `real`, desbloqueando la parte que
   * corresponde.
   *
   * El orden importa: primero se consume `play` (que es lo que el producto
   * quiere gastar antes, para preservar el saldo retirable del usuario) y de
   * esa parte se desbloquea el ratio. Si se desbloqueara de `real`, el usuario
   * perderia dinero real para ganar dinero real.
   *
   * @param context  en que tipo de juego se esta entrando (define el ratio)
   * @param amount   buy-in total
   */
  async splitBuyIn(
    telegramId: number,
    amount: number,
    context: UnlockContext,
  ): Promise<UnlockResult> {
    const rate = UNLOCK_RATES[context];

    if (rate <= 0 || amount <= 0) {
      return { fromPlay: 0, unlocked: 0, consumed: 0 };
    }

    const user = await User.findOne({ telegramId });
    if (!user) return { fromPlay: 0, unlocked: 0, consumed: 0 };

    const fromPlay = Math.min(user.balance.play, amount);

    if (fromPlay <= 0) {
      return { fromPlay: 0, unlocked: 0, consumed: 0 };
    }

    // Redondeo hacia ABAJO en el desbloqueo: el operador nunca regala una
    // fraccion. Con 1 P$ y ratio 0,1 son 0,1 USDT; redondeando al alza, 7 P$
    // darían 0,7 y con 3 P$ darían 0,3: se podrian extraer 0,1 por cada 0,1
    // jugado, que es extraer el 100%.
    const unlocked = Math.floor(fromPlay * rate * 100) / 100;

    await User.updateOne(
      { telegramId },
      {
        $inc: {
          'balance.play': -fromPlay,
          'balance.real': unlocked,
        },
      },
    );

    return {
      fromPlay,
      unlocked,
      consumed: fromPlay - unlocked,
    };
  },

  /**
   * Cuanto puede extraer un usuario de su saldo `play`.
   *
   * Solo para la interfaz: es un techo teorico si jugase todo su `play` a
   * ratio 1:10 sin perder. En la practica es mucho menos, porque perder jugando
   * es parte del juego.
   */
  maxExtractable(playBalance: number): number {
    return Math.floor(playBalance * UNLOCK_RATES.cash * 100) / 100;
  },

  /**
   * Desbloqueos acumulados de un usuario, para la interfaz.
   *
   * Se deriva de la diferencia entre el play que ha recibido y el que le queda,
   * mas lo que ha desbloqueado: no hace falta llevar un contador aparte.
   */
  async summary(telegramId: number) {
    const user = await User.findOne({ telegramId });
    if (!user) return null;

    const rate = UNLOCK_RATES.cash;
    return {
      play: user.balance.play,
      real: user.balance.real,
      /** Techo si jugase todo su play sin perder nada. */
      maxExtractable: this.maxExtractable(user.balance.play),
      rate,
      /** Cada N USDT jugados se desbloquea 1 USDT retirable. */
      ratioLabel: `1:${Math.round(1 / rate)}`,
    };
  },

  /**
   * Texto para la interfaz. Tiene que explicar la regla, no solo mostrarla.
   *
   * Un jugador que no entiende el 1:10 cree que le estan robando cuando ve que
   * su saldo baja. Decirlo de antemano en el momento del deposito es lo que
   * evita el reclamo.
   */
  disclosure(): string {
    return (
      'Tu saldo de promoción no se puede retirar directamente. Sirve para jugar ' +
      `y, al usarlo, se desbloquea 1 de cada ${Math.round(1 / UNLOCK_RATES.cash)} ` +
      'a saldo retirable. El resto se consume jugando, así que no es un saldo ' +
      'guardado: es saldo en juego.'
    );
  },

  /** Log de un desbloqueo, para el informe del operador. */
  log(result: UnlockResult, context: UnlockContext): void {
    if (result.unlocked > 0) {
      logger.info(
        `Desbloqueo ${context}: ${result.fromPlay} de play -> ` +
        `${result.unlocked} retirable, ${result.consumed} consumido`,
      );
    }
  },
};
