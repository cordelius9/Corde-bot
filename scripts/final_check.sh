#!/bin/bash
# Cordelius OS — Final Check antes de commit/push
# Uso: bash scripts/final_check.sh

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    echo "  ✓ $label"
    ((PASS++))
  else
    echo "  ✗ $label — $result"
    ((FAIL++))
  fi
}

echo "=== Cordelius OS — Final Check ==="
echo "Fecha: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Git status ---
echo "[ Git ]"
GIT_STATUS=$(git status --short 2>/dev/null)
if [ -z "$GIT_STATUS" ]; then
  check "Working tree limpio" "ok"
else
  echo "  Cambios pendientes:"
  echo "$GIT_STATUS" | sed 's/^/    /'
fi

# --- Sintaxis dashboard.js ---
echo ""
echo "[ Sintaxis ]"
if node --check dashboard.js 2>/dev/null; then
  check "dashboard.js sintaxis" "ok"
else
  check "dashboard.js sintaxis" "ERROR DE SINTAXIS — no hacer push"
fi

# --- Health ---
echo ""
echo "[ Endpoints ]"
HEALTH=$(curl -s --max-time 5 http://127.0.0.1:3000/health 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok":true'; then
  check "/health" "ok"
else
  check "/health" "sin respuesta (¿está corriendo?)"
fi

# Check key endpoints if server is up
if echo "$HEALTH" | grep -q '"ok":true'; then
  for EP in "/api/portfolio" "/api/intel" "/api/daily-brief" "/api/morning-report" "/api/paper/status"; do
    R=$(curl -s --max-time 5 "http://127.0.0.1:3000${EP}" 2>/dev/null)
    if [ -n "$R" ] && [ "$R" != "Not found" ]; then
      check "$EP" "ok"
    else
      check "$EP" "sin respuesta"
    fi
  done
fi

# --- Secrets check ---
echo ""
echo "[ Secrets ]"
DIFF=$(git diff HEAD 2>/dev/null; git diff --cached 2>/dev/null)
if echo "$DIFF" | grep -qiE 'sk-ant-|Bearer [A-Za-z0-9]{20,}|ANTHROPIC_API_KEY\s*=\s*[A-Za-z]|TELEGRAM.*TOKEN\s*=\s*[0-9]'; then
  check "Sin secrets en diff" "POSIBLE SECRET DETECTADO — revisar antes de push"
else
  check "Sin secrets en diff" "ok"
fi

if [ -f .env ]; then
  if git ls-files --error-unmatch .env 2>/dev/null; then
    check ".env fuera de git" ".env está TRACKED — eliminar del repo"
  else
    check ".env no está en git" "ok"
  fi
fi

# --- Cloudflare ---
echo ""
echo "[ Cloudflare ]"
if [ -f cloudflared.log ]; then
  CF_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' cloudflared.log 2>/dev/null | tail -1)
  if [ -n "$CF_URL" ]; then
    echo "  Último tunnel: $CF_URL"
  else
    echo "  Sin URL de tunnel activo"
  fi
else
  echo "  cloudflared.log no encontrado"
fi

# --- Resumen ---
echo ""
echo "=== Resultado ==="
echo "  Pasaron: $PASS"
echo "  Fallaron: $FAIL"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✓ Todo OK — listo para commit y push"
else
  echo "⚠ Hay $FAIL verificaciones fallidas — revisar antes de push"
  exit 1
fi
