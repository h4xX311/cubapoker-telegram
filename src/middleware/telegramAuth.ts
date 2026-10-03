import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
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
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();

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
