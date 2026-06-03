#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/corde-bot" || exit 1
PORT="${PORT:-3000}"

echo "=== PROCESOS NODE ==="
ps aux | grep -E "node .*dashboard.js" | grep -v grep || echo "No hay Node corriendo"

echo
echo "=== TEST LOCAL ==="
if curl -fsS -I "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  echo "VIVO: http://127.0.0.1:$PORT"
  curl -I "http://127.0.0.1:$PORT" | head -2
else
  echo "CAÍDO: no responde en 127.0.0.1:$PORT"
fi

echo
echo "=== LOG ==="
tail -30 corde.log 2>/dev/null || echo "Sin corde.log"
