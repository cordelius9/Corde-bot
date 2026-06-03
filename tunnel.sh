#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/corde-bot" || exit 1
PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared no está instalado. Corre: pkg install cloudflared -y"
  exit 1
fi

if ! curl -fsS -I "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  echo "Cordelius no está vivo. Corriendo ./start.sh..."
  ./start.sh
  sleep 4
fi

if curl -fsS -I "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  ORIGIN="http://127.0.0.1:$PORT"
else
  echo "ERROR: Cordelius sigue sin responder. Revisa ./status.sh"
  exit 1
fi

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
unset DNS_SERVER DNS RES_OPTIONS LOCALDOMAIN

echo "Usando cloudflared nativo"
echo "Abriendo Cloudflare Tunnel hacia $ORIGIN"
echo "Deja esta terminal abierta."
echo

cloudflared tunnel --no-autoupdate --protocol http2 --edge-ip-version 4 --url "$ORIGIN" 2>&1 | tee cloudflared.log
