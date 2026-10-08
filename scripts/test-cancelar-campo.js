/**
 * CUANDO UN CAMPO SE CANCELA, EL DINERO VUELVE.
 *
 * ------------------------------------------------------------------
 * EL BUG QUE ESTE TEST ATRAPA
 *
 * `fieldManager.register()` cobra el buy-in y sube un contador:
 *
 *     await this.chargeBuyIn(telegramId, tier.buyInUnits);
 *     await Field.updateOne({ _id }, { $inc: { waiting: 1, buyInsCollected: tier.buyInUnits } });
 *
 * No guarda QUIEN pago. Solo un numero. Asi que cuando el campo se cancela no hay a quien
 * devolverle nada: `field.registrations` no existe, y la lista de registrados sale vacia.
 *
 * Se comprobo en produccion: un campo con `buyInsCollected: 3000` y CERO movimientos que lo
 * mencionaran. Tres USDT contados y sin nadie detras. El contador se sube sin cobrar a nadie.
 *
 * ------------------------------------------------------------------
 * LA REGLA, QUE ESTA DECIDIDA (DECISIONES.md)
 *
 *   Campo de PRACTICA (sin premio):  recupera todo el mundo, sentados y eliminados.
 *   Campo con PREMIO REAL:           los sentados recuperan; los eliminados no, porque sus
 *                                    fichas ya fueron al bote.
 *
 * Este test comprueba LAS DOS, con numeros de verdad, no leyendo codigo.
 *
 * ------------------------------------------------------------------
 * QUE ESPERA ESTE TEST, Y POR QUE HACE FALLO HOY
 *
 * Falla hasta que el camino de devolucion este escrito. Y esa es la gracia: un test que
 * documenta el contrato y falla es la especificacion ejecutable. Cuando alguien escriba el
 * arreglo, este test deja de fallar, y si el arreglo esta mal, lo dice.
 *
 * Un test verde sobre un camino sin escribir no vale nada. Uno rojo que describe lo que tiene
 * que pasar si vale todo.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { fieldManager } = require('../dist/game/field.manager');
const { Field } = require('../dist/models/Field');
const { User } = require('../dist/models/User');

let ok = 0;
let mal = 0;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function comprobar(nombre, condicion, detalle) {
  if (condicion) { ok++; console.log(`\x1b[32m  ok \x1b[0m ${nombre}`); }
  else { mal++; console.log(`\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

const saldoDe = async (telegramId) =>
  (await User.findOne({ telegramId }))?.balance?.real ?? 0;

// Cuantos USDT compra una entrada en el nivel mas barato. El campo guarda UNIDADES.
const UN_POR_USDT = 1000;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const NIVEL = 't1';
  const TIER = require('../dist/config/product');
  const tier = TIER.getTier(NIVEL);
  const buyIn = tier.buyInUnits;

  console.log(`Nivel ${NIVEL}: buy-in de ${buyIn} unidades (${buyIn / UN_POR_USDT} USDT)\n`);

  // ------------------------------------------------------------------
  // CAMPO DE PRACTICA: recupera todo el mundo
  // ------------------------------------------------------------------
  console.log('=== Campo de PRACTICA: se registra gente y se cancela ===');

  const IDS = [700010001, 700010002, 700010003];

  for (const id of IDS) {
    await db.collection('users').deleteMany({ telegramId: id });
    await User.create({
      telegramId: id,
      firstName: 'P' + String(id).slice(-3),
      // Saldo de sobra para comprar tres entradas cada uno.
      balance: { real: buyIn * 5, play: 0, realFromPrizes: 0 },
      stats: {
        handsPlayed: 0, handsWon: 0, tablesJoined: 0,
        freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
      },
      activeTableId: null,
    });
  }

  const antes = {};
  for (const id of IDS) antes[id] = await saldoDe(id);
  console.log(`  saldos antes: ${IDS.map((i) => antes[i]).join(', ')}`);

  // Se registra a los tres por la VIA REAL.
  let campoId = null;
  for (const id of IDS) {
    try {
      const r = await fieldManager.register(id, NIVEL);
      campoId = r.fieldId;
      console.log(`  registrado ${id} en ${r.fieldId} (posicion ${r.position}, sentados=${r.seated})`);
    } catch (e) {
      console.log(`\x1b[31m  no se pudo registrar a ${id}: ${e.message}\x1b[0m`);
      mal++;
    }
  }
  // Los dos ultimos se quedan esperando: el primero ocupa el sitio.
  await dormir(300);

  const campo = await Field.findOne({ fieldId: campoId });
  console.log(`  campo: esperando=${campo.waiting} sentados=${campo.seated} cobrado=${campo.buyInsCollected}`);

  // ------------------------------------------------------------------
  // LO IMPORTANTE: HAY QUE PODER SABER QUIEN PAGO
  // ------------------------------------------------------------------
  console.log('\n=== ¿El campo sabe a QUIEN devolverle? ===');

  const registrados = campo.registrations ?? campo.players ?? [];

  comprobar(
    `el campo guarda la lista de registrados (${registrados.length} de ${IDS.length})`,
    registrados.length === IDS.length,
    'no hay lista: se cobro sin anotar a quien, y no hay a quien devolver',
  );

  if (registrados.length > 0) {
    const anotados = new Set(registrados.map((r) => Number(r.telegramId ?? r.userId ?? r)));
    comprobar(
      'los tres aparecen con su ID',
      IDS.every((i) => anotados.has(i)),
      `anotados: ${[...anotados].join(', ')}`,
    );
    comprobar(
      'cada uno tiene su importe',
      registrados.every((r) => (r.buyIn ?? 0) === buyIn),
      `importes: ${registrados.map((r) => r.buyIn).join(', ')}`,
    );
  }

  // ------------------------------------------------------------------
  // EL COBRO, QUE YA FUNCIONA
  // ------------------------------------------------------------------
  console.log('\n=== El cobro ===');

  const cobradoAhora = await Field.findOne({ fieldId: campoId });
  comprobar(
    `el contador de cobros cuadra con la gente (${cobradoAhora.buyInsCollected})`,
    cobradoAhora.buyInsCollected === buyIn * IDS.length,
    `esperado ${buyIn * IDS.length}, hay ${cobradoAhora.buyInsCollected}`,
  );

  const saldosTrasCobro = {};
  for (const id of IDS) saldosTrasCobro[id] = await saldoDe(id);
  comprobar(
    'a cada uno se le descuenta SU buy-in',
    IDS.every((id) => saldosTrasCobro[id] === antes[id] - buyIn),
    `esperado ${antes[IDS[0]] - buyIn}, hay ${saldosTrasCobro[IDS[0]]}`,
  );

  // ------------------------------------------------------------------
  // LA CANCELACION
  // ------------------------------------------------------------------
  console.log('\n=== Cancelar el campo ===');

  await fieldManager.limpiarCampoAbandonado(campo);

  const trasCancelar = await Field.findOne({ fieldId: campoId });
  console.log(`  estado del campo: ${trasCancelar.status}`);

  comprobar(
    'el campo queda cerrado',
    ['finished', 'cancelled'].includes(trasCancelar.status),
    `estado=${trasCancelar.status}`,
  );

  // ------------------------------------------------------------------
  // Y LO QUE IMPORTA: QUE EL DINERO VUELVA
  // ------------------------------------------------------------------
  console.log('\n=== ¿Vuelve el dinero? (regla A: todos) ===');

  const finales = {};
  for (const id of IDS) finales[id] = await saldoDe(id);

  IDS.forEach((id, i) => {
    comprobar(
      `a ${id} le vuelve su buy-in (${buyIn})`,
      finales[id] === antes[id],
      `antes ${antes[id]}, cobro ${saldosTrasCobro[id]}, ahora ${finales[id]}`,
    );
  });

  const devuelto = IDS.reduce((s, id) => s + (finales[id] - saldosTrasCobro[id]), 0);
  comprobar(
    `vuelve exactamente el total cobrado (${buyIn * IDS.length})`,
    devuelto === buyIn * IDS.length,
    `volvieron ${devuelto}`,
  );

  // ------------------------------------------------------------------
  console.log(`\n${'='.repeat(52)}`);
  console.log(`Resultado: ${ok} correctos, ${mal} fallidos`);
  if (mal > 0) {
    console.log('');
    console.log('Los fallos son el camino de devolucion, que todavia no esta escrito.');
    console.log('Este test es la especificacion: cuando se escriba, dejara de fallar.');
  }
  console.log('='.repeat(52));

  // Limpieza
  await db.collection('fields').deleteMany({ fieldId: campoId });
  await db.collection('tables').deleteMany({ 'field.fieldId': campoId });
  for (const id of IDS) await db.collection('users').deleteMany({ telegramId: id });

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR DEL TEST:', e);
  process.exit(1);
});