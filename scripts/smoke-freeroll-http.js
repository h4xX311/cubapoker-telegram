/**
 * PRUEBA DE HUMO DE LAS RUTAS HTTP DEL FREEROLL
 * =============================================
 *
 * Los tests del servicio llaman a `freerollManager` directamente. Eso demuestra que la
 * logica funciona, pero NO que la Mini App pueda usarla: entre las dos hay un router, un
 * middleware de autenticacion y un prefijo `/api/game`. Si cualquiera de los tres esta mal,
 * el servicio pasa sus 34 pruebas y el jugador ve un 404.
 *
 * Este script es SOLO el cliente. El servidor lo levanta `run-smoke-http.sh` en segundo
 * plano: lanzarlo desde Node dentro de WSL deja el hijo bloqueado en I/O sobre /mnt/c.
 *
 * Recorre el mismo camino que recorre el telefono:
 *
 *     GET  /api/game/freerolls            -> hay un freeroll abierto
 *     POST /api/game/freerolls/register   -> se inscribe
 *     GET  /api/game/freerolls            -> aparece como inscrito
 *     POST /api/game/freerolls/register   -> el duplicado se rechaza con 400
 *     POST /api/game/freerolls/leave      -> cancela
 *     GET  /api/game/freerolls            -> ya no aparece inscrito
 *
 * Ejecutar:
 *     bash scripts/run-smoke-http.sh
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../dist/models/User');

const DB = process.env.MONGODB_URI;
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3999';
const DEV_ID = 880001;

let ok = 0;
let mal = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    ok++;
    console.log(`\x1b[32m  ok \x1b[0m ${nombre}`);
  } else {
    mal++;
    console.log(
      `\x1b[31m FALLA\x1b[0m ${nombre}${detalle ? ' â€” ' + detalle : ''}`,
    );
  }
}

async function pedir(ruta, opciones = {}) {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'x-dev-auth': String(DEV_ID),
      'content-type': 'application/json',
      ...(opciones.headers || {}),
    },
  });

  const texto = await res.text();
  let cuerpo = null;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    cuerpo = texto;
  }

  return { status: res.status, cuerpo };
}

(async () => {
  if (!DB) {
    console.error('Falta MONGODB_URI.');
    process.exit(1);
  }

  // --- Preparar un usuario limpio ---
  // NO se borran campos ni mesas aqui: el servidor ya esta en marcha y tiene un freeroll
  // abierto. Borrarlo desde el cliente crea un campo nuevo a mitad de la prueba y confunde
  // el diagnostico. La limpieza la hace `scripts/smoke-prepare.js` ANTES de arrancar.
  await mongoose.connect(DB);
  const db = mongoose.connection.db;

  await db.collection('users').deleteOne({ telegramId: DEV_ID });

  await User.create({
    telegramId: DEV_ID,
    firstName: 'Humo',
    username: 'humo',
    balance: { real: 0, play: 0, realFromPrizes: 0 },
    stats: {
      handsPlayed: 0,
      handsWon: 0,
      tablesJoined: 0,
      freerollsPlayed: 0,
      totalRakePaid: 0,
      totalFreerollWon: 0,
    },
    activeTableId: null,
  });

  await mongoose.disconnect();

  try {
    console.log('\n=== 1. El lobby responde ===\n');

    const lobby1 = await pedir('/api/game/freerolls');
    comprobar('GET /freerolls devuelve 200', lobby1.status === 200, `status=${lobby1.status}`);
    comprobar(
      'hay un freeroll abierto',
      !!lobby1.cuerpo?.abierto?.fieldId,
      JSON.stringify(lobby1.cuerpo)?.slice(0, 200),
    );
    comprobar(
      'el lobby trae la hora de inicio (ISO)',
      !!lobby1.cuerpo?.abierto?.inicio,
      'sin inicio',
    );
    comprobar(
      'el premio llega en USDT',
      Number(lobby1.cuerpo?.abierto?.premioUsdt) > 0,
      `premio=${lobby1.cuerpo?.abierto?.premioUsdt}`,
    );
    comprobar(
      'trae los proximos slots',
      Array.isArray(lobby1.cuerpo?.proximos) && lobby1.cuerpo.proximos.length > 0,
      'sin proximos',
    );

    const fieldId = lobby1.cuerpo.abierto.fieldId;

    console.log('\n=== 2. Inscripcion por HTTP ===\n');

    const alta = await pedir('/api/game/freerolls/register', {
      method: 'POST',
      body: JSON.stringify({ fieldId }),
    });

    comprobar('POST /register devuelve 200', alta.status === 200, `status=${alta.status}`);
    comprobar('la respuesta dice que quedo inscrito', alta.cuerpo?.success === true);

    const lobby2 = await pedir('/api/game/freerolls');
    comprobar(
      'el lobby lo marca como inscrito',
      lobby2.cuerpo?.abierto?.inscrito === true,
      `inscrito=${lobby2.cuerpo?.abierto?.inscrito}`,
    );
    comprobar(
      'cuenta un inscrito',
      lobby2.cuerpo?.abierto?.inscritos === 1,
      `inscritos=${lobby2.cuerpo?.abierto?.inscritos}`,
    );

    console.log('\n=== 3. El duplicado se rechaza ===\n');

    const dup = await pedir('/api/game/freerolls/register', {
      method: 'POST',
      body: JSON.stringify({ fieldId }),
    });

    comprobar('el duplicado devuelve 400', dup.status === 400, `status=${dup.status}`);
    comprobar(
      'dice por que',
      /ya estas apuntado/i.test(dup.cuerpo?.error ?? ''),
      dup.cuerpo?.error,
    );

    console.log('\n=== 4. Cancelar la inscripcion ===\n');

    const baja = await pedir('/api/game/freerolls/leave', {
      method: 'POST',
      body: JSON.stringify({ fieldId }),
    });

    comprobar('POST /leave devuelve 200', baja.status === 200, `status=${baja.status}`);
    comprobar('la respuesta confirma la baja', baja.cuerpo?.salio === true);

    const lobby3 = await pedir('/api/game/freerolls');
    comprobar(
      'ya no aparece inscrito',
      lobby3.cuerpo?.abierto?.inscrito === false,
      `inscrito=${lobby3.cuerpo?.abierto?.inscrito}`,
    );
    comprobar(
      'vuelve a haber cero inscritos',
      lobby3.cuerpo?.abierto?.inscritos === 0,
      `inscritos=${lobby3.cuerpo?.abierto?.inscritos}`,
    );


    console.log('');
    console.log('=== 5. La pantalla de mesas cash no lista el freeroll ===');
    console.log('');

    const campos = await pedir('/api/game/fields');
    comprobar('GET /fields devuelve 200', campos.status === 200, `status=${campos.status}`);

    const lista = campos.cuerpo?.fields ?? [];
    comprobar(
      'solo devuelve campos cash',
      lista.every((f) => f.kind === 'cash'),
      lista.map((f) => `${f.fieldId}:${f.kind}`).join(', '),
    );
    comprobar(
      'no se cuela el freeroll horario',
      lista.every((f) => !String(f.tierId ?? '').startsWith('freeroll-')),
      lista.map((f) => f.tierId).join(', '),
    );

    console.log('\n=== 6. Cancelar dos veces no rompe nada ===\n');

    const baja2 = await pedir('/api/game/freerolls/leave', {
      method: 'POST',
      body: JSON.stringify({ fieldId }),
    });

    comprobar('la segunda baja devuelve 200', baja2.status === 200, `status=${baja2.status}`);
    comprobar(
      'y dice que no habia nada que cancelar',
      baja2.cuerpo?.salio === false,
      `salio=${baja2.cuerpo?.salio}`,
    );
  } finally {
    await mongoose.connect(DB);
    const db2 = mongoose.connection.db;
    await db2.collection('users').deleteOne({ telegramId: DEV_ID });
    await db2.collection('fields').deleteMany({ kind: 'freeroll' });
    await db2.collection('tables').deleteMany({});
    await mongoose.disconnect();
  }

  console.log(`\nResultado: ${ok} correctos, ${mal} fallidos`);
  process.exit(mal > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERROR DEL SMOKE:', e);
  process.exit(1);
});
