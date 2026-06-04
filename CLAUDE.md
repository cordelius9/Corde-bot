# CLAUDE.md — Cordelius Trading

Guía para agentes AI (Claude Code, GPT, Gemini) que trabajen en este repo.

## Qué es este proyecto

Dashboard educativo de seguimiento de portafolio de inversión personal.
Corre en **Termux (Android)** con Node.js. No ejecuta operaciones reales.
Todo el "trading" es **simulado/ficticio** — ningún broker real recibe órdenes.

## Archivos principales

| Archivo | Propósito |
|---|---|
| `dashboard.js` | App principal: servidor HTTP, portafolio, Alfredo AI, Intel, bot ficticio |
| `bot.js` | Bot Telegram con Claude AI (responde mensajes del usuario) |
| `trading_ai.js` | Simulador de trading ficticio (Plata, port 3001) |
| `bot.py` | Bot Python con detección de régimen de mercado (experimental) |
| `dashboard.py` | Wrapper Flask legacy (no es el principal) |

## Scripts operativos

```bash
./start.sh     # Inicia dashboard.js en background (guarda PID)
./stop.sh      # Mata el proceso
./status.sh    # Verifica si está corriendo + tail del log
./tunnel.sh    # Inicia Cloudflare Tunnel para exposición pública
./watchdog.sh  # Loop de reinicio automático si el proceso cae

# Automatización (Mega 7 — ver AUTOMATION.md)
bash scripts/health_check.sh     # Verifica /health
bash scripts/restart_safe.sh     # Reinicio seguro con health check
bash scripts/morning_report.sh   # Reporte matutino → reports/
bash scripts/final_check.sh      # Validación antes de push
```

## Variables de entorno requeridas

Ver `.env.example`. Las variables NUNCA deben hardcodearse en código.

```
ANTHROPIC_API_KEY    → Claude AI (Alfredo en dashboard + bot Telegram)
TELEGRAM_BOT_TOKEN   → Bot Telegram
FINNHUB_API_KEY      → Cotizaciones en vivo (opcional)
USD_MXN              → Tipo de cambio manual (default 18.50)
PORT                 → Puerto HTTP (default 3000)
CLAUDE_MODEL         → Modelo Claude para dashboard (default claude-sonnet-4-6)
CLAUDE_MODEL_BOT     → Modelo Claude para bot.js (default claude-haiku-4-5-20251001)
QUIVER_API_KEY       → Quiver Quant — datos congreso/insiders (pendiente F3a)
TELEGRAM_CHAT_ID     → ID de chat para alertas push (pendiente F3b)
```

## Archivos runtime (NO en git)

Estos archivos se crean en ejecución y están en `.gitignore`:

```
.env
bot_state.json          → Estado del bot ficticio
portfolio_history.json  → Historial de valuaciones
alfredo_chat_history.json
cordelius_settings.json
cordelius_intel.json    → Items de Intel manual
cordelius_alerts.json   → Alertas activas (F3b, pendiente)
ai_chat_history.json
corde.log
cloudflared.log
watchdog.log
runtime/dashboard.pid
```

## Arquitectura de dashboard.js

```
PORTFOLIO[]            → Array con 18 activos (GBM, Plata, Bitso)
portfolioValue()       → Calcula totales MXN/USD, ganancias, riesgo
assetLiveValue()       → Precio actual (manual + drift simulado)
indicators()           → RSI, MACD, momentum, volatility (deterministicos)
alfredoAction()        → Señal: MANTENER / BUY DIP / VIGILAR / etc.
handleAsk()            → POST /ask → Claude API con contexto rico
handleIntel()          → POST /intel → guarda item de Intel (con dedup por hash)
handleIntelDelete()    → POST /intel/delete → borra item por hash
handleIntelClear()     → POST /intel/clear → borra todos los items
intelHash()            → Fingerprint determinístico para deduplicación
intelMatchWord()       → Regex word-boundary (evita falsos positivos como "seria"→"ia")
analyzeIntelText()     → Clasifica texto: mood, affected tickers, tags, hash
renderIntelPanel()     → Panel Intel con filtros de mood, contadores y botón clear
renderIntelByAsset()   → Sección Intel agrupada por ticker del portafolio
botTick()              → Ejecuta tick del bot ficticio
render()               → Genera HTML del dashboard completo
boot()                 → Arranca server + refreshes + intervals
```

## Endpoints HTTP

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Dashboard HTML principal |
| POST | `/ask` | Pregunta a Alfredo AI (Claude) |
| POST | `/intel` | Agrega item de Intel manual (dedup automático) |
| POST | `/intel/delete` | Borra item Intel por hash |
| POST | `/intel/clear` | Borra todos los items Intel |
| GET | `/toggle-thinking` | Alterna modo thinking de Claude |
| GET | `/bot/start` | Enciende bot ficticio |
| GET | `/bot/pause` | Pausa bot ficticio |
| GET | `/bot/reset` | Reinicia bot ficticio |
| GET | `/health` | Health check JSON |
| GET | `/api/status` | Estado completo JSON |
| GET | `/api/portfolio` | Portafolio completo JSON |
| GET | `/api/intel` | Items de Intel JSON con resumen por mood y ticker |

## Reglas de seguridad para agentes

1. **NUNCA** hardcodear API keys, tokens ni secretos
2. **NUNCA** subir `.env` ni archivos runtime al repo
3. **NUNCA** modificar archivos de runtime directamente
4. Usar siempre `process.env.VARIABLE || "default_seguro"`
5. Antes de cualquier patch en `dashboard.js`: hacer `node --check dashboard.js`
6. Cambios incrementales — no reescribir todo el dashboard
7. Backup antes de editar: `cp dashboard.js dashboard_backup_$(date +%Y%m%d_%H%M%S).js`

