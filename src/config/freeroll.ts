/**
 * EL RELOJ DE LOS FREEROLLS
 * =========================
 *
 * Un freeroll de CubaPoker no empieza cuando se llena: empieza a su hora, como un torneo
 * programado. Eso obliga a que alguien decida, en un solo sitio, cual es la proxima hora,
 * cuando se cierra la inscripcion y hasta cuando se puede entrar tarde.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTE ARCHIVO ES SOLO FUNCIONES DE FECHA
 *
 * Porque el horario se consulta desde tres sitios distintos y los tres tienen que decir lo
 * mismo:
 *
 *   1. El planificador del bot, que abre el campo a su hora.
 *   2. La API, que pinta la cuenta atras en el lobby.
 *   3. La prueba automatica, que comprueba los bordes.
 *
 * Si la regla se escribiera tres veces, el dia que una cambie el jugador veria una hora en
 * el lobby y el campo arrancaria a otra. Aqui no hay base de datos ni red: se puede probar
 * con un `new Date()` cualquiera.
 *
 * ------------------------------------------------------------------
 * LAS HORAS SON EN UTC, Y ESO ES A PROPOSITO
 *
 * Todos los husos de Cuba y Latinoamerica van en horas enteras respecto a UTC, asi que un
 * corte en :00 UTC tambien es un corte en :00 local. Guardar la hora en UTC evita el clasico
 * fallo del cambio de horario: un torneo que "empieza a las 20:00" y un dia empieza a las
 * 19:00 porque el reloj local se movio.
 *
 * La interfaz convierte a la hora del jugador al pintar. El documento guarda UTC.
 */

import { FREEROLL_PAYOUT, FREEROLL_PRIZES, FREEROLL_TARGET_FIELD } from './product';
import { usdtToUnits } from './units';

/** Cada cuantas horas hay un freeroll. */
export const HORAS_ENTRE_FREEROLLS = 1;

/**
 * Minutos de registro tardio DESPUES de la hora de inicio.
 *
 * Decision del 23 de octubre: 12 minutos. Un jugador que abre el bot a las 20:03 y ve que el
 * torneo de las 20:00 ya empezo todavia puede entrar. Sin esto, el que llega tres minutos
 * tarde se queda fuera y no entiende por que.
 */
export const MINUTOS_REGISTRO_TARDIO = 12;

/**
 * Jugadores minimos para que el torneo no se cancele.
 *
 * Si hay al menos uno, se rellena con bots hasta dos y se juega. La decision fue explicita:
 * es preferible un torneo con un humano y un bot que un torneo cancelado.
 */
export const MIN_JUGADORES_PARA_ARRANCAR = 2;

/** Fichas con las que empieza cada jugador. No son dinero: son puntos del torneo. */
export const FICHAS_INICIALES_FREEROLL = 1000;

/** Ciegas del freeroll. 100 ciegas grandes de stack, que es un torneo comodo. */
export const CIEGA_PEQUENA_FREEROLL = 5;
export const CIEGA_GRANDE_FREEROLL = 10;

/**
 * Premio del freeroll horario, en unidades internas.
 *
 * Es dinero de la CASA, no una suma de entradas. Se puede subir con
 * `FREEROLL_HOURLY_PRIZE_USDT` sin tocar codigo.
 *
 * Por defecto se usa el escalon mas bajo de `FREEROLL_PRIZES` (1 USDT). Un freeroll cada
 * hora con un premio mayor seria un gasto de adquisicion que hay que decidir con numeros de
 * usuarios, no antes de tenerlos.
 */
export function premioHorarioUnits(): number {
  const crudo = Number(process.env.FREEROLL_HOURLY_PRIZE_USDT ?? '');
  const usdt =
    Number.isFinite(crudo) && crudo > 0 ? crudo : FREEROLL_PRIZES[0];
  return usdtToUnits(usdt);
}

/** Cuantas plazas paga el freeroll. Sale del reparto ya decidido (50/30/20). */
export const PLAZAS_PAGADAS_FREEROLL = FREEROLL_PAYOUT.length;

/** Tamano objetivo del campo. Es el techo de inscripcion, no la condicion de arranque. */
export const TAMANO_FREEROLL = FREEROLL_TARGET_FIELD;

/**
 * Proximo inicio en punto.
 *
 * Si ahora son las 19:59:30, devuelve las 20:00. Si son las 20:00:00, devuelve las 21:00:
 * el de las 20:00 ya deberia existir y estar arrancando, no abrirse.
 */
export function proximoInicio(ahora: Date = new Date()): Date {
  const inicio = new Date(ahora);
  inicio.setUTCMinutes(0, 0, 0);

  if (inicio.getTime() <= ahora.getTime()) {
    inicio.setUTCHours(inicio.getUTCHours() + HORAS_ENTRE_FREEROLLS);
  }

  return inicio;
}

/**
 * Identificador del slot: `2026-10-23T20`.
 *
 * Es la clave del campo (`fieldId` y `tierId`). Al llevar la hora dentro, el indice unico
 * `un_campo_vivo_por_nivel` impide que dos procesos abran DOS campos para la misma hora, y a
 * la vez permite que el freeroll de las 20:00 siga jugandose mientras el de las 21:00 ya
 * esta abierto.
 */
export function claveSlot(inicio: Date): string {
  return inicio.toISOString().slice(0, 13);
}

/** Cuando se cierra el registro tardio de un slot. */
export function finRegistroTardio(inicio: Date): Date {
  return new Date(inicio.getTime() + MINUTOS_REGISTRO_TARDIO * 60_000);
}

export interface SlotFreeroll {
  clave: string;
  inicio: Date;
  finRegistro: Date;
}

/**
 * Los proximos `cantidad` slots, empezando por el siguiente en punto.
 *
 * Se usa en la API para pintar la lista del lobby. No toca la base de datos: si un slot no
 * tiene campo creado todavia, la UI lo muestra igual como "proximo".
 */
export function slotsProximos(
  cantidad = 6,
  ahora: Date = new Date(),
): SlotFreeroll[] {
  const slots: SlotFreeroll[] = [];
  let inicio = proximoInicio(ahora);

  for (let i = 0; i < cantidad; i++) {
    slots.push({
      clave: claveSlot(inicio),
      inicio: new Date(inicio),
      finRegistro: finRegistroTardio(inicio),
    });
    inicio = new Date(
      inicio.getTime() + HORAS_ENTRE_FREEROLLS * 60 * 60 * 1000,
    );
  }

  return slots;
}
