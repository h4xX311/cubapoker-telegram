/**
 * Llena un campo de golpe, para poder probar el juego en desarrollo.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTE SCRIPT EXISTE
 *
 * Un campo Sit'n'Go arranca cuando se llena: `trySeat` mira
 * `countSeated(field) >= field.targetField`, y `targetField` viene de `fieldSize`, que en
 * la fabrica `tier()` esta puesto a 300 para TODOS los tiers.
 *
 * O sea: para probar el juego de verdad habria que registrar 300 jugadores. Y cada uno
 * necesita saldo para el buy-in. Es imposible a mano, y no es un problema del entorno de
 * desarrollo: es que el producto esta disenado para un campo de 300.
 *
 * Este script hace lo que haria un ejercito de bots reales: crea los usuarios con saldo y
 * los registra en el campo con el MISMO codigo de produccion (`fieldManager.register`), no
 * con un atajo. Si el campo no llena con este script, es que no llenaria de verdad.
 *
 * ------------------------------------------------------------------
 * QUE SE PUEDE TOCAR
 *
 *   --players N     cuantos jugadores falsos registrar (por defecto, los que falten)
 *   --tier t1       tier del campo (por defecto t1)
 *   --target N      reduce el campo a N participantes, para que arranque en segundos
 *   --from 600000010  desde que id se registran los falsos (el 600000001 eres tu)
 *   --balance N     saldo inicial en unidades internas de cada falso (1 USDT = 1000)
 *
 * ------------------------------------------------------------------
 * EJEMPLOS
 *
 *   node scripts/dev-fill-field.js --target 14
 *     Campo de 14. Registras 13 falsos y tu entras: arranca al instante.
 *
 *   node scripts/dev-fill-field.js --players 5
 *     Rellena lo que falte para un campo de 300. Tarda, pero es el campo real.
 *
 * Ejecutar con el servidor YA arrancado en otra terminal, para que los bots sigan jugando
 * mientras esto mete gente:
 *
 *   npm run dev
 *   node scripts/dev-fill-field.js --target 14
 */

process.env.DEV_AUTH_BYPASS = 'true';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const mongoose = require('mongoose');

const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf('--' + nombre);
  if (i < 0) return porDefecto;
  const v = args[i + 1];
  return v === undefined ? true : v;
};

const TIER = String(opcion('tier', 't1'));
const TARGET = opcion('target', null);
const PLAYERS = opcion('players', null);
const DESDE = Number(opcion('from', 600000010));
const BALANCE = Number(opcion('balance', 5_000_000));

