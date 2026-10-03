#!/bin/bash

# CubaPoker - Script de Verificación Post-Despliegue
# Uso: ./scripts/verify.sh <URL_BASE>

set -e

BASE_URL=${1:-"https://cubapoker-telegram-bot.onrender.com"}

echo "🔍 CubaPoker - Verificación Post-Despliegue"
echo "============================================="
echo ""
echo "URL base: $BASE_URL"
echo ""

# Colores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

check_endpoint() {
  local name=$1
  local endpoint=$2
  local expected_status=${3:-200}
  
  echo -n "  $name... "
  
  response=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL$endpoint" 2>/dev/null || echo "000")
  
  if [ "$response" = "$expected_status" ]; then
    echo -e "${GREEN}✓ OK${NC} ($response)"
    ((PASS++))
  else
    echo -e "${RED}✗ FAIL${NC} (esperado: $expected_status, recibido: $response)"
    ((FAIL++))
  fi
}

check_json_field() {
  local name=$1
  local endpoint=$2
  local field=$3
  
  echo -n "  $name... "
  
  value=$(curl -s "$BASE_URL$endpoint" 2>/dev/null | grep -o "\"$field\"[^,}]*" | head -1)
  
  if [ -n "$value" ]; then
    echo -e "${GREEN}✓ OK${NC} ($value)"
    ((PASS++))
  else
    echo -e "${RED}✗ FAIL${NC} (campo no encontrado)"
    ((FAIL++))
  fi
}

echo "🏥 Health Check"
echo "---------------"
check_endpoint "Health endpoint" "/health"
check_json_field "Status field" "/health" "status"
echo ""

echo "🔌 API Endpoints"
echo "----------------"
check_endpoint "Get user (test)" "/api/user/123456" "404"
check_endpoint "Get VIP config" "/api/monetization/vip/config"
check_endpoint "Get monetization config" "/api/monetization/config"
check_endpoint "Get active games" "/api/game/active"
check_endpoint "Get tournaments" "/api/game/tournaments"
echo ""

echo "📱 Frontend"
echo "-----------"
check_endpoint "Mini App (HTML)" "/"
echo ""

echo "📊 Resultados"
echo "============="
echo -e "${GREEN}Tests pasados: $PASS${NC}"
echo -e "${RED}Tests fallidos: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✅ Todas las verificaciones pasaron${NC}"
  echo ""
  echo "🎉 CubaPoker está listo para producción!"
  echo ""
  echo "📋 Próximos pasos:"
  echo "   1. Abre Telegram y busca tu bot"
  echo "   2. Envía /start"
  echo "   3. Prueba /vip, /referrals, /achievements"
  echo "   4. Deposita fondos y juega"
  exit 0
else
  echo -e "${RED}⚠️  Hay $FAIL verificaciones fallidas${NC}"
  echo ""
  echo "🔧 Revisa los logs en Render:"
  echo "   Dashboard → Servicio → Logs"
  exit 1
fi
