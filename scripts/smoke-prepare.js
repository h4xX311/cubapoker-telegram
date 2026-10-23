/**
 * Limpia la base de la prueba de humo ANTES de arrancar el servidor.
 *
 * Se hace aqui y no en el cliente porque el servidor ya tiene un freeroll abierto cuando el
 * cliente empieza: borrarlo desde el cliente lo obliga a crear otro a mitad de la prueba y
 * mezcla el estado real con el de la prueba.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('Falta MONGODB_URI.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  await db.collection('fields').deleteMany({ kind: 'freeroll' });
  await db.collection('tables').deleteMany({});
  await db.collection('users').deleteOne({ telegramId: 880001 });

  await mongoose.disconnect();
  console.log('Base de humo limpia.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