## Modelo Claude correcto

```javascript
// dashboard.js
process.env.CLAUDE_MODEL || "claude-sonnet-4-6"

// bot.js
process.env.CLAUDE_MODEL_BOT || "claude-haiku-4-5-20251001"
```

Modelos obsoletos a reemplazar si se encuentran:
- `claude-3-5-haiku-20241022` → `claude-haiku-4-5-20251001`
- `claude-3-5-sonnet-20241022` → `claude-sonnet-4-6`
- `claude-sonnet-4-5` → `claude-sonnet-4-6`
- `claude-haiku-4-5` (sin fecha) → `claude-haiku-4-5-20251001`

## Flujo de desarrollo seguro

```bash
# 1. Backup antes de editar dashboard.js
cp dashboard.js dashboard_backup_$(date +%Y%m%d_%H%M%S).js

# 2. Aplicar patch

# 3. Verificar sintaxis
node --check dashboard.js

# 4. Reiniciar
./stop.sh && ./start.sh

# 5. Probar endpoints
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/api/intel

# 6. Verificar git
git status --short
# Asegurarse que .env y runtime JSON no aparecen
```

## Contexto financiero

- Portafolio **educativo**: no da asesoría ni ejecuta órdenes reales
- Respuestas de Alfredo AI: siempre en escenarios (mantener / vigilar / reducir riesgo)
- Brokers en portafolio: GBM (México), Plata (USA fraccional), Bitso (cripto)
- Monedas: MXN primario, USD para Plata, conversión via `FX_USD_MXN`
- Riesgo especial: concentración en cripto/Bitso debe señalarse siempre

## Estado de issues

| ID | Descripción | Estado |
|---|---|---|
| P6 | `bot.js` usaba `CLAUDE_API_KEY` en vez de `ANTHROPIC_API_KEY` | ✅ RESUELTO en F2b |
| P7 | `bot.js` usaba `claude-haiku-4-5` sin sufijo de fecha | ✅ RESUELTO en F2b |
| P8 | `.gitignore` con entradas duplicadas y basura | ✅ RESUELTO en F2d |
| P9 | Intel: sin deduplicación ni filtros | ✅ RESUELTO en F2a/F2c |
| M5 | UI Cordelius OS / Jarvis: Daily Brief, brain 16 nodos, paper panel | ✅ RESUELTO en Mega 5 |
| M6 | Market intelligence engine: Quiver, external radar, newsletter | ✅ RESUELTO en Mega 6 |
| M7 | Automatización: scripts, morning report, autopilot panel | ✅ RESUELTO en Mega 7 |
| M8 | Personal OS: Health Readiness, WHOOP placeholder, home minimalista | ✅ RESUELTO en Mega 8 |
| F3a | Quiver Quant: congressional + insider trading (API live) | 🔲 PENDIENTE |
| F3b | Alertas push vía Telegram | 🔲 PENDIENTE |
| F3c | Portfolio editable en runtime sin tocar código | 🔲 PENDIENTE |

## Próxima fase F3 — pendiente de implementación

### F3a — Quiver Quant (datos institucionales)

`QUIVER_API_KEY` ya está declarada en `dashboard.js` línea 8 y mostrada en el panel Sistema.
Solo falta conectar los endpoints.

```
Endpoints a consumir:
  GET https://api.quiverquant.com/beta/live/congresstrading
  GET https://api.quiverquant.com/beta/live/insiders
  GET https://api.quiverquant.com/beta/live/govcontracts

Nueva env var: QUIVER_API_KEY (ya en .env.example)
Cache sugerido: 30 minutos (plan gratuito tiene límite ~50 req/día)
Filtrar: solo tickers presentes en PORTFOLIO[]
```

Funciones nuevas en `dashboard.js`:
- `fetchQuiverData()` — GET con cache 30 min, filtra por PORTFOLIO
- `renderQuiverPanel()` — tablas Congressional + Insider
- Contexto Quiver en `askClaude()` prompt

### F3b — Sistema de alertas

```
Tipos de alerta propuestos:
  DRAWDOWN_CRIPTO   → XRP/ETH/BTC cae >5% en el día
  SCORE_CRITICO     → Cualquier activo baja a score ≤25/100
  CONCENTRACION     → Cripto/Bitso > 50% del portafolio
  BUY_DIP_OPORT     → Score>55 + caída >3% en el día
  TOMA_GANANCIA     → Ganancia >100% + momentum positivo

Nueva env var: TELEGRAM_CHAT_ID (ID numérico para notificaciones push)
Nuevo runtime: cordelius_alerts.json (ya en .gitignore)
```

Funciones nuevas en `dashboard.js`:
- `checkAlerts()` — corre en cada `refreshQuotes()`
- `renderAlertsPanel()` — panel de alertas activas
- `notifyTelegram(alert)` — POST a Telegram Bot API
- Endpoint `POST /alerts/dismiss` — marcar alerta como leída

### F3c — Portfolio editable en runtime

```
Endpoint: POST /portfolio/update
Body: symbol=AAPL&valueManual=5800&costManual=2640

Nuevo runtime: cordelius_portfolio.json
Carga al inicio; sobreescribe valueManual/costManual del array PORTFOLIO[]
```

Esto permite actualizar precios sin editar `dashboard.js`.
