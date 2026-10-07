/**
 * Rutas del jugador: quien soy y cuanto tengo.
 *
 * ------------------------------------------------------------------
 * POR QUE EXISTE ESTE FICHERO
 *
 * La Mini App pide `GET /api/me` desde el arranque (`api.me()`), y ese endpoint NO EXISTIA.
 * No habia ningun router de usuario montado: solo `/api/game`, `/api/monetization`,
 * `/api/payment` y `/api/admin`.
 *
 * Lo que pasaba al abrir la aplicacion:
 *
 *   1. La web pide `/api/me`.
 *   2. No hay ruta, asi que cae en el `catch-all` que sirve la SPA.
 *   3. El servidor responde con el HTML de la pagina, con HTTP 200.
 *   4. El cliente hace `JSON.parse` de HTML y revienta. Lo que se queda es `undefined`.
 *   5. `user.balance.total` es `undefined`, y la pantalla de saldo usa `?? 0`, asi que
 *      sale 0.
 *   6. `const canAfford = balance >= tier.buyIn` → `0 >= 1000` → false.
 *   7. TODOS los botones salen deshabilitados con el texto "Necesitas 1 USDT".
 *
 * O sea: **la aplicacion jamas ha podido saber quien es el jugador ni cuanto tiene.** Por eso
 * no habia mesa a la que sentarse ni nada que apostar, y no era un fallo del motor de poker
 * ni de la mesa: era un endpoint que no existia y que el `catch-all` hacia pasar por
 * correcto.
 *
 * Lo que mas engaña es el HTTP 200. Un 404 se ve; un 200 con HTML dentro parece que todo
 * funciona. Por eso la ausencia de la ruta se manifesto como "el saldo me sale en cero" y
 * no como "el servidor no tiene esa ruta".
 *
 * ------------------------------------------------------------------
 * EL SALDO, TAL COMO LO ESPERA LA INTERFAZ
 *
 * La web pide un objeto `Balance` con cuatro campos, y son los cuatro los que se usan:
 *
 *   real         saldo retirable (USDT)
 *   play         fichas de promocion (no retirables)
 *   total        real + play, que es lo que puede gastar jugando
 *   withdrawable alias de `real`, para la pantalla de retiro
 *
 * En la base solo existen `real` y `play`. `total` y `withdrawable` se calculan aqui, y se
 * calculan SIEMPRE, aunque valgan cero: que falte un numero en la respuesta es lo que
 * provoco este fallo, asi que no se deja que dependa de que el documento lo traiga.
 */

import { Router, Request, Response } from 'express';
import { User } from '../models/User';
import { getAuthedTelegramId, requireTelegramAuth } from '../middleware/telegramAuth';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Que exista el documento del jugador.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTA FUNCION EXISTE
 *
 * `GET /api/me` se llama al abrir la aplicacion, y es la primera peticion que hace un
 * jugador NUEVO: no tiene documento de usuario. Antes, ese primer `/api/me` devolvia una
 * sesion sintetica con saldos a cero y ya. Lo siguiente era el deposito, y ahi ya reventaba:
 * `paymentService.createDepositOrder` busca el usuario y, si no esta, responde
 * "Usuario no encontrado".
 *
 * O sea: **un jugador que nunca habia entrado no podia depositar.** Nunca pudo jugar.
 *
 * Y no hacia falta ser nuevo en el sentido de "sin cuenta en otro lado": bastaba con haber
 * borrado el documento, o con entrar por primera vez desde una base recien creada. Es
 * exactamente el camino del primer usuario, que es el que mas se parece a la prueba de
 * fuego y el que nunca se habia recorrido entero.
 *
 * Se crea aqui y no en el deposito porque `/api/me` se llama SIEMPRE al arrancar: es la
 * peticion masTemprana y la mas universal. Si el usuario existe antes que nada, todo lo
 * demas (depositar, sentarse, registrarse en un campo) tiene a quien preguntarle.
 *
 * `upsert` con `setOnInsert`: si el usuario ya existe no se toca nada, y en particular NO
 * se tocan los saldos. Escribir el saldo aqui seria la forma facil de inventar dinero.
 *
 * Y el `playerId` se guarda como numero, no como cadena, para que el mismo jugador no
 * acabe con dos documentos: uno creado aqui y otro creado por el bot, que si usa numero.
 */
