#!/data/data/com.termux/files/usr/bin/bash
set -u
APP_DIR="${APP_DIR:-$HOME/corde-bot}"
PORT="${PORT:-3000}"
LOG_FILE="$APP_DIR/corde.log"
PID_FILE="$APP_DIR/runtime/dashboard.pid"

cd "$APP_DIR" || exit 1
mkdir -p runtime data

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  echo "Cordelius ya está corriendo con PID $(cat "$PID_FILE")"
  exit 0
fi

pkill -f "node .*dashboard.js" 2>/dev/null || true

set -a
[ -f .env ] && . ./.env
set +a

nohup node dashboard.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 5

if curl -fsS -I "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  echo "OK: Cordelius vivo en http://127.0.0.1:$PORT"
else
  echo "ERROR: Cordelius no respondió. Revisa: tail -80 corde.log"
fi