// ------------------------------------------------------------------
// LA BASE DE DATOS TIENE QUE SER LA MISMA QUE USA EL SERVIDOR
//
// Si no, los jugadores falsos se registran en una base y el servidor, que esta leyendo
// otra, no los ve nunca. El campo no se llena y el error que sale es desconcertante:
// "No se pudo cobrar el buy-in", cuando el problema no es el buy-in sino que los dos
// procesos estan mirando bases distintas.
//
// Y asi fue: el servidor lee el `.env` (Atlas) y este script, con su valor por defecto,
// apuntaba a Mongo de WSL. Los 13 falsos estaban en una base que el servidor no abria
// nunca.
//
// Por defecto se lee el `.env` del proyecto, que es lo que hace `npm run dev`. Si se pasa
// `MONGODB_URI` en el entorno, manda ese: asi se puede probar contra otra base sin
// tocar nada.
// ------------------------------------------------------------------
const leerDelEnv = () => {
  try {
    const fs = require('fs');
    const ruta = require('path').join(__dirname, '..', '.env');
    if (!fs.existsSync(ruta)) return null;
    for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
      const m = linea.match(/^\s*MONGODB_URI\s*=\s*(.+?)\s*$/);
      if (m && !linea.trim().startsWith('#')) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {
    // si algo falla, se cae al valor de abajo
  }
  return null;
};

const MONGODB_URI =
  process.env.MONGODB_URI ||
  leerDelEnv() ||
  'mongodb://127.0.0.1:37017/cubapoker';

async function main() {
  console.log('\n\x1b[1mCubaPoker · Llenar un campo para probar el juego\x1b[0m');
  console.log(`  MongoDB: ${MONGODB_URI.replace(/\/\/([^@]*)@/, '//***@')}`);
  console.log(`  tier: ${TIER}${TARGET ? `  target: ${TARGET}` : ''}`);
  console.log(`  falsos desde ${DESDE}, ${BALANCE} unidades de saldo cada uno\n`);

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log('conectado\n');

  const { User } = require('../dist/models/User');
  const { Field } = require('../dist/models/Field');
  const { getTier } = require('../dist/config/product');
  const { fieldManager } = require('../dist/game/field.manager');

  const tier = getTier(TIER);
  if (!tier) {
    console.error(`El tier "${TIER}" no existe.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`tier ${TIER}: ${tier.fieldSize} participantes, buy-in ${tier.buyInUsdt} USDT`);

  // Si se pide un campo mas pequeno, se recorta ANTES de registrar a nadie: si no, los
  // primeros registros ya habrian llenado el campo de verdad y arrancado.
  if (TARGET) {
    const n = Number(TARGET);
    await Field.updateMany(
      { kind: 'freeroll', status: { $in: ['filling', 'running'] } },
      { $set: { targetField: n } },
    );
    console.log(`campos de freeroll recortados a ${n} participantes\n`);
  }

  // Cuantos faltan.
  let existentes = 0;
  if (PLAYERS) {
    existentes = Number(PLAYERS);
  } else {
    const abierto = await Field.findOne({ tierId: TIER, status: 'filling' });
    const objetivo = TARGET ? Number(TARGET) : (abierto?.targetField ?? tier.fieldSize);
    existentes = Math.max(0, objetivo - 1);   // uno sera el del usuario real
    console.log(`el campo necesita ${objetivo}; se registraran ${existentes} falsos\n`);
  }

  const hechos = [];
  for (let i = 0; i < existentes; i++) {
    const telegramId = DESDE + i;

    // Alta del usuario con saldo. `findOneAndUpdate` con upsert, y no `create`: si el
    // script se repite no debe reventar por duplicado.
    await User.findOneAndUpdate(
      { telegramId },
      {
        $setOnInsert: {
          telegramId,
          username: 'bot' + telegramId,
          firstName: 'Bot ' + telegramId,
          balance: { real: BALANCE, play: 0 },
          stats: {
            handsPlayed: 0, handsWon: 0, tablesJoined: 0,
            freerollsPlayed: 0, totalRakePaid: 0, totalFreerollWon: 0,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    try {
      const r = await fieldManager.register(telegramId, TIER, 'bot' + telegramId);
      hechos.push(r.fieldId);
      if ((i + 1) % 10 === 0 || i === existentes - 1) {
        process.stdout.write(`  ${i + 1}/${existentes} registrados\r`);
      }
    } catch (e) {
      // Un fallo aqui es informativo: dice por que no se puede entrar al campo.
      console.error(`\n  el jugador ${telegramId} NO ha podido entrar: ${e.message}`);
      break;
    }
  }

  console.log(`\n${hechos.length} registrados`);

  const campos = await Field.find({ tierId: TIER }).sort({ createdAt: -1 });
  console.log('\ncampos de este tier:');
  for (const c of campos.slice(0, 4)) {
    console.log(
      `  ${c.fieldId}  ${c.status}  sentados=${c.seated}  esperando=${c.waiting}  ` +
      `vivos=${c.playersRemaining}  bote=${c.buyInsCollected}  mesas=${c.tables.length}`,
    );
  }

  const arrancado = campos.find((c) => c.status === 'running' || c.status === 'final');
  console.log('');
  if (arrancado) {
    console.log(`\x1b[32mEl campo ${arrancado.fieldId} esta arrancado.\x1b[0m`);
    console.log('Registrate tu en la web (localhost:5173) y te sentara en una mesa.');
  } else {
    console.log('\x1b[33mEl campo sigue ABIERTO: faltan jugadores.\x1b[0m');
    console.log('Registrate tu en la web: al hacerlo, el campo se llena y arranca.');
    console.log('Si sigue abierto, mira los avisos WARN del servidor: diran por que.');
  }

  console.log('\n\x1b[2mEl servidor tiene que estar arrancado en otra terminal (npm run dev),\x1b[0m');
  console.log('\x1b[2msino los bots no juegan y las mesas se quedan quietas.\x1b[0m\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('\n\x1b[31mEl script reviento:\x1b[0m');
  console.error(e);
  try { await mongoose.disconnect(); } catch { /* nada */ }
  process.exit(1);
});