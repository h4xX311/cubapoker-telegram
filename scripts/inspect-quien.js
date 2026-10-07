// Consulta de SOLO LECTURA: quien esta jugando de verdad y donde esta sentado.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const conAsiento = await db
    .collection('tables')
    .find({ 'seats.playerId': { $exists: true } })
    .project({ tableId: 1, kind: 1, seats: 1, status: 1, 'hand.phase': 1, buyInUnits: 1 })
    .toArray();

  console.log('=== MESAS CON ALGUN ASENTO HUMANO ===');
  for (const m of conAsiento) {
    const humanos = (m.seats || []).filter(
      (s) => s.kind === 'human' && s.status !== 'empty',
    );
    const bots = (m.seats || []).filter((s) => s.kind === 'bot');
    console.log(
      `${m.tableId} kind=${m.kind} mesa=${m.status} fase=${m.hand && m.hand.phase} buyIn=${m.buyInUnits} humanos=${humanos.length} bots=${bots.length}`,
    );
    for (const s of humanos) {
      console.log(
        `    humano asiento ${s.index} playerId=${s.playerId} status=${s.status} chips=${s.chips}`,
      );
    }
  }

  console.log('\n=== USUARIOS CON SALDO (los 8 mayores) ===');
  const users = await db
    .collection('users')
    .find({})
    .project({ telegramId: 1, balance: 1, activeTableId: 1, updatedAt: 1, createdAt: 1 })
    .sort({ 'balance.real': -1 })
    .limit(8)
    .toArray();

  for (const u of users) {
    const r = u.balance && u.balance.real;
    const p = u.balance && u.balance.play;
    console.log(
      `telegramId=${u.telegramId} real=${r} play=${p} activo=${u.activeTableId} upd=${u.updatedAt}`,
    );
  }

  process.exit(0);
})();