#!/bin/bash
# Cordelius OS — Health Check
# Uso: bash scripts/health_check.sh

cd "$(dirname "$0")/.."

RESULT=$(curl -s --max-time 5 http://127.0.0.1:3000/health 2>/dev/null)

if echo "$RESULT" | grep -q '"ok":true'; then
  echo "✓ Cordelius OS: ONLINE"
  echo ""
  echo "$RESULT" | tr ',' '\n' | tr -d '{}' | sed 's/^ */  /'
else
  echo "✗ Cordelius OS: OFFLINE o sin respuesta"
  echo ""
  echo "→ Revisar log: tail -20 corde.log"
  echo "→ Reiniciar:   bash scripts/restart_safe.sh"
  if [ -f corde.log ]; then
    echo ""
    echo "--- Últimas 10 líneas de corde.log ---"
    tail -10 corde.log
  fi
  exit 1
fi
