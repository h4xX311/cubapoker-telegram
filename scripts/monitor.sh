#!/bin/bash

# CubaPoker - Script de Monitoreo
# Uso: ./scripts/monitor.sh

echo "📊 CubaPoker - Monitoreo"
echo "========================="
echo ""

# Verificar si el bot está corriendo
if pgrep -f "node dist/bot.js" > /dev/null; then
  echo "✅ Bot está corriendo"
else
  echo "❌ Bot NO está corriendo"
fi

# Verificar MongoDB
if mongosh --eval "db.adminCommand('ping')" --quiet > /dev/null 2>&1; then
  echo "✅ MongoDB está conectado"
else
  echo "❌ MongoDB NO está conectado"
fi

# Verificar uso de memoria
MEM_USAGE=$(free -m | awk 'NR==2{printf "%.2f%%", $3*100/$2}')
echo "🧠 Uso de memoria: $MEM_USAGE"

# Verificar uso de disco
DISK_USAGE=$(df -h / | awk 'NR==2{print $5}')
echo "💾 Uso de disco: $DISK_USAGE"

# Verificar procesos de Node
NODE_PROCESSES=$(pgrep -f "node" | wc -l)
echo "🔧 Procesos de Node: $NODE_PROCESSES"

echo ""
echo "📋 Para ver logs en tiempo real:"
echo "   pm2 logs cubapoker-bot"
echo ""
echo "📋 Para reiniciar el bot:"
echo "   pm2 restart cubapoker-bot"
