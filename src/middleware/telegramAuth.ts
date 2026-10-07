import crypto from 'crypto';
import { logger } from '../utils/logger';
import { Request, Response, NextFunction } from 'express';

// ------------------------------------------------------------------
// EL TOKEN, LEIDO CUANDO SE USA Y NO AL CARGAR EL MODULO
//
// Antes:
//
//     const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
//
// Eso se evaluaba al IMPORTAR este fichero. Y en ES los imports se ejecutan ANTES de
// cualquier linea del modulo que importa: `bot.ts` hace `import ... from './middleware/
// telegramAuth'` y despues `dotenv.config()`. O sea que aqui se leia el token ANTES de que
// dotenv cargase el `.env`, y se quedaba con `''`.
//
// En Render no se ve, porque ahi Render inyecta las variables de entorno en el proceso antes
// de arrancar Node. Pero en local (`.env`) el bypass de desarrollo lo tapa y el modulo
// valida contra una cadena vacia, que no es el token de nadie. Es exactamente el tipo de
// fallo que aparece en una maquina y no en otra, y que nadie sabe mirar.
//
// Leyendolo en cada llamada desaparece la dependencia del orden de carga: si el token esta,
// esta.
// El `.trim()` NO es cosmetico, y es la diferencia entre funcionar y no.
//
// `bot.ts` crea el bot con `process.env.TELEGRAM_BOT_TOKEN?.trim()`. Aqui, sin recortar, se
// calculaba la firma con el token CRUDO.
//
// Si la variable tiene un espacio o un salto de linea al final --que es lo que pasa al
// pegarla en el panel de Render-- pasan DOS cosas a la vez:
//
//   - el bot se crea con el token recortado, asi que `getMe` funciona, el webhook se registra
//     y `/telegram/setup` responde bien con el @username correcto
//   - la firma se calcula con el token sin recortar, asi que `secretKey` sale DISTINTA y el
//     hash no cuadra NUNCA
//
// Ese es exactamente el sintoma que se diagnostico un rato: el token correcto y la firma
// invalida, a la vez, sin que pareciera contradictorio. No lo es: son dos lecturas distintas
// de la misma variable.
//
// El token se lee por los DOS lados con el mismo recorte, o no funciona nunca.
const botToken = (): string => (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const MAX_AGE_SECONDS = 60 * 60; // 1 hora

/**
 * Valida el `initData` de Telegram WebApp.
 *
 * Telegram firma los datos del Mini App con HMAC-SHA256 usando una clave
 * derivada del token del bot. Sin esta validacion, cualquier persona puede
 * llamar a la API arbitrariamente (suplantar usuarios, acreditar saldo, etc).
 *
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData: string): { valid: boolean; user?: any; error?: string } {
  if (!initData) return { valid: false, error: 'initData ausente' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { valid: false, error: 'initData mal formado' };
  }

  const hash = params.get('hash');
  if (!hash) return { valid: false, error: 'hash ausente' };

  params.delete('hash');

  // 1. Comprobar antigüedad para evitar reuso de datos viejos
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Number.isNaN(authDate)) return { valid: false, error: 'auth_date ausente' };

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AGE_SECONDS) {
    return { valid: false, error: 'initData expirado' };
  }

  // 2. Construir data_check_string con los campos ordenados
  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  // 3. Derivar secret_key = HMAC_SHA256(key: "WebAppData", msg: bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken()).digest();

  // 4. Calcular hash esperado
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // 5. Comparacion en tiempo constante
  const computedBuffer = Buffer.from(computedHash, 'hex');
  const providedBuffer = Buffer.from(hash, 'hex');

  if (
    computedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(computedBuffer, providedBuffer)
  ) {
    return { valid: false, error: 'firma invalida' };
  }

  // 6. Extraer usuario ya validado
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return { valid: false, error: 'usuario ausente' };
    return { valid: true, user };
  } catch {
    return { valid: false, error: 'usuario mal formado' };
  }
}

/**
 * Middleware que exige un Mini App autenticado.
 * Identifica al usuario por su Telegram ID real, no por lo que el cliente envie.
 */
export const requireTelegramAuth = (req: Request, res: Response, next: NextFunction): void => {
  // --- Bypass de desarrollo ---
  // Permite probar la API sin Telegram (scripts, Postman, unit tests).
  // Bloqueado por diseno en produccion: si esto se activara en un entorno
  // publico, cualquiera suplantaria cualquier cuenta.
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true') {
    const devId = Number(req.headers['x-dev-auth'] || process.env.DEV_AUTH_ID || 1);
    if (Number.isFinite(devId) && devId > 0) {
      (req as any).telegramUser = {
        id: devId,
        first_name: 'Dev',
        username: 'dev_user',
      };
      next();
      return;
    }
  }

  // Aceptamos el initData en el header o en el body
  const initData =
    (req.headers['x-telegram-init-data'] as string) ||
    (req.body && typeof req.body.initData === 'string' ? req.body.initData : '') ||
    '';

  const result = validateInitData(initData);

  if (!result.valid) {
    // Distinguir los dos casos mas comunes para que el usuario sepa que hacer:
    //  - sin initData: abrio la URL en un navegador en vez de dentro de Telegram
    //  - firma invalida: la sesion expiro o el bot token no coincide
    const outsideTelegram = !initData;

    // ------------------------------------------------------------------
    // EL MOTIVO, EN EL LOG. SIEMPRE.
    //
    // Hay SEIS motivos distintos de rechazo (`validateInitData` los distingue uno a uno:
    // 'initData ausente', 'hash ausente', 'initData expirado', 'firma invalida', 'usuario
    // ausente', 'usuario mal formado') y el cliente los ve TODOS igual: "tu sesion expiro".
    //
    // Eso convierte un fallo de un segundo en una adivinanza de media hora. Se diagnostico
    // entero un despliegue por un 401 cuyo motivo real era 'initData expirado', mientras
    // se sospechaba del token del bot. El token era correcto.
    //
    // El motivo se devuelve en la respuesta (`detail`) y ademas se deja escrito en el log,
    // que es donde se mira cuando algo falla en produccion y no hay cliente delante.
    // ------------------------------------------------------------------
    logger.warn(
      `Sesion rechazada (${outsideTelegram ? 'fuera de Telegram' : 'dentro de Telegram'}): ` +
      `${result.error}. initData: ${initData ? `si, ${initData.length} caracteres` : 'vacio'}.`,
    );

    // ------------------------------------------------------------------
    // SI EL TOKEN TIENIESPACIOS ALREDEDOR
    //
    // Se dice SI o NO, y nunca el token: es un secreto y no va a un log. Pero es la
    // diferencia entre "el token esta mal" y "el token tiene un salto de linea pegado", que
    // producen el MISMO sintoma (firma invalida con el bot correcto) y se diagnostican igual
    // de mal.
    //
    // Si esto dice que hay espacios, hay que quitar el salto de linea en el panel, no seguir
    // mirando la aplicacion.
    // ------------------------------------------------------------------
    const crudo = process.env.TELEGRAM_BOT_TOKEN || '';
    if (crudo !== crudo.trim()) {
      logger.warn(
        'ATENCION: TELEGRAM_BOT_TOKEN tiene espacios o saltos de linea al principio o al ' +
        'final. El bot funciona (usa el token recortado) pero la firma no cuadra nunca ' +
        '(usa el token crudo). Quitalos en el panel de Render.',
      );
    }

    res.status(401).json({
      error: outsideTelegram
        ? 'Esta aplicacion solo funciona dentro de Telegram.'
        : 'Tu sesion expiro. Reabre la aplicacion desde el bot.',
      code: outsideTelegram ? 'OPEN_FROM_TELEGRAM' : 'AUTH_REQUIRED',
      detail: result.error,
    });
    return;
  }

  (req as any).telegramUser = result.user;
  next();
};

/**
 * Helper para obtener el Telegram ID del usuario autenticado.
 */
export const getAuthedTelegramId = (req: Request): number => {
  return (req as any).telegramUser.id;
};

export { validateInitData };
