#!/bin/bash

# CubaPoker - Script de Actualización
# Uso: ./scripts/update.sh

set -e

echo "🔄 CubaPoker - Actualización"
echo "============================"
echo ""

# Verificar si hay cambios en el repositorio
if [ -d ".git" ]; then
  echo "📥 Descargando últimos cambios..."
  git pull origin main
  echo "✅ Código actualizado"
else
  echo "⚠️  No es un repositorio git, omitiendo actualización de código"
fi

# Actualizar dependencias
echo ""
echo "📦 Actualizando dependencias..."
npm install

echo "📦 Actualizando dependencias del mini app..."
cd mini-app
npm install
cd ..

# Reconstruir
echo ""
echo "🔨 Reconstruyendo..."
npm run build
cd mini-app && npm run build && cd ..

echo ""
echo "✅ Actualización completada!"
echo ""
echo "📋 Para reiniciar el bot:"
echo "   pm2 restart cubapoker-bot"
