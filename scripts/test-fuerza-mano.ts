/**
 * EVALUADOR DE MANO, CONTRA MANOS QUE NO ADIVINAN.
 *
 * ------------------------------------------------------------------
 * POR QUE UN TEST DE ESTE FICHERO Y NO UNA TARJETA
 *
 * Un evaluador de poker es de los pocos sitios donde "casi bien" es peor que no estar: si
 * clasifica mal una escalera por una color, le dice al jugador que va ganando cuando va
 * perdiendo, y esa es la funcion del componente. Un error ahi no se ve como una etiqueta
 * rara: se ve como el juego mintiendole.
 *
 * Asi que se prueban las manos que tienen nombre propio y categoria conocida, mas los casos
 * limite que son donde fallan estos evaluadores: el as que vale 1 y 14, el_color_con menos de
 * cinco cartas, y las 21 combinaciones de una mano de 7 cartas.
 *
 * Se ejecuta sobre el codigo REAL de la web (el que se compila al bundle), no sobre una copia.
 */
import { evaluarMano } from '../mini-app/src/lib/handStrength';

let ok = 0;
let mal = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) { ok++; console.log(`\x1b[32m  ok \x1b[0m ${nombre}`); }
  else { mal++; console.log(`\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

// atajo: "As de picas, K de corazones" -> {rank, suit}
const C = (rank, suit) => ({ rank, suit });
const mano = (...t) => t.map(([r, s]) => C(r, s));
const rangoDe = (m) => (m ? m.rank : 'null');

console.log('\n=== Las nueve categorias, con la mano que las define ===');

// Escalera real de as (la mas fuerte)
comprobar(
  'A K Q J T del mismo palo = escoba real',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 's'], ['Q', 's'], ['J', 's'], ['T', 's']))) === 'royal-flush',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 's'], ['Q', 's'], ['J', 's'], ['T', 's']))),
);

// Escalera real, con una sexta carta que estorba (el caso de 7 cartas)
comprobar(
  'la 7 carta no tira la escalera real',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 's'], ['Q', 's'], ['J', 's'], ['T', 's'], ['9', 'h'], ['2', 'c']))) === 'royal-flush',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 's'], ['Q', 's'], ['J', 's'], ['T', 's'], ['9', 'h'], ['2', 'c']))),
);

comprobar(
  '9 8 7 6 5 del mismo palo = escalera real',
  rangoDe(evaluarMano(mano(['9', 's'], ['8', 's'], ['7', 's'], ['6', 's'], ['5', 's']))) === 'straight-flush',
);

comprobar(
  '7 7 7 7 2 = cuatro iguales',
  rangoDe(evaluarMano(mano(['7', 's'], ['7', 'h'], ['7', 'd'], ['7', 'c'], ['2', 's']))) === 'quads',
);

comprobar(
  'K K K 4 4 = full house',
  rangoDe(evaluarMano(mano(['K', 's'], ['K', 'h'], ['K', 'd'], ['4', 's'], ['4', 'h']))) === 'full-house',
);

// Full house con 7 cartas donde hay dos tríos: debe ganar el TRÍO MÁS ALTO, no el primero
comprobar(
  'con dos trios, gana el mas alto (K K K 3 3 3 9 = full de reyes)',
  rangoDe(evaluarMano(mano(['K', 's'], ['K', 'h'], ['K', 'd'], ['3', 's'], ['3', 'h'], ['3', 'c'], ['9', 's']))) === 'full-house',
);

comprobar(
  'A Q J 9 5 del mismo palo = color',
  rangoDe(evaluarMano(mano(['A', 's'], ['Q', 's'], ['J', 's'], ['9', 's'], ['5', 's']))) === 'flush',
);

// SEIS cartas del mismo palo: el color usa las CINCO mas altas, no las cinco primeras.
// Este caso se puede dar en una mano de 7 cartas y es donde un evaluador ingenuo se equivoca
// por el orden en que llegaron las cartas.
comprobar(
  'con 6 del mismo palo, el color se lleva las 5 mas altas',
  (() => {
    // 2 5 9 J K A de picas, y un 3 de corazones: el color es A K J 9 5.
    const r = evaluarMano(mano(['2', 's'], ['5', 's'], ['9', 's'], ['J', 's'], ['K', 's'], ['A', 's'], ['3', 'h']));
    return r && r.rank === 'flush' && r.cards === 'A K J 9 5';
  })(),
);

// Escalera normal, con el as VALIDO como 14
comprobar(
  'A 2 3 4 5 = escalera (el as mas bajo)',
  rangoDe(evaluarMano(mano(['A', 's'], ['2', 'h'], ['3', 'd'], ['4', 'c'], ['5', 's']))) === 'straight',
);

// Escalera normal del 10 al As (la mejor del poker alto)
comprobar(
  'T J Q K A = escalera maxima',
  rangoDe(evaluarMano(mano(['T', 's'], ['J', 'h'], ['Q', 'd'], ['K', 'c'], ['A', 's']))) === 'straight',
);

comprobar(
  '9 9 9 K 4 = tres iguales',
  rangoDe(evaluarMano(mano(['9', 's'], ['9', 'h'], ['9', 'd'], ['K', 's'], ['4', 'h']))) === 'trips',
);

comprobar(
  'J J 8 8 4 = dos parejas',
  rangoDe(evaluarMano(mano(['J', 's'], ['J', 'h'], ['8', 'd'], ['8', 'c'], ['4', 'h']))) === 'two-pair',
);

comprobar(
  '10 10 8 5 3 = pareja',
  rangoDe(evaluarMano(mano(['T', 's'], ['T', 'h'], ['8', 'd'], ['5', 'c'], ['3', 'h']))) === 'pair',
);

comprobar(
  'A K 9 6 3 sin color ni escalera = carta alta',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 'h'], ['9', 'd'], ['6', 'c'], ['3', 'h']))) === 'high-card',
);

console.log('\n=== Los casos donde estos evaluadores fallan ===');

// Menos de 5 cartas: no hay mano, y NO debe inventarse una
comprobar('con 2 cartas no hay mano', evaluarMano(mano(['A', 's'], ['K', 'h'])) === null);
comprobar('con 4 cartas no hay mano', evaluarMano(mano(['A', 's'], ['K', 'h'], ['Q', 'd'], ['J', 'c'])) === null);
comprobar('con 0 cartas no hay mano', evaluarMano([]) === null);

// Un color de 4 cartas NO es color: es la categoria que toque
comprobar(
  '4 del mismo palo NO es color',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 's'], ['Q', 's'], ['9', 's'], ['5', 'h']))) !== 'flush',
  'cinco cartas pero solo cuatro del mismo palo',
);

// Dos triplets donde el mas alto es un as
comprobar(
  'A A A K K K 2 = full de ases (no de reyes)',
  (() => {
    const r = evaluarMano(mano(['A', 's'], ['A', 'h'], ['A', 'd'], ['K', 's'], ['K', 'h'], ['K', 'c'], ['2', 's']));
    return r && r.cards.startsWith('A');
  })(),
);

// La escalera que "roda" por el as: A K Q J 2 NO es escalera (falta la T)
comprobar(
  'A K Q J 2 NO es escalera',
  rangoDe(evaluarMano(mano(['A', 's'], ['K', 'h'], ['Q', 'd'], ['J', 'c'], ['2', 's']))) !== 'straight',
);

console.log('\n=== 7 cartas: se usa la mejor de las 21 combinaciones ===');

// Con 7 cartas donde la mejor combinacion es un full house, no un color
comprobar(
  '7 cartas: gana el full house sobre el color',
  rangoDe(evaluarMano(mano(
    ['K', 's'], ['K', 'h'], ['K', 'd'], ['2', 's'], ['2', 'h'], ['5', 'c'], ['9', 's'],
  ))) === 'full-house',
);

// 7 cartas donde hay escalera y color: la escalera de color gana
comprobar(
  '7 cartas: gana la escalera de color sobre el color y la escalera',
  rangoDe(evaluarMano(mano(
    ['5', 's'], ['6', 's'], ['7', 's'], ['8', 's'], ['9', 's'], ['K', 'h'], ['2', 'c'],
  ))) === 'straight-flush',
);

// La fuerza debe crecer con la mano: misma mano, mas cartas, mejor o igual
const fuerzaBaja = evaluarMano(mano(['A', 's'], ['K', 'h'], ['9', 'd'], ['6', 'c'], ['3', 'h']));
const fuerzaAlta = evaluarMano(mano(['A', 's'], ['A', 'h'], ['K', 'd'], ['Q', 'c'], ['J', 'h']));
comprobar(
  'dos parejas valen mas que carta alta',
  fuerzaAlta.score > fuerzaBaja.score,
  `${fuerzaAlta.score} vs ${fuerzaBaja.score}`,
);

comprobar(
  'la fuerza esta entre 0 y 1',
  fuerzaAlta.score <= 1 && fuerzaBaja.score >= 0,
);

console.log(`\n${'='.repeat(50)}`);
console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
console.log('='.repeat(50));
process.exit(mal > 0 ? 1 : 0);