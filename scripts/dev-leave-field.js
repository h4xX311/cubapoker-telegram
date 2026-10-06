/**
 * Salir de un campo en el que se ha quedado uno sentado.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTE SCRIPT
 *
 * Un campo arranca cuando se llena. Si te apuntas a uno y no se llena, te quedas SENTADO
 * con el buy-in cobrado, y el siguiente intento de entrar devuelve "Ya estas jugando en un
 * campo". La interfaz ya tiene un boton para salir (ver `Tables.tsx`), pero ese boton
 * necesita el servidor reiniciado con el codigo nuevo, y mientras tanto no hay salida.
 *
 * Esto es la salida de emergencia: llama al MISMO metodo de produccion
 * (`fieldManager.unregister`), asi que devuelve el buy-in igual que lo haria el boton, y no
 * deja al usuario en un estado raro que el codigo normal no sepa manejar.
 *
 * ------------------------------------------------------------------
 * QUE HACE
 *
 *   - Localiza el campo en el que esta el usuario
 *   - Llama a `unregister`, que lo saca de la cola y le devuelve el buy-in entero
 *   - Dice que ha pasado, con las cifras
 *
 * Solo funciona mientras el campo este en `filling`. Una vez que ha arrancado no se puede
 * salir, y el script lo dice en vez de fingir.
 *
 * Uso:
 *   node scripts/dev-leave-field.js                  # el usuario de desarrollo
 *   node scripts/dev-leave-field.js 600000001        # otro
 *   node scripts/dev-leave-field.js 600000001 --ver  # solo mirar, no tocar nada
 */

process.env.DEV_AUTH_BYPASS = 'true';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const mongoose = require('mongoose');

const args = process.argv.slice(2);
const soloVer = args.includes('--ver');
const telegramId = Number(args.find((a) => /^\d+$/.test(a))) || 600000001;

// La MISMA base que usa el servidor. Si no, el usuario no existe aqui y el script
// diria que no esta en ningun campo cuando si lo esta.
const leerDelEnv = () => {
  try {
    const fs = require('fs');
    const path = require('path');
    const ruta = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(ruta)) return null;
    for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
      const m = linea.match(/^\s*MONGODB_URI\s*=\s*(.+?)\s*$/);
      if (m && !linea.trim().startsWith('#')) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch { /* se cae al valor de abajo */ }
  return null;
};

const MONGODB_URI =
  process.env.MONGODB_URI || leerDelEnv() || 'mongodb://127.0.0.1:37017/cubapoker';

const fmt = (u) => (u / 1000).toLocaleString('es-ES', { maximumFractionDigits: 3 }) + ' USDT';

async function main() {
  console.log('\n\x1b[1mCubaPoker · Salir de un campo\x1b[0m');
  console.log(`  usuario: ${telegramId}`);
  console.log(`  MongoDB: ${MONGODB_URI.replace(/\/\/([^@]*)@/, '//***@')}`);
  if (soloVer) console.log('  modo: SOLO VER, no se toca nada');
  console.log('');

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  const { User } = require('../dist/models/User');
  const { fieldManager } = require('../dist/game/field.manager');
  const { formatUnits } = require('../dist/config/units');

  const user = await User.findOne({ telegramId });
  if (!user) {
    console.error(`\x1b[31mNo existe ningun usuario con telegramId ${telegramId}.\x1b[0m`);
    console.log('Si acabas de crearlo con la web, espera un momento y prueba otra vez.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`saldo: ${formatUnits(user.balance.real)} real + ${formatUnits(user.balance.play)} promocion`);

  const donde = await fieldManager.fieldOf(telegramId);
  if (!donde) {
    console.log('\n\x1b[32mNo estas en ningun campo. No hay nada que hacer.\x1b[0m\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const { Field } = require('../dist/models/Field');
  const campo = await Field.findOne({ fieldId: donde.fieldId });
  console.log(`campo: ${donde.fieldId}  estado=${campo?.status}  mesa=${donde.tableId}`);
  console.log(`  sentados=${campo?.seated}  esperando=${campo?.waiting}  vivos=${campo?.playersRemaining}  de ${campo?.targetField}`);

  if (campo?.status !== 'filling') {
    console.log(`\n\x1b[33mEl campo ya esta en "${campo?.status}".\x1b[0m`);
    console.log('En "running" o "final" no se puede salir: ya estas jugando y tus fichas');
    console.log('son del bote. Salir seria quedarse con el premio sin jugar.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (soloVer) {
    console.log('\n\x1b[2mSolo mirando. Quita --ver para salir de verdad.\x1b[0m\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const antes = user.balance.real;
  const r = await fieldManager.unregister(telegramId, donde.fieldId);

  const despues = await User.findOne({ telegramId });
  console.log(`\nsalido. devuelto: ${formatUnits(r.refunded)}`);
  console.log(`saldo real: ${formatUnits(antes)} -> ${formatUnits(despues.balance.real)}`);

  const otro = await fieldManager.fieldOf(telegramId);
  console.log(otro
    ? `\n\x1b[31mSigues apareciendo en un campo (${otro.fieldId}).\x1b[0m`
    : '\n\x1b[32mYa no estas en ningun campo. Ya puedes registrarte en otro.\x1b[0m');

  console.log('');
  await mongoose.disconnect();
  process.exit(otro ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n\x1b[31mEl script reviento:\x1b[0m');
  console.error(e);
  try { await mongoose.disconnect(); } catch { /* nada */ }
  process.exit(1);
});