#!/bin/bash

# CubaPoker - Script de Backup
# Uso: ./scripts/backup.sh

set -e

BACKUP_DIR="./backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/cubapoker_backup_$DATE"

echo "💾 CubaPoker - Creando Backup"
echo "==============================="
echo ""

# Crear directorio de backups
mkdir -p "$BACKUP_DIR"

# Backup de MongoDB
echo "📦 Creando backup de MongoDB..."
mongodump --uri="$MONGODB_URI" --out="$BACKUP_FILE"

# Comprimr backup
echo "🗜️  Comprimiendo backup..."
tar -czf "$BACKUP_FILE.tar.gz" -C "$BACKUP_DIR" "cubapoker_backup_$DATE"

# Limpiar archivos temporales
rm -rf "$BACKUP_FILE"

echo ""
echo "✅ Backup creado: $BACKUP_FILE.tar.gz"
echo ""
echo "📋 Para restaurar:"
echo "   tar -xzf $BACKUP_FILE.tar.gz"
echo "   mongorestore --uri=\"$MONGODB_URI\" cubapoker_backup_$DATE"