async function asegurarUsuario(
  telegramId: number,
  datos?: { first_name?: string; username?: string },
): Promise<void> {
  await User.updateOne(
    { telegramId },
    {
      $setOnInsert: {
        telegramId,
        firstName: datos?.first_name ?? 'Jugador',
        username: datos?.username,
        balance: { real: 0, play: 0 },
        stats: {
          handsPlayed: 0,
          handsWon: 0,
          tablesJoined: 0,
          freerollsPlayed: 0,
          totalRakePaid: 0,
          totalFreerollWon: 0,
        },
        activeTableId: null,
      },
    },
    { upsert: true },
  );
}

/**
 * Quien soy, con el saldo listo para pintar.
 *
 * Las unidades de la base son internas (1 USDT = 1000 unidades), asi que lo que se
 * devuelve es exactamente lo que hay, en las mismas unidades que usa la web. La conversion
 * a USDT la hace el cliente al formatear, no aqui: si se dividiera en el servidor, el
 * `balance.real` de `Deposit.tsx` y el `balance.total` de `Balance.tsx` dejarian de hablar
 * el mismo idioma.
 */
router.get('/me', requireTelegramAuth, async (req: Request, res: Response) => {
  try {
    const telegramId = getAuthedTelegramId(req);

    // Se asegura de que el jugador existe ANTES de responder. Antes se devolvia una sesion
    // sintetica con ceros y ya, y el deposito de ese mismo jugador fallaba despues con
    // "Usuario no encontrado": un jugador nuevo no podia entrar nunca.
    const delTelegram = (req as any).telegramUser as
      | { first_name?: string; username?: string }
      | undefined;
    await asegurarUsuario(telegramId, delTelegram);

    const user = await User.findOne({ telegramId });

    if (!user) {
      // No es un error: se responde con una sesion vacia y saldos a cero. La interfaz ya
      // sabe pintar "0 USDT", y arrancar con un null haria que la pantalla se rompiera en
      // vez de mostrar un saldo de cero.
      //
      // Y sobre todo se responde JSON, nunca HTML. Este endpoint existe precisamente
      // porque el `catch-all` de la SPA contestaba a un sitio que deberia ser JSON.
      res.json({
        success: true,
        user: {
          telegramId,
          firstName: 'Jugador',
          lastName: undefined,
          username: undefined,
          balance: { real: 0, play: 0, total: 0, withdrawable: 0 },
          stats: {
            handsPlayed: 0,
            handsWon: 0,
            tablesJoined: 0,
            freerollsPlayed: 0,
            totalRakePaid: 0,
            totalFreerollWon: 0,
          },
          activeTableId: null,
          vip: null,
        },
      });
      return;
    }

    const real = user.balance?.real ?? 0;
    const play = user.balance?.play ?? 0;

    res.json({
      success: true,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        balance: {
          real,
          play,
          total: real + play,
          // `real` es lo unico retirable: el `play` se desbloquea jugando, no se retira.
          withdrawable: real,
        },
        stats: user.stats,
        // `activeTableId` no es la fuente de verdad de donde esta el jugador (eso son los
        // asientos, y lo que hace `GET /game/my-table`), pero se devuelve para que la
        // pantalla pueda mostrar un aviso de "tienes una partida en curso" sin preguntar
        // otra vez. Si los dos no coinciden, manda el asiento.
        activeTableId: user.activeTableId ?? null,
        vip: null,
      },
    });
  } catch (error) {
    logger.error('Error en GET /me:', error);
    res.status(500).json({ error: 'No se pudo cargar la sesion.' });
  }
});

export default router;