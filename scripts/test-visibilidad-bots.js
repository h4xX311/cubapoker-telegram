/**
 * Prueba de visibilidad publica.
 *
 * Comprueba dos cosas que no se pueden "revisar a ojo" en una captura:
 *
 *   1. `toPublicTable` no envia `humans`, `bots`, `seat.kind` ni `botStyle`.
 *      Ocultarlo solo en React no sirve: cualquiera abre DevTools y lo ve.
 *   2. Los nombres de los bots son plausibles y no se repiten dentro de una
 *      misma mesa. Nada de "Marta2" ni de "bot-17".
 *
 * No necesita MongoDB: son funciones puras.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { toPublicTable } = require('../dist/models/Table');
const { botFactory } = require('../dist/game/bot.engine');
const { unitsToUsdt, formatUnits } = require('../dist/config/units');

let ok = 0;
let fail = 0;

function test(nombre, fn) {
  try {
    fn();
    ok++;
    console.log(`  OK   ${nombre}`);
  } catch (error) {
    fail++;
    console.log(`  FALLO ${nombre}`);
    console.log(`        ${error.message}`);
  }
}

console.log('VISIBILIDAD PUBLICA Y NOMBRES DE BOTS');

// ---------------------------------------------------------------------------
// 1. La vista de mesa no delata a los bots
// ---------------------------------------------------------------------------
const asientoBot = {
  index: 0,
  kind: 'bot',
  displayName: 'Marta79',
  chips: 980,
  bet: 10,
  status: 'active',
  isDealer: false,
  isSmallBlind: true,
  isBigBlind: false,
  lastAction: 'call',
  botProfile: { style: 'tight', winRate: 0.5, raiseFreq: 0.2, foldFreq: 0.3, aggression: 0.1 },
};

const asientoHumano = {
  index: 1,
  kind: 'human',
  displayName: 'Carlos',
  chips: 1000,
  bet: 0,
  status: 'active',
  isDealer: true,
  isSmallBlind: false,
  isBigBlind: true,
  lastAction: undefined,
};

const mesaFalsa = {
  tableId: 'mesa-prueba',
  kind: 'cash',
  tierId: 't1',
  prizeTier: undefined,
  status: 'running',
  smallBlind: 5,
  bigBlind: 10,
  buyInUnits: 1000,
  maxSeats: 7,
  seats: [asientoBot, asientoHumano],
  field: undefined,
  hand: {
    handNumber: 12,
    phase: 'preflop',
    communityCards: [],
    pot: 30,
    currentBet: 10,
  },
  stats: { rakeCollected: 0 },
};

const vista = toPublicTable(mesaFalsa, 1);

test('la mesa no envia humanos/bots', () => {
  assert.strictEqual('humans' in vista, false, 'sigue enviando humans');
  assert.strictEqual('bots' in vista, false, 'sigue enviando bots');
});

test('los asientos no envían kind, botStyle ni botProfile', () => {
  for (const asiento of vista.seats) {
    assert.strictEqual('kind' in asiento, false, 'el asiento envia kind');
    assert.strictEqual('botStyle' in asiento, false, 'el asiento envia botStyle');
    assert.strictEqual('botProfile' in asiento, false, 'el asiento envia botProfile');
  }
});

test('la vista conserva lo que la interfaz necesita', () => {
  assert.strictEqual(vista.occupied, 2);
  assert.strictEqual(vista.seats[0].displayName, 'Marta79');
  assert.strictEqual(vista.seats[1].isYou, true);
  assert.strictEqual(vista.hand.pot, 30);
});

test('la serializacion completa no contiene las claves prohibidas', () => {
  const json = JSON.stringify(vista);
  for (const prohibida of ['"humans"', '"bots"', '"botStyle"', '"botProfile"', '"kind":"bot"']) {
    assert.strictEqual(json.includes(prohibida), false, `aparece ${prohibida}`);
  }
});

// ---------------------------------------------------------------------------
// 2. La lista publica de mesas tampoco desglosa por tipo
// ---------------------------------------------------------------------------
test('listTables no vuelve a introducir humans/bots', () => {
  const fuente = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'game', 'table.manager.ts'),
    'utf8',
  );
  const inicio = fuente.indexOf('async listTables');
  assert(inicio >= 0, 'no se encontro listTables');
  const siguienteMetodo = fuente.indexOf('\n  /**', inicio + 10);
  const bloque = fuente.slice(inicio, siguienteMetodo > inicio ? siguienteMetodo : undefined);

  assert(!/humans\s*:/.test(bloque), 'listTables envia humans');
  assert(!/bots\s*:/.test(bloque), 'listTables envia bots');
  assert(!/botStyle/.test(bloque), 'listTables envia botStyle');
});

// ---------------------------------------------------------------------------
// 3. Nombres de bots: realistas y unicos dentro de la mesa
// ---------------------------------------------------------------------------
test('genera 120 nombres unicos para una mesa, sin contadores ni "bot"', () => {
  const usados = new Set();
  botFactory.reset();

  for (let i = 0; i < 120; i++) {
    const perfil = botFactory.create(i, usados);
    assert(!usados.has(perfil.name), `nombre repetido en la mesa: ${perfil.name}`);
    assert(!/bot/i.test(perfil.name), `el nombre delata: ${perfil.name}`);
    assert(!/[A-Za-z]\d$/.test(perfil.name), `sufijo de contador: ${perfil.name}`);
    assert(/^[A-Za-z0-9]+$/.test(perfil.name), `nombre no plausible: ${perfil.name}`);
    usados.add(perfil.name);
  }
});

test('el mismo nombre puede aparecer en otra mesa, no en la misma', () => {
  const mesaA = new Set(['Marta', 'ElPro']);
  const perfilA = botFactory.create(7, mesaA);
  assert(!mesaA.has(perfilA.name), 'repitio un nombre ya sentado');

  // La misma semilla y el mismo conjunto de nombres ya sentados dan el mismo
  // perfil: util para pruebas. Otra mesa puede reutilizar el nombre.
  const perfilB = botFactory.create(7, mesaA);
  assert.strictEqual(perfilA.name, perfilB.name);
});

// ---------------------------------------------------------------------------
// 4. Unidades: 1000 unidades = 1 USDT, sin decimales fantasma
// ---------------------------------------------------------------------------
test('conversion de unidades a USDT', () => {
  assert.strictEqual(unitsToUsdt(1000), 1);
  assert.strictEqual(unitsToUsdt(500), 0.5);
  assert.strictEqual(unitsToUsdt(1), 0.001);
  assert.strictEqual(formatUnits(1000), '1');
  assert.strictEqual(formatUnits(500), '0,5');
  assert.strictEqual(formatUnits(50), '0,05');
});

console.log(`\nRESULTADO: ${ok} OK, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
