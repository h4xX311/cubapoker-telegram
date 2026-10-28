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
import { unitsToUsdt, usdtToUnits } from './units';

/**
 * Horas UTC de los freerolls diarios.
 *
 * Cuatro ediciones al día, cada seis horas. La hora con más tráfico (00 UTC,
 * 20:00 en Cuba) lleva el premio mayor. Así hay un freeroll asequible en cada
 * franja y el jugador no depende de una única hora.
 */
export const HORAS_FREEROLL_UTC = [0, 6, 12, 18] as const;

/** Premio de cada franja, en USDT. */
export const PREMIO_FREEROLL_POR_HORA: Record<number, number> = {
  0: 50,
  6: 20,
  12: 10,
  18: 5,
};

/** Separación entre ediciones. Se conserva para textos y pruebas. */
export const HORAS_ENTRE_FREEROLLS = 6;

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
 * Si hay al menos uno, se completa la mesa y se juega. La decision fue explicita:
 * es preferible un torneo con un jugador y asientos automaticos que un torneo
 * cancelado.
 */
export const MIN_JUGADORES_PARA_ARRANCAR = 2;

/** Fichas con las que empieza cada jugador. No son dinero: son puntos del torneo. */
export const FICHAS_INICIALES_FREEROLL = 1000;

/** Ciegas del freeroll. 100 ciegas grandes de stack, que es un torneo comodo. */
export const CIEGA_PEQUENA_FREEROLL = 5;
export const CIEGA_GRANDE_FREEROLL = 10;

/**
 * Premio del siguiente slot, en unidades internas.
 *
 * Es dinero de la CASA, no una suma de entradas. El valor se decide por la
 * hora UTC del slot y se puede fijar para todos con
 * `FREEROLL_HOURLY_PRIZE_USDT` (solo operaciones y pruebas).
 */
export function premioDelSlot(inicio: Date): number {
  const crudo = Number(process.env.FREEROLL_HOURLY_PRIZE_USDT ?? '');
  if (Number.isFinite(crudo) && crudo > 0) return usdtToUnits(crudo);

  const hora = inicio.getUTCHours();
  const usdt = PREMIO_FREEROLL_POR_HORA[hora] ?? FREEROLL_PRIZES[0];
  return usdtToUnits(usdt);
}

/** Premio del proximo freeroll, en unidades internas. */
export function premioHorarioUnits(ahora: Date = new Date()): number {
  return premioDelSlot(proximoInicio(ahora));
}

/** Cuantas plazas paga el freeroll. Sale del reparto ya decidido (50/30/20). */
export const PLAZAS_PAGADAS_FREEROLL = FREEROLL_PAYOUT.length;

/** Tamano objetivo del campo. Es el techo de inscripcion, no la condicion de arranque. */
export const TAMANO_FREEROLL = FREEROLL_TARGET_FIELD;

/**
 * Siguiente cuarto de dia con freeroll.
 *
 * Si ahora son las 05:59:30, devuelve las 06:00. Si son las 06:00:00, devuelve
 * las 12:00: el de las 06:00 ya deberia existir y estar arrancando.
 */
export function proximoInicio(ahora: Date = new Date()): Date {
  const base = new Date(ahora);
  base.setUTCSeconds(0, 0);

  // Se prueban hoy y mañana para cubrir el salto de medianoche.
  for (let dia = 0; dia <= 1; dia++) {
    for (const hora of HORAS_FREEROLL_UTC) {
      const candidato = new Date(
        Date.UTC(
          base.getUTCFullYear(),
          base.getUTCMonth(),
          base.getUTCDate() + dia,
          hora,
          0,
          0,
          0,
        ),
      );
      if (candidato.getTime() > ahora.getTime()) return candidato;
    }
  }

  // Inalcanzable con una lista no vacia, pero deja un valor seguro.
  return new Date(ahora.getTime() + HORAS_ENTRE_FREEROLLS * 60 * 60 * 1000);
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
  /** Premio del slot, en unidades internas. */
  premioUnits: number;
  /** Premio del slot, en USDT, listo para la interfaz. */
  premioUsdt: number;
}

/**
 * Los proximos `cantidad` slots, empezando por el siguiente en punto.
 *
 * Se usa en la API para pintar la lista del lobby. No toca la base de datos: si un slot no
 * tiene campo creado todavia, la UI lo muestra igual como "proximo".
 */
export function slotsProximos(
  cantidad = 8,
  ahora: Date = new Date(),
): SlotFreeroll[] {
  const slots: SlotFreeroll[] = [];
  let inicio = proximoInicio(ahora);

  for (let i = 0; i < cantidad; i++) {
    const premioUnits = premioDelSlot(inicio);
    slots.push({
      clave: claveSlot(inicio),
      inicio: new Date(inicio),
      finRegistro: finRegistroTardio(inicio),
      premioUnits,
      premioUsdt: unitsToUsdt(premioUnits),
    });
    inicio = proximoInicio(new Date(inicio.getTime() + 1000));
  }

  return slots;
}
