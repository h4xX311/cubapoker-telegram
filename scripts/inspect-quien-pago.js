// Busca QUIEN pago el buy-in de un campo que nunca empezo.
//
// El campo `cash-t1-muwyjj37` tiene `buyInsCollected: 3000` (3 USDT) y cero jugadores
// sentados, cero en cola y cero transacciones que lo mencionen. O sea: se cobró y no quedó
// constancia. Este script busca por fecha quiénancaril los movimientos de esa hora.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const campos = await db.collection('fields').find({}).toArray();

  for (const f of campos) {
    const cobrado = f.buyInsCollected ?? 0;
    console.log(`\n=== ${f.fieldId}  estado=${f.status}  cobrado=${cobrado} (${cobrado / 1000} USDT)`);

    if (cobrado <= 0) {
      console.log('  sin dinero cobrado: nada que devolver');
      continue;
    }

    const desde = new Date(f.createdAt.getTime() - 5 * 60 * 1000);
    const hasta = new Date(f.createdAt.getTime() + 6 * 60 * 60 * 1000);

    const tx = await db
      .collection('transactions')
      .find({ createdAt: { $gte: desde, $lte: hasta } })
      .toArray();

    console.log(`  movimientos en las 6 horas desde su creacion: ${tx.length}`);

    const relacionados = tx.filter((x) => {
      const m = x.metadata || {};
      return m.fieldId === f.fieldId || f.fieldId.includes(String(x.telegramId));
    });

    for (const x of relacionados) {
      console.log(
        `    ${x.telegramId}  ${x.type}  amount=${x.amount}  meta=${JSON.stringify(x.metadata || {}).slice(0, 90)}`,
      );
    }

    // Todos los movimientos de esa ventana, por si el campo no guarda el id del campo.
    if (relacionados.length === 0) {
      console.log('  (ninguno menciona el campo; movimientos de la ventana:)');
      for (const x of tx.slice(0, 8)) {
        console.log(`    ${x.telegramId}  ${x.type}  amount=${x.amount}  ${(x.createdAt || '').toString().slice(0, 19)}`);
      }
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});