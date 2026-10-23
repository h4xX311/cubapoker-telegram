#!/bin/bash
#
# PRUEBA DE HUMO DEL FREEROLL POR HTTP
# ====================================
#
# Levanta el servidor de verdad en un puerto aparte, espera a que escuche, lanza el cliente
# y lo apaga. Sirve para comprobar lo que los tests del servicio NO pueden: el router, la
# autenticacion y el prefijo `/api/game`.
#
# El servidor se arranca desde bash y no desde Node a proposito: un hijo lanzado con
# `child_process.spawn` desde Node dentro de WSL se queda bloqueado en I/O sobre /mnt/c.
#
# ------------------------------------------------------------------
# SI EL SERVIDOR NO ARRANCA EN WSL
#
# Poner `node` en segundo plano sobre /mnt/c dentro de WSL puede dejarlo en estado D
# (espera de E/S) sin escribir una sola linea. No es un fallo del producto. Si aqui se
# queda en "El servidor no arranco", abre otra terminal WSL y ejecuta el servidor en
# primer plano a mano:
#
#     cd ~/cp
#     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_smoke \
#       DEV_AUTH_BYPASS=true PORT=3999 TELEGRAM_BOT_TOKEN= \
#       NODE_ENV=test node dist/bot.js
#
# y en esta terminal, con el servidor ya escuchando:
#
#     MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_smoke \
#       SMOKE_BASE=http://127.0.0.1:3999 node scripts/smoke-freeroll-http.js
# ------------------------------------------------------------------
#
# Uso:
#     bash scripts/run-smoke-http.sh
#
set -u

cd "$(dirname "$0")/.." || exit 1

export MONGODB_URI="${SMOKE_DB:-mongodb://127.0.0.1:37017/cubapoker_smoke}"
export DEV_AUTH_BYPASS=true
export DEV_AUTH_ID=880001
export PORT="${SMOKE_PORT:-3999}"
export TELEGRAM_BOT_TOKEN=""
export MINI_APP_URL="http://127.0.0.1:${PORT}"
export NODE_ENV=test
export SMOKE_BASE="http://127.0.0.1:${PORT}"

echo "Compilando…"
npm run build >/dev/null 2>&1 || {
  echo "Fallo el build. Ejecuta 'npm run build' para ver el error."
  exit 1
}

# La base se limpia ANTES de arrancar. Si se limpiara desde el cliente, borraria el freeroll
# que el servidor ya tiene abierto y obligaria a abrir otro a mitad de la prueba.
echo "Limpiando la base de humo…"
node scripts/smoke-prepare.js || exit 1

echo "Arrancando el servidor…"
node dist/bot.js > /tmp/cubapoker-smoke.log 2>&1 &
SERVER_PID=$!

limpiar() {
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap limpiar EXIT

LISTO=0
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    LISTO=1
    break
  fi
  sleep 0.5
done

if [ "$LISTO" -ne 1 ]; then
  echo "El servidor no arranco. Ultimas lineas del log:"
  tail -30 /tmp/cubapoker-smoke.log
  exit 1
fi

node scripts/smoke-freeroll-http.js
RESULTADO=$?

echo ""
echo "--- ultimas lineas del servidor ---"
tail -10 /tmp/cubapoker-smoke.log

exit $RESULTADO
