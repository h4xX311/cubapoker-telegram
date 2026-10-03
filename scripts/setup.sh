#!/bin/bash

# CubaPoker - Script de Configuración Inicial
# Uso: ./scripts/setup.sh

set -e

echo "🎰 CubaPoker - Configuración Inicial"
echo "======================================"
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js no está instalado"
  echo "   Instala Node.js 18+ desde https://nodejs.org"
  exit 1
fi

echo "✅ Node.js $(node -v) detectado"

# Verificar npm
if ! command -v npm &> /dev/null; then
  echo "❌ npm no está instalado"
  exit 1
fi

echo "✅ npm $(npm -v) detectado"
echo ""

# Crear archivo .env si no existe
if [ ! -f .env ]; then
  echo "📝 Creando archivo .env..."
  cp .env.example .env
  echo "✅ Archivo .env creado"
  echo "⚠️  Edita .env con tus credenciales antes de continuar"
  echo ""
fi

# Instalar dependencias del backend
echo "📦 Instalando dependencias del backend..."
npm install
echo "✅ Dependencias del backend instaladas"
echo ""

# Instalar dependencias del mini app
echo "📦 Instalando dependencias del mini app..."
cd mini-app
npm install
echo "✅ Dependencias del mini app instaladas"
cd ..
echo ""

# Crear directorio de logs
mkdir -p logs

echo "✅ Configuración completada!"
echo ""
echo "📋 Próximos pasos:"
echo "   1. Edita .env con tus credenciales"
echo "   2. Crea un bot en Telegram (@BotFather)"
echo "   3. Configura MongoDB Atlas"
echo "   4. Ejecuta: npm run dev"
echo ""
echo "📖 Documentación: PRODUCTION.md"
echo "👤 Guía del usuario: USER_GUIDE.md"
