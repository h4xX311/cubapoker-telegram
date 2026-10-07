// Consulta de SOLO LECTURA: donde esta sentado este usuario de verdad.
// No escribe nada.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const tid = '600000001';

  const mesas = await db
    .collection('tables')
    .find({ 'seats.playerId': tid })
    .project({ tableId: 1, kind: 1, status: 1, 'seats.$': 1, buyInUnits: 1, 'hand.phase': 1 })
    .toArray();

  console.log(`mesas donde tiene asiento: ${mesas.length}\n`);

  for (const m of mesas) {
    const mio = (m.seats || []).filter((s) => String(s.playerId) === tid);
    console.log(
      `${m.tableId}  kind=${m.kind} mesaStatus=${m.status} fase=${m.hand && m.hand.phase} buyIn=${m.buyInUnits}`,
    );
    for (const s of mio) {
      console.log(
        `    asiento ${s.index}: status=${s.status} chips=${s.chips} bet=${s.bet} kind=${s.kind}`,
      );
    }
  }

  const user = await db
    .collection('users')
    .findOne({ telegramId: Number(tid) });
  console.log(`\nusuario: activeTableId=${user && user.activeTableId}`);
  console.log(`balance: ${JSON.stringify(user && user.balance)}`);

  process.exit(0);
})();