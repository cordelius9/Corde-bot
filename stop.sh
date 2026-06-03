#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/corde-bot" || exit 1
pkill -f "node .*dashboard.js" 2>/dev/null || true
rm -f runtime/dashboard.pid
echo "Cordelius detenido"
