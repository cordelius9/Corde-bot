#!/bin/bash
# Cordelius OS — Restart Seguro
# Uso: bash scripts/restart_safe.sh

cd "$(dirname "$0")/.."

echo "→ Deteniendo Cordelius OS..."
./stop.sh 2>/dev/null || true

echo "→ Iniciando Cordelius OS..."
./start.sh

echo "→ Esperando 4 segundos..."
sleep 4

echo "→ Verificando salud..."
RESULT=$(curl -s --max-time 5 http://127.0.0.1:3000/health 2>/dev/null)

if echo "$RESULT" | grep -q '"ok":true'; then
  echo "✓ Cordelius OS: ONLINE y funcionando"
  echo "$RESULT" | tr ',' '\n' | tr -d '{}' | sed 's/^ */  /'
else
  echo "✗ Cordelius OS no respondió después del reinicio"
  echo "→ Revisar: tail -20 corde.log"
  exit 1
fi
