#!/bin/bash

# CubaPoker - Script de Limpieza
# Ugo: ./scripts/clean.sh

set -e

echo "🧹 CubaPoker - Limpieza"
echo "======================="
echo ""

# Limpiar node_modules
echo "🗑️  Limpiando node_modules..."
rm -rf node_modules
rm -rf mini-app/node_modules

# Limpiar builds
echo "🗑️  Limpiando builds..."
rm -rf dist
rm -rf mini-app/dist

# Limpiar logs
echo "🗑️  Limpiando logs..."
rm -rf logs
mkdir -p logs

# Limpiar caché
echo "🗑️  Limpiando caché..."
npm cache clean --force
cd mini-app && npm cache clean --force && cd ..

echo ""
echo "✅ Limpieza completada!"
echo ""
echo "📋 Para reinstalar dependencias:"
echo "   ./scripts/setup.sh"
