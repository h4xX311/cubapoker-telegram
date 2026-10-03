#!/bin/bash

# CubaPoker - Script de Despliegue
# Uso: ./scripts/deploy.sh [entorno]

set -e

ENV=${1:-production}
echo "🚀 Desplegando CubaPoker en entorno: $ENV"

# Verificar que las variables de entorno estén configuradas
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "❌ Error: TELEGRAM_BOT_TOKEN no está configurado"
  exit 1
fi

if [ -z "$MONGODB_URI" ]; then
  echo "❌ Error: MONGODB_URI no está configurado"
  exit 1
fi

# Instalar dependencias
echo "📦 Instalando dependencias..."
npm install

# Construir backend
echo "🔨 Construyendo backend..."
npm run build

# Construir mini app
echo "🔨 Construyendo mini app..."
cd mini-app
npm install
npm run build
cd ..

# Verificar que todo esté listo
echo "✅ Build completado"

# Desplegar según el entorno
if [ "$ENV" = "production" ]; then
  echo "🚀 Desplegando en producción..."
  # Aquí puedes agregar comandos específicos para tu plataforma de despliegue
  # Por ejemplo, para Render:
  # git push origin main
  # o para Docker:
  # docker-compose up -d --build
elif [ "$ENV" = "docker" ]; then
  echo "🐳 Desplegando con Docker..."
  docker-compose up -d --build
else
  echo "❌ Entorno no válido: $ENV"
  exit 1
fi

echo "✅ Despliegue completado!"
echo "📱 Mini App URL: $MINI_APP_URL"
