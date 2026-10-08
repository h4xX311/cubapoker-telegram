/**
 * CREA LOS INDICES QUE EL CODIGO DA POR HECHOS.
 *
 * ------------------------------------------------------------------
 * POR QUE HACE FALTA ESTE SCRIPT
 *
 * Mongo no crea un indice unico por el simple hecho de que este en el esquema de mongoose.
 * Si el indice no existe en la base, la proteccion no existe, y el codigo parece correcto
 * mientras deja pasar exactamente lo que deberia impedir.
 *
 * Aqui es donde se fallo antes: el campo se abria sin nadie, y el numero de campos a la vez
 * no lo controlaba ningun sitio. El `.index()` del esquema es una DECLARACION; el indice de
 * verdad lo tiene que crear alguien.
 *
 * Mongoose lo hace al arrancar (`autoIndex`), pero solo en desarrollo, y si hay duplicados
 * que lo bloquean lo hace en silencio. Este script lo hace explicito y falla ruidosamente.
 *
 * `syncIndexes()` (y no `createIndexes()`) porque ademas BORRA los indices que ya no estan
 * en el esquema. Los de antes incluian duplicados que ahora sobran.
 *
 * Ejecutar:  node scripts/asegurar-indices.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

// Importar el barrel REGISTRA los modelos. Sin esto, `mongoose.model('Field')` no existe
// todavia, el `.index()` del esquema no se ha ejecutado nunca, y el script se limita a decir
// que no encuentra los indices. O sea: diria que faltan cuando lo que falta es leerlos.
//
// (Pasa porque los modelos se definen al importarlos, no al conectar.)
require('../dist/models/index');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log('Conectado a', mongoose.connection.name, '\n');

  // El barrel no los trae todos (Table, Field y PaymentOrder se quedan fuera), asi que se
  // cargan a mano. Importarlos aqui es lo que hace que su `.index()` del esquema llegue a
  // ejecutarse, y sin eso el indice unico de los campos no existe.
  require('../dist/models/Table');
  require('../dist/models/Field');
  require('../dist/models/PaymentOrder');

  const modelos = ['User', 'Table', 'Field', 'PaymentOrder', 'Transaction'];

  for (const nombre of modelos) {
    let modelo;
    try {
      modelo = mongoose.model(nombre);
    } catch {
      console.log(`  ${nombre}: no cargado en este proceso, se salta`);
      continue;
    }

    const antes = await db.collection(modelo.collection.name).indexes();
    try {
      await modelo.syncIndexes();
      const despues = await db.collection(modelo.collection.name).indexes();
      const nuevos = despues.filter((d) => !antes.some((a) => a.name === d.name));
      console.log(`  ${nombre}: ${antes.length} -> ${despues.length} indices`);
      for (const n of nuevos) console.log(`      + ${n.name}`);
    } catch (err) {
      console.error(`  ${nombre}: FALLO al sincronizar —`, err.message);
      console.error('     Suele ser un indice unico con DUPLICADOS ya en la coleccion.');
      console.error('     Hay que limpiarlos a mano antes; no se hace aqui por seguridad.');
    }
  }

  // ------------------------------------------------------------------
  // VERIFICACION DEL INDICE QUE IMPORTA
  // ------------------------------------------------------------------
  console.log('\n=== un_campo_vivo_por_nivel ===');
  const idx = (await db.collection('fields').indexes()).find(
    (i) => i.name === 'un_campo_vivo_por_nivel',
  );

  if (!idx) {
      console.error('  NO EXISTE. La proteccion contra campos duplicados NO esta activa.');
  } else {
    console.log(`  unique: ${idx.unique}`);
    console.log(`  filtro: ${JSON.stringify(idx.partialFilterExpression)}`);
  }

  // Campos vivos duplicados ahora mismo: si hay mas de uno por nivel, estan a punto de
  // disparar el error de indice.
  const vivos = await db
    .collection('fields')
    .aggregate([
      { $match: { status: { $in: ['filling', 'running', 'final'] } } },
      { $group: { _id: '$tierId', n: { $sum: 1 }, campos: { $push: '$fieldId' } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  if (vivos.length === 0) {
    console.log('  campos vivos por nivel: ninguno duplicado. Se puede crear el indice.');
  } else {
    console.error('  HAY CAMPOS DUPLICADOS VIVOS:');
    for (const v of vivos) console.error(`    ${v._id}: ${v.n} → ${v.campos.join(', ')}`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});


