#!/bin/bash

# CubaPoker - Script de Pruebas
# Uso: ./scripts/test.sh

set -e

echo "🧪 CubaPoker - Ejecutando Pruebas"
echo "=================================="
echo ""

# Verificar que las dependencias estén instaladas
if [ ! -d "node_modules" ]; then
  echo "📦 Instalando dependencias..."
  npm install
fi

# Ejecutar pruebas del backend
echo "🧪 Ejecutando pruebas del backend..."
npm test

# Verificar que el build funcione
echo ""
echo "🔨 Verificando build..."
npm run build

echo ""
echo "✅ Todas las pruebas pasaron!"
