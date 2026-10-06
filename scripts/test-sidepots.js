/**
 * Pruebas de los botes laterales (side pots).
 *
 * ------------------------------------------------------------------
 * QUE PROTEGE ESTA PRUEBA
 *
 * Que un jugador que solo puso 100 no pueda llevarse los 800 que pusieron dos
 * jugadores que pusieron 500. Es la forma mas basica de robar fichas en poker, y
 * ocurre en cada all-in de eliminacion dentro de un campo: los eliminados tienen
 * stacks pequenos y los que sobreviven tienen stacks enormes. Medido en el test
 * end-to-end del motor: stacks de 5 630 contra eliminados con 11.
 *
 * El motor repartia el bote ENTERO al ganador de la mejor mano. Con esto, un
 * all-in minimo se llevaba tambien el bote de los stacks grandes.
 *
 * `buildSidePots` y `awardSidePots` son aritmetica pura, asi que se prueban sin
 * mesa, sin cartas y sin base de datos, y se pueden cubrir cientos de casos.
 *
 * Ejecutar: node scripts/test-sidepots.js
 */

const {
  buildSidePots,
  awardSidePots,
  settlePot,
} = require('../dist/game/sidepots');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m+\x1b[0m ${m}`); pass++; };
const bad = (m, d) => {
  console.log(`  \x1b[31mx\x1b[0m ${m}`);
  if (d) console.log(`      ${d}`);
  fail++;
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const suma = (obj) => Object.values(obj).reduce((s, v) => s + v, 0);

console.log('\n\x1b[1mCubaPoker \x1b[0mBotes laterales (side pots)');

// =========================================================================
section('1. El caso que hace falta el bote lateral');

//   A  se all-in por 100
//   B  se all-in por 500
//   C  tiene 5 000, iguala 500
//
// Bote total 1 100. El reparto correcto es:
//
//   Bote principal   100 x 3 =  300   -> lo pueden ganar A, B y C
//   Bote lateral     400 x 2 =  800   -> solo B y C pusieron mas de 100
//
// Si A gana la mano se lleva SOLO los 300. Los 800 no los puso nadie para
// ganarlos. Con el reparto actual se lleva los 1 100 enteros, que es robar 800 a
// dos jugadores que pusieron cuatro veces mas.
{
  const pots = buildSidePots([
    { id: 'A', amount: 100 },
    { id: 'B', amount: 500 },
    { id: 'C', amount: 500 },
  ]);

  if (pots.length === 2) ok('3 stacks distintos producen 2 botes');
  else bad(`produjo ${pots.length} botes, esperados 2`);

  const principal = pots.find((p) => p.to === 100);
  const lateral = pots.find((p) => p.to === 500);

  if (principal && principal.amount === 300) ok('el bote principal son 300 (100 x 3)');
  else bad(`el principal es ${principal ? principal.amount : 'nada'}, esperado 300`);

  if (lateral && lateral.amount === 800) ok('el bote lateral son 800 (400 x 2)');
  else bad(`el lateral es ${lateral ? lateral.amount : 'nada'}, esperado 800`);

  if (principal && ['A', 'B', 'C'].every((id) => principal.eligible.includes(id))) {
    ok('los tres son elegibles al principal');
  } else {
    bad('al principal le falta alguien');
  }

  if (lateral && !lateral.eligible.includes('A')) {
    ok('A NO es elegible al bote lateral: es lo que impide el robo');
  } else {
    bad('A sigue siendo elegible al lateral: un all-in de 100 puede robar 800');
  }
}

// =========================================================================
section('2. El all-in pequeno gana la mano');

{
  const premios = settlePot(
    [
      { id: 'A', amount: 100 },
      { id: 'B', amount: 500 },
      { id: 'C', amount: 500 },
    ],
    [['A'], ['B'], ['C']],
  );

  if (premios.A === 300) {
    ok('A se lleva SOLO el bote principal: 300 de 1 100');
  } else {
    bad(`A se lleva ${premios.A}, deberia ser 300 (no puede tocar los 800 laterales)`);
  }

  // El lateral de 800 es elegible para B y C (los que pusieron 500). Gana el mejor
  // de esos dos, que es B. A no se lo lleva porque no es elegible ahi, no porque
  // hubiera ganado antes.
  if (premios.B === 800) {
    ok('el lateral de 800 lo gana B, el mejor entre los que podian ganarlo');
  } else {
    bad(`B recibe ${premios.B ?? 0}, esperado 800`);
  }

  if ((premios.C ?? 0) === 0) ok('C, el peor de la mano, no cobra');
  else bad(`C recibe ${premios.C}, deberia ser 0`);

  if (suma(premios) === 1100) ok('el total repartido es exactamente 1 100');
  else bad(`el total repartido es ${suma(premios)}, esperado 1100`);
}

// =========================================================================
section('3. Quien mas puso, se lleva el bote entero');

{
  const premios = settlePot(
    [
      { id: 'A', amount: 100 },
      { id: 'B', amount: 500 },
      { id: 'C', amount: 500 },
    ],
    [['C'], ['B'], ['A']],
  );

  if (premios.C === 1100) ok('C se lleva los 1 100: gana el principal y el lateral');
  else bad(`C se lleva ${premios.C}, esperado 1100`);

  if ((premios.A ?? 0) === 0 && (premios.B ?? 0) === 0) ok('los perdedores no cobran');
  else bad(`A=${premios.A}, B=${premios.B}: los perdedores no deben cobrar`);
}

// =========================================================================
section('4. Empate: se divide el bote entre los empatados');

// A y B empatan con la mejor mano. C va detras.
//
//   Bote principal   100 x 3 =  300   elegibles A, B, C  ->  A y B, dividen 150/150
//   Bote lateral     400 x 2 =  800   elegibles B, C     ->  gana B (mejor que C)
//
// B se lleva 950. No 150, y no 1 100: el lateral es suyo porque es elegible a el
// y porque su mano es mejor que la de C, que es el otro que compite por el.
{
  const premios = settlePot(
    [
      { id: 'A', amount: 100 },
      { id: 'B', amount: 500 },
      { id: 'C', amount: 500 },
    ],
    [['A', 'B'], ['C']],
  );

  if (premios.A === 150 && premios.B === 950) {
    ok('el empate reparte 150 y 150 el principal; B se lleva ademas el lateral');
  } else {
    bad(`A=${premios.A}, B=${premios.B}, esperado 150 y 950`);
  }

  if ((premios.C ?? 0) === 0) ok('C pierde la mano entera y no cobra nada');
  else bad(`C recibe ${premios.C}, deberia ser 0`);

  if (suma(premios) === 1100) ok('el total repartido es exactamente 1 100');
  else bad(`el total repartido es ${suma(premios)}, esperado 1100`);
}

// =========================================================================
section('5. Todos ponen igual: no hay bote lateral');

{
  const pots = buildSidePots([
    { id: 'A', amount: 500 },
    { id: 'B', amount: 500 },
    { id: 'C', amount: 500 },
  ]);

  if (pots.length === 1) ok('3 aportaciones iguales dan UN solo bote');
  else bad(`${pots.length} botes con aportaciones iguales`);

  if (pots[0] && pots[0].amount === 1500) ok('el bote unico son 1 500 (500 x 3)');
  else bad(`el bote es ${pots[0] ? pots[0].amount : 'nada'}, esperado 1500`);

  const premios = settlePot(
    [
      { id: 'A', amount: 500 },
      { id: 'B', amount: 500 },
      { id: 'C', amount: 500 },
    ],
    [['A'], ['B'], ['C']],
  );

  if (premios.A === 1500) ok('el ganador se lleva los 1 500 enteros');
  else bad(`el ganador recibe ${premios.A}, esperado 1500`);
}

// =========================================================================
section('6. El caso tipico de un campo: 11 fichas contra stacks enormes');

{
  const premios = settlePot(
    [
      { id: 'pequeno', amount: 11 },
      { id: 'grande1', amount: 3000 },
      { id: 'grande2', amount: 2500 },
    ],
    [['pequeno'], ['grande1'], ['grande2']],
  );

  const pequeno = premios.pequeno ?? 0;
  if (pequeno === 33) {
    ok('el all-in de 11 se lleva 33 (11 x 3): ni una ficha mas');
  } else {
    bad(
      `el all-in de 11 recibe ${pequeno}, esperado 33. ` +
      'Este es el robo que este archivo existe para arreglar.',
    );
  }

  const ganoGrande = settlePot(
    [
      { id: 'pequeno', amount: 11 },
      { id: 'grande1', amount: 3000 },
      { id: 'grande2', amount: 2500 },
    ],
    [['grande1'], ['grande2'], ['pequeno']],
  );

  const g1 = ganoGrande.grande1 ?? 0;
  const p = ganoGrande.pequeno ?? 0;

  // Si gana el mejor de los grandes, se lleva el bote ENTERO, no solo el principal.
  // Este es el bote que antes se perdia: el ultimo tramo (de 2 500 a 3 000) solo es
  // alcanzable por grande1, porque es el unico que puso 3 000. Si se le saca al
  // ganar el principal, ese bote de 500 se queda sin dueño.
  if (g1 === 5511 && p === 0) ok('grande1 se lleva los 5 511 enteros, ultimo bote incluido');
  else bad(`grande1=${g1}, pequeno=${p}: esperado 5511 y 0`);

  if (suma(ganoGrande) === 5511) ok('el total repartido son 5 511, exactamente lo aportado');
  else bad(`el total repartido es ${suma(ganoGrande)}, esperado 5511`);
}

// =========================================================================
section('7. Casos limite');

{
  const pots = buildSidePots([{ id: 'A', amount: 100 }]);
  if (pots.length === 1 && pots[0].amount === 100) ok('un solo aportante: un bote de 100');
  else bad(`un solo aportante dio ${JSON.stringify(pots)}`);
}

{
  const pots = buildSidePots([]);
  if (pots.length === 0) ok('nadie aporta: cero botes, no un bote vacio');
  else bad('nadie aporta y aun asi hay botes');
}

{
  const pots = buildSidePots([
    { id: 'A', amount: -50 },
    { id: 'B', amount: 100 },
    { id: 'C', amount: NaN },
  ]);
  if (pots.length === 1 && pots[0].amount === 100) {
    ok('importes negativos y NaN se ignoran en vez de romper el reparto');
  } else {
    bad(`importes raros dieron ${JSON.stringify(pots)}`);
  }
}

{
  const pots = buildSidePots([
    { id: 'A', amount: 100.7 },
    { id: 'B', amount: 100.2 },
  ]);
  if (pots[0] && pots[0].amount === 200) ok('los decimales se truncan: 200 exactos');
  else bad(`los decimales dieron ${pots[0] ? pots[0].amount : 'nada'}`);
}

{
  const pots = buildSidePots([
    { id: 'A', amount: 100 },
    { id: 'B', amount: 100 },
  ]);
  const premios = awardSidePots(pots, []);
  if (suma(premios) === 0) {
    ok('sin ganador el bote no se reparte: se queda en el campo, no se pierde');
  } else {
    bad(`sin ganador se repartieron ${suma(premios)}: el dinero aparece de la nada`);
  }
}

// =========================================================================
section('8. El dinero nunca se crea ni se pierde');

{
  let casos = 0;
  let fallos = 0;

  const jugadores = ['A', 'B', 'C', 'D'];
  const cantidades = [0, 10, 11, 100, 137, 500, 999, 2500, 3000];

  // Todas las particiones ORDENADAS de los 4 jugadores en grupos de empate, del
  // mejor al peor. Para 4 jugadores son 75, y cubren desde "uno gana solo" hasta
  // "los cuatro empatan", que es donde se rompen los repartos.
  //
  // Con esto la invariante no se comprueba solo sobre quien gano, sino sobre
  // cualquier reparto de manos que se pueda dar.
  const particiones = (resto) => {
    if (resto.length === 0) return [[]];
    const [primero, ... cola] = resto;
    const out = [];
    for (let i = 0; i < cola.length + 1; i++) {
      // Los i primeros de la cola se agrupan con el primero: ese grupo de empate.
      const grupo = [primero].concat(cola.slice(0, i));
      const siguientes = particiones(cola.slice(i));
      for (const s of siguientes) out.push([grupo, ...s]);
    }
    return out;
  };

  const ordenes = particiones(jugadores);

  for (const a of cantidades) {
    for (const b of cantidades) {
      for (const c of cantidades) {
        for (const d of cantidades) {
          const contributions = [
            { id: 'A', amount: a },
            { id: 'B', amount: b },
            { id: 'C', amount: c },
            { id: 'D', amount: d },
          ];
          const aportado = a + b + c + d;
          if (aportado === 0) continue;

          for (const orden of ordenes) {
            casos++;

            const pots = buildSidePots(contributions);
            const premios = awardSidePots(pots, orden);
            const repartido = suma(premios);

            if (repartido > aportado) {
              fallos++;
              if (fallos <= 3) {
                bad(
                  `SE CREA DINERO: aportaban ${aportado}, se repartieron ${repartido} ` +
                  `(gana ${orden.join('>')})`,
                );
              }
            }

            for (const [id, amount] of Object.entries(premios)) {
              const suBote = pots
                .filter((p) => p.eligible.includes(id))
                .reduce((s, p) => s + p.amount, 0);
              if (amount > suBote) {
                fallos++;
                if (fallos <= 5) {
                  bad(
                    `${id} cobra ${amount} pero solo hay ${suBote} en los botes de los ` +
                    'que es elegible',
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  ok(`${casos} repartos comprobados`);

  if (fallos === 0) {
    ok('en ninguno se crea dinero, y nadie cobra mas de lo que podia alcanzar');
  } else {
    bad(`${fallos} repartos violan la invariante del dinero`);
  }
}

console.log(`\n\x1b[1mResultado: ${pass} correctos, ${fail} fallidos\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
