/**
 * Botes laterales (side pots).
 *
 * ------------------------------------------------------------------
 * EL BUG QUE ESTA FUNCION ARREGLA
 *
 * El motor repartia el BOTE ENTERO entre los ganadores de la mejor mano. Eso es
 * incorrecto en cuanto dos jugadores apostan cantidades distintas, y es
 * exactamente lo que pasa en un campo.
 *
 * El caso:
 *
 *   A  se all-in por 100     (poco stack)
 *   B  se all-in por 500     (stack medio)
 *   C  tiene 5 000, iguala 500
 *
 * Bote total 1 100. El reparto correcto es:
 *
 *   Bote principal   100 x 3 =  300   -> lo pueden ganar A, B y C
 *   Bote lateral     400 x 2 =  800   -> solo B y C pusieron mas de 100
 *
 * Si A gana la mano se lleva SOLO los 300. Los 800 no los puso nadie para
 * ganarlos, asi que no puede tocarlos. Con el reparto actual se lleva los 1 100
 * enteros: un all-in de 100 roba 800 fichas a dos jugadores que pusieron cuatro
 * veces mas.
 *
 * En un campo esto no es una excepcion: los eliminados se all-in por fichas
 * pequenas mientras los que sobreviven acumulan stacks enormes. Medido en el test
 * end-to-end del motor, stacks de 5 630 contra eliminados con 11. Es la situacion
 * normal del producto.
 *
 * ------------------------------------------------------------------
 * POR QUE ES UNA FUNCION PURA Y NO UN METODO DEL MOTOR
 *
 * Porque es aritmetica y se puede probar sin mesa, sin cartas y sin base de datos:
 * `scripts/test-sidepots.js` la ejecuta sobre cientos de combinaciones de
 * aportaciones. Si estuviera dentro de `endGame`, habria que hacer una mano real
 * con stacks concretos y las cartas repartidas, y no se podria cubrir ni el 10% de los casos.
 *
 * La regla es de las que hay que verificar al detalle: un error aqui reparte
 * fichas que no le tocan a un jugador, y no aparece en ningun log.
 */

/** Lo que cada jugador puso en el bote. */
export interface Contribution {
  /** Identificador del jugador. */
  id: string;
  /** Cuanto puso, en unidades internas. */
  amount: number;
}

/** Un bote, y quien puede ganarlo. */
export interface SidePot {
  /** Cuanto hay en este bote. */
  amount: number;
  /** Ids de los jugadores que pueden ganar este bote. */
  eligible: string[];
  /** Apuestas que abren este bote (el siguiente lo abre la siguiente apuesta). */
  from: number;
  /** Apuestas que lo cierran. */
  to: number;
}

/**
 * Divide el bote en botes laterales segun lo que puso cada jugador.
 *
 * El algoritmo es el de siempre: se ordenan las aportaciones distintas, y por cada
 * tranche se crea un bote con los jugadores que posto al menos al menos eso.
 *
 * @param contributions  lo que puso cada jugador (los que(pliegan ponen 0 o no
 *                       aparecen)
 * @returns  botes ordenados de menor a mayor. Siempre suma lo aportado.
 */
export const buildSidePots = (contributions: Contribution[]): SidePot[] => {
  // Solo los que aportan. Un jugador queilege pliega no era eligible para nada,
  // y su apuesta (la ciega) se devuelve antes de esto.
  const aptos = contributions
    .filter(c => Number.isFinite(c.amount) && c.amount > 0)
    .map(c => ({ id: c.id, amount: Math.floor(c.amount) }));

  if (aptos.length === 0) return [];

  // Todas las apuestas, de menor a mayor, una vez cada una.
  const niveles = [...new Set(aptos.map(c => c.amount))].sort((a, b) => a - b);

  const pots: SidePot[] = [];
  let anterior = 0;

  for (const nivel of niveles) {
    // Cuanto se abre este bote: por cada jugador que llega al menos aqui, se mete
    // el tramo entre el nivel anterior y este.
    const participantes = aptos.filter(c => c.amount >= nivel);
    const amount = (nivel - anterior) * participantes.length;

    if (amount > 0) {
      pots.push({
        amount,
        eligible: participantes.map(c => c.id),
        from: anterior,
        to: nivel,
      });
    }

    anterior = nivel;
  }

  return pots;
};

/**
 * Reparte los botes laterales entre los ganadores de la mano.
 *
 * ------------------------------------------------------------------
 * POR QUE EL ORDEN IMPORTA Y NO ES INTERCAMBIABLE
 *
 * Los botes se reparten de MENOR a MAYOR, y en cada bote solo puede ganar quien
 * este entre sus `eligible`. Cuando alguien gana un bote, se le saca de los
 * siguientes: ya no compite por ellos, porque su parte del bote ya esta cobrada.
 *
 * Ese "sacarse de los siguientes" es lo que evita el robo del all-in pequeno. Si un
 * jugador que solo puso 100 gana el bote principal, se le saca de los laterales y
 * no puede tocarlos, ni aunque tenga la mejor mano.
 *
 * Repartir de mayor a menor, o permitir que todos los?toquen todos
 * los botes, daria el mismo dinero.
 *
 * @param pots        botes de `buildSidePots`
 * @param showdown    ids de los jugadores NO eliminados, del mejor a peor. El
 *                    primero es el que tiene la mejor mano.
 * @returns  cuanto cobra cada jugador, en unidades internas
 */
/**
 * Reparte los botes laterales entre los ganadores de la mano.
 *
 * ------------------------------------------------------------------
 * POR QUE `grupos` Y NO UNA LISTA ORDENADA
 *
 * Una lista ordenada ("A mejor que B mejor que C") NO dice quien empata con quien,
 * y en poker eso es justo lo que decide cuanto se lleva cada uno. Si se tratara
 * como si todos los no eliminados estuvieran empatados, en una mano de 3 con bote
 * 1 500 cada uno se llevaria 500, y el bote entero se repartiría entre perdedores.
 *
 * Por eso la entrada son GRUPOS: cada grupo es un conjunto de jugadores empatados,
 * y los grupos van de mejor mano a peor.
 *
 *   [['A'], ['B', 'C']]      A gana, B y C empatan
 *   [['A', 'B'], ['C']]      A y B empatan, C va detras
 *
 * ------------------------------------------------------------------
 * POR QUE NO SE SACA AL GANADOR DE LOS BOTES SIGUIENTES
 *
 * Es tentador, y parece obvio, pero es un error, y grave por dos motivos.
 *
 * El primero es que da el bote al que no le toca. Si C tiene la mejor mano y ha
 * puesto 500, C gana el bote principal; si al ganar se le saca, el lateral (que
 * C tambien puede ganar, porque C puso 500) se lo lleva B, que tiene peor mano.
 *
 * El segundo es que el dinero desaparece. El ultimo bote suele tener menos
 * participantes: si al ultimo bote le queda una sola persona elegible y esa ya
 * cobro antes, el bote se queda sin ganador. Con un all-in de 11 contra dos
 * stacks de 3 000 y 2 500, ese bote final son 500 unidades que se evaporan.
 *
 * ------------------------------------------------------------------
 * LO QUE HACE FALTA, Y ES UNA SOLA COSA: LA ELEGIBILIDAD
 *
 * Que un jugador no pueda tocar los botes por encima de lo que puso ya lo dice
 * `pot.eligible`, que se calcula con lo que aporto cada uno. Si A se all-in por 100
 * y B y C pusieron 500, A no aparece en el lateral de 800, y se acabó: no hay que
 * expulsar a nadie de ningun sitio.
 *
 * Un jugador que gana un bote siguecompitiendo por los siguientes mientras siga
 * siendo elegible, que es justo lo que significa no haberse quedado sin fichas.
 *
 * @param pots    botes de `buildSidePots`
 * @param grupos  jugadores no eliminados agrupados por calidad de mano, del mejor
 *                al peor. Cada grupo son jugadores empatados.
 * @returns  cuanto cobra cada jugador, en unidades internas
 */
export const awardSidePots = (
  pots: SidePot[],
  grupos: string[][],
): Record<string, number> => {
  const premios: Record<string, number> = {};

  // De menor a mayor. `buildSidePots` ya los deja asi, pero se ordena por `to`
  // para no depender del orden del llamante.
  const ordenados = [...pots].sort((a, b) => a.to - b.to);

  for (const pot of ordenados) {
    if (pot.amount <= 0) continue;

    // Se busca el MEJOR grupo que tenga a alguien elegible para este bote. Como
    // los grupos van de mejor mano a peor, el primero con candidatos es el que
    // gana este bote: el resto de la mano no llega aqui.
    let candidatos: string[] = [];
    for (const grupo of grupos) {
      const elegibles = grupo.filter((id) => pot.eligible.includes(id));
      if (elegibles.length > 0) {
        candidatos = elegibles;
        break;
      }
    }

    // Sin elegibles el bote se queda sin repartir. Eso no es perder dinero: es
    // dinero que sigue en el bote y vuelve al campo (que lo recoge deadChips).
    if (candidatos.length === 0) continue;

    // Reparto con resto explicito, para que la suma cuadre al centimo. El resto se
    // reparte por posicion: darlo a los primeros es arbitrario, no cambia el total,
    // y es lo que hace cualquier implementacion.
    const base = Math.floor(pot.amount / candidatos.length);
    const resto = pot.amount % candidatos.length;

    candidatos.forEach((id, i) => {
      premios[id] = (premios[id] ?? 0) + base + (i < resto ? 1 : 0);
    });
  }

  return premios;
};

/**
 * Reparto de mano completa: del bote a lo que cobra cada jugador.
 *
 * Es el resumen de las dos funciones de arriba, y es lo que llama el motor.
 *
 * @param contributions  lo que puso cada jugador
 * @param grupos         no eliminados agrupados por mano, del mejor al peor
 */
export const settlePot = (
  contributions: Contribution[],
  grupos: string[][],
): Record<string, number> => awardSidePots(buildSidePots(contributions), grupos);
