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
# Editar .env con nano y poner tus claves reales:
nano .env

# 6. Dar permisos a los scripts
chmod +x start.sh stop.sh status.sh tunnel.sh watchdog.sh
```

---

## Uso

```bash
# Iniciar dashboard
./start.sh

# Ver estado y últimas líneas del log
./status.sh

# Detener dashboard
./stop.sh

# Verificar sintaxis antes de aplicar cambios
npm run check

# Exponer con Cloudflare Tunnel (requiere cloudflared instalado)
./tunnel.sh

# Watchdog — reinicio automático si el proceso cae
./watchdog.sh &
```

El dashboard estará disponible en:
- Local: `http://127.0.0.1:3000`
- Público (con tunnel): la URL que muestre `tunnel.sh`

---

## Endpoints de la API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Dashboard HTML principal |
| `GET` | `/health` | Health check `{"ok":true,"uptime":N}` |
| `GET` | `/api/status` | Estado completo (portafolio, bot, intel) |
| `GET` | `/api/portfolio` | Portafolio completo con todos los activos en JSON |
| `GET` | `/api/intel` | Items de Intel con resumen de moods y tickers |
| `POST` | `/ask` | Pregunta a Alfredo AI (body: `q=texto`) |
| `POST` | `/intel` | Agrega item de Intel (body: `intel=texto`) |
| `POST` | `/intel/delete` | Borra item Intel por hash (body: `id=hash`) |
| `POST` | `/intel/clear` | Borra todos los items Intel |

---

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa con instrucciones.

| Variable | Requerida | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Clave de Claude AI (Alfredo + bot Telegram) |
| `TELEGRAM_BOT_TOKEN` | No | Token del bot Telegram |
| `FINNHUB_API_KEY` | No | Cotizaciones en vivo de acciones USA |
| `USD_MXN` | No | Tipo de cambio manual (default `18.50`) |
| `PORT` | No | Puerto HTTP (default `3000`) |
| `CLAUDE_MODEL` | No | Modelo para el dashboard (default `claude-sonnet-4-6`) |
| `CLAUDE_MODEL_BOT` | No | Modelo para bot.js (default `claude-haiku-4-5-20251001`) |
| `QUIVER_API_KEY` | No | Datos institucionales: congreso, insiders (pendiente F3) |

---

## Seguridad

- El archivo `.env` **nunca** se sube a git (está en `.gitignore`)
- Los archivos de estado runtime (`bot_state.json`, etc.) tampoco se suben
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
├── trading_ai.js         # Simulador de trading ficticio (port 3001)
├── start.sh              # Iniciar dashboard en background
├── stop.sh               # Detener dashboard
├── status.sh             # Ver estado + tail del log
├── tunnel.sh             # Cloudflare Tunnel (exposición pública)
├── watchdog.sh           # Reinicio automático si el proceso cae
├── package.json          # Dependencias y scripts npm
├── .env.example          # Template de variables de entorno
├── CLAUDE.md             # Guía para agentes AI
├── README.md             # Esta documentación
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
Verificar sintaxis: `npm run check`
