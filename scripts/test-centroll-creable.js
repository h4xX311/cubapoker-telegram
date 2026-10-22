/**
 * COMPRUEBA SI UN CENTROLL SE PUEDE CREAR.
 *
 * `centroll.service.ts` hace `Field.create({ kind: 'centroll', ... })`, pero el esquema de
 * `Field` declara `kind` con `enum: ['cash', 'freeroll']`. Si eso es cierto, cada intento de
 * abrir un centroll falla con `ValidationError`, y el producto tiene una funcion entera muerta
 * sin que nada avise: el error se lo come un `catch` y el jugador solo ve "no se pudo".
 *
 * No se afirma leyendo el esquema. Se intenta crear uno y se mira que pasa.
 *
 * Ejecutar:  MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_centroll node scripts/test-centroll-creable.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Field } = require('../dist/models/Field');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  await db.collection('fields').deleteMany({ kind: 'centroll' });

  const base = {
    fieldId: 'centroll-prueba-' + Date.now().toString(36),
    tierId: 'centroll',
    status: 'filling',
    buyInUnits: 100,
    targetField: 50,
    waiting: 0,
    seated: 0,
    playersRemaining: 0,
    paidPositionsLeft: 5,
    plannedTables: 1,
    tables: [],
  };

  let cashOk = null;
  try {
    await Field.create({ ...base, fieldId: base.fieldId + '-cash', kind: 'cash' });
    cashOk = true;
  } catch (e) {
    cashOk = e.message;
  }
  console.log('kind=cash      ->', cashOk === true ? 'creado' : 'FALLA: ' + cashOk);

  let centOk = null;
  try {
    const c = await Field.create({ ...base, kind: 'centroll' });
    centOk = true;
    console.log('kind=centroll  -> creado (' + c.fieldId + ')');
  } catch (e) {
    centOk = e.message;
    console.log('kind=centroll  -> FALLA:', e.name + ': ' + e.message);
  }

  console.log('');
  if (cashOk === true && centOk !== true) {
    console.log('CONFIRMADO: el centroll NO se puede crear. La funcion esta muerta.');
  } else if (centOk === true) {
    console.log('El centroll SI se crea. Mi lectura del enum era incompleta.');
  }

  await db.collection('fields').deleteMany({ kind: { $in: ['cash', 'centroll'] } });
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR DEL TEST:', e);
  process.exit(1);
});
