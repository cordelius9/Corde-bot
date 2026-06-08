#!/data/data/com.termux/files/usr/bin/bash
# Auto-restart loop for Jarvis Telegram Bot (Cordelius OS)
APP_DIR="${APP_DIR:-$HOME/corde-bot}"
LOG_FILE="$APP_DIR/telegram.log"
PID_FILE="$APP_DIR/runtime/telegram.pid"

cd "$APP_DIR" || { echo "ERROR: no se puede entrar a $APP_DIR"; exit 1; }
mkdir -p runtime

set -a
[ -f .env ] && . ./.env
set +a

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN no configurado en .env — bot no puede iniciar."
  exit 1
fi

# Avoid duplicate instances
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  echo "Jarvis Bot ya está corriendo con PID $(cat "$PID_FILE")"
  exit 0
fi

echo "$(date) Iniciando Jarvis Bot (auto-restart activado)..." | tee -a "$LOG_FILE"

while true; do
  node "$APP_DIR/bot.js" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "$(date) bot.js iniciado (PID $!)" | tee -a "$LOG_FILE"
  wait "$(cat "$PID_FILE")"
  echo "$(date) bot.js terminó. Reiniciando en 5s..." | tee -a "$LOG_FILE"
  sleep 5
done
