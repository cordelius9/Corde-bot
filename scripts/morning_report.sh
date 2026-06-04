#!/bin/bash
# Cordelius OS — Morning Report
# Uso: bash scripts/morning_report.sh
# Guarda JSON combinado en reports/morning_report_YYYY-MM-DD_HHMMSS.json

cd "$(dirname "$0")/.."

mkdir -p reports

TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
OUTFILE="reports/morning_report_${TIMESTAMP}.json"
BASE="http://127.0.0.1:3000"
OK=true

echo "=== Cordelius OS — Morning Report ==="
echo "Fecha: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

check_endpoint() {
  local name="$1"
  local path="$2"
  local result
  result=$(curl -s --max-time 8 "${BASE}${path}" 2>/dev/null)
  if echo "$result" | grep -q '"ok":true\|"totalValueMXN"\|"assets"'; then
    echo "  ✓ $name"
    echo "$result"
  else
    echo "  ✗ $name — sin respuesta"
    OK=false
    echo "null"
  fi
}

echo "→ Consultando endpoints..."
HEALTH=$(check_endpoint   "Health"            "/health"               | tail -n 1)
BRIEF=$(check_endpoint    "Daily Brief"       "/api/morning-report"   | tail -n 1)
PORTFOLIO=$(check_endpoint "Portfolio"        "/api/portfolio"        | tail -n 1)
INTEL=$(check_endpoint    "Intel"             "/api/intel"            | tail -n 1)

echo ""
echo "→ Guardando en $OUTFILE..."

cat > "$OUTFILE" <<JSONEOF
{
  "generated": "${TIMESTAMP}",
  "source": "morning_report.sh",
  "health": ${HEALTH:-null},
  "morningReport": ${BRIEF:-null},
  "portfolio": ${PORTFOLIO:-null},
  "intel": ${INTEL:-null}
}
JSONEOF

if [ -f "$OUTFILE" ]; then
  echo "✓ Guardado: $OUTFILE"
  SIZE=$(wc -c < "$OUTFILE")
  echo "  Tamaño: ${SIZE} bytes"
else
  echo "✗ Error guardando reporte"
  exit 1
fi

echo ""
if $OK; then
  echo "✓ Morning Report completado sin errores"
else
  echo "⚠ Algunos endpoints fallaron — revisar corde.log"
fi
