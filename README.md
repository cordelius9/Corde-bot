# Cordelius Trading

Dashboard educativo de seguimiento de portafolio personal con IA.
Corre en **Termux (Android)** con Node.js. Ninguna operación es real.

---

## Requisitos

- **Termux** (Android) con Node.js 18+
- Cuenta en [Anthropic](https://console.anthropic.com/) para Alfredo AI
- (Opcional) Token de Telegram Bot vía [@BotFather](https://t.me/BotFather)
- (Opcional) Clave de [Finnhub](https://finnhub.io/) para cotizaciones en vivo

---

## Instalación en Termux

```bash
# 1. Actualizar paquetes
pkg update && pkg upgrade -y

# 2. Instalar Node.js y git
pkg install nodejs git -y

# 3. Clonar el repo
git clone https://github.com/cordelius9/Corde-bot.git
cd Corde-bot

# 4. Instalar dependencias
npm install

# 5. Configurar variables de entorno
cp .env.example .env
# Editar .env con nano o vim y poner tus claves reales:
nano .env

# 6. Dar permisos a los scripts
chmod +x start.sh stop.sh status.sh tunnel.sh watchdog.sh
```

---

## Uso

```bash
# Iniciar dashboard
./start.sh

# Ver estado
./status.sh

# Detener dashboard
./stop.sh

# Exponer con Cloudflare Tunnel (requiere cloudflared instalado)
./tunnel.sh

# Watchdog (reinicio automático si el proceso cae)
./watchdog.sh &
```

El dashboard estará disponible en:
- Local: http://127.0.0.1:3000
- Público (con tunnel): la URL que muestre `tunnel.sh`

---

## Endpoints de la API

| Ruta | Descripción |
|---|---|
| `GET /` | Dashboard HTML principal |
| `GET /health` | Health check `{"ok":true}` |
| `GET /api/status` | Estado completo (portafolio, bot, intel) |
| `GET /api/portfolio` | Portafolio completo en JSON |
| `GET /api/intel` | Items de Intel manual en JSON |
| `POST /ask` | Pregunta a Alfredo AI |
| `POST /intel` | Agrega item de Intel |

---

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa.

| Variable | Requerida | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Clave de Claude AI |
| `TELEGRAM_BOT_TOKEN` | No | Token del bot Telegram |
| `FINNHUB_API_KEY` | No | Cotizaciones en vivo |
| `USD_MXN` | No | Tipo de cambio (default 18.50) |
| `PORT` | No | Puerto HTTP (default 3000) |
| `CLAUDE_MODEL` | No | Modelo Claude (default claude-sonnet-4-6) |

---

## Seguridad

- El archivo `.env` **nunca** se sube a git (está en `.gitignore`)
- Los archivos de estado runtime (`bot_state.json`, `portfolio_history.json`, etc.) tampoco se suben
- No hay claves hardcodeadas en el código fuente
- Para reportar un problema de seguridad: abre un issue privado en GitHub

---

## Advertencias

> **EDUCATIVO:** Este dashboard no ejecuta órdenes reales en ningún broker.
> El "bot de trading" es completamente ficticio y simulado.
> Alfredo AI no da asesoría financiera — solo muestra escenarios educativos.
> No tomes decisiones de inversión basadas únicamente en este sistema.

---

## Estructura del proyecto

```
Corde-bot/
├── dashboard.js          # App principal (Node.js HTTP server)
├── bot.js                # Bot Telegram + Claude AI
├── trading_ai.js         # Simulador de trading ficticio
├── start.sh              # Iniciar dashboard
├── stop.sh               # Detener dashboard
├── status.sh             # Ver estado
├── tunnel.sh             # Cloudflare Tunnel
├── watchdog.sh           # Reinicio automático
├── package.json          # Dependencias Node.js
├── .env.example          # Template de variables de entorno
├── CLAUDE.md             # Guía para agentes AI
└── .gitignore            # Archivos excluidos de git
```

---

## Dependencias

```json
"@anthropic-ai/sdk": "^0.34.0",
"dotenv": "^16.4.7",
"node-telegram-bot-api": "^0.66.0"
```

Instalar con: `npm install`
