/**
 * CUENTAS ATRAS
 * =============
 *
 * El freeroll empieza a una hora fija, asi que la interfaz tiene que responder a una sola
 * pregunta todo el tiempo: "¿cuanto falta?". Eso se calcula aqui y en un solo sitio, porque
 * lo usan el lobby y la pagina de freerolls, y dos formulas distintas darian dos numeros
 * distintos en la misma pantalla.
 *
 * ------------------------------------------------------------------
 * POR QUE NO SE FORMATEA EN EL SERVIDOR
 *
 * El servidor manda la hora ISO del inicio. Si mandara "faltan 12:34", ese texto caduca en
 * cuanto sale de la respuesta: basta con que la red tarde un segundo para que el jugador vea
 * una cuenta atras que ya no es cierta. La hora absoluta no caduca.
 *
 * ------------------------------------------------------------------
 * LA HORA LOCAL ES LA DEL TELEFONO
 *
 * `horaLocal` usa la zona del dispositivo. Es lo correcto: el jugador piensa en su reloj, no
 * en UTC. El servidor programa en UTC (ver `config/freeroll.ts`), pero eso es asunto suyo.
 */

/** Segundos que faltan para una fecha ISO. Nunca negativo. */
export function segundosHasta(
  iso: string | null | undefined,
  ahora: number = Date.now(),
): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((new Date(iso).getTime() - ahora) / 1000));
}

/** Cuenta atras legible: `mm:ss` si falta menos de una hora, `1h 05m` si falta mas. */
export function fmtCuenta(segundos: number): string {
  if (segundos <= 0) return '00:00';

  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;

  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Hora del jugador, sin segundos: "20:00". */
export function horaLocal(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
