#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/corde-bot" || exit 1
PORT="${PORT:-3000}"

echo "Watchdog activo. Ctrl+C para apagarlo."
while true; do
  if ! curl -fsS -I "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "$(date) Cordelius caído, reiniciando..." | tee -a watchdog.log
    ./start.sh >> watchdog.log 2>&1
  fi
  sleep 30
done
