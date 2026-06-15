# CODEMAP.md v1 — Cordelius Personal OS

> Mapa de arquitectura para agentes AI. Uso: pega este archivo al inicio de sesión.
> Branch de referencia: `jarvis-ui-overhaul` | Commit: `b0cffa7`
> Actualizar tras cada Mega-feature.

---

## 1. Arquitectura general

```
Termux / Galaxy Tab S6
  └─ tmux session "cordelius"
        └─ node dashboard.js  ← app principal, puerto 3000
              ├─ http.createServer()   (sin framework, sin npm)
              ├─ PORTFOLIO[]           (18 activos en memoria)
              ├─ whoopCache            (in-memory, NO en disco directo)
              └─ quotes{} / news[]    (in-memory)

  ├─ node trading_ai.js   puerto 3001 (simulador ficticio)
  └─ node bot.js          Telegram + Claude Haiku

APIs externas (solo lectura / OAuth):
  FinnHub → quotes{}
  WHOOP   → whoopCache  (tokens en whoop_tokens.json — NUNCA en git)
  QuiverQuant → datos congreso/insiders
  Anthropic   → Alfredo AI / Jarvis / bot
```

Stack: Node.js ≥18, cero npm, módulos nativos: `http https fs path child_process`.
Todo el "trading" es simulado. Ningún broker real recibe órdenes.

---

## 2. Módulos frontend

CSS: `.mod{display:none}` / `.mod.active-mod{display:block}`
Control: `showMod(name)` — persiste en `localStorage.corde_mod` y URL hash.

| Módulo | Función render | Datos principales |
|---|---|---|
| `home` | `renderHomePortal(pv, reg)` | `portfolioValue()`, `computeDailyNewsletter()` |
| `trading` | `renderSignalCenter(pv, reg)` | `portfolioValue()`, `alfredoAction()`, `computeTradeIdea()` |
| `health` | `renderHealthOSPanel()` | `computeHealthReadiness()` |
| `journal` | `renderJournalModule()` | `computeJournalData()`, `computeAutoJournal()` |
| `intelligence` | `renderDailyScanCard()`, `renderExternalRadar()`, `renderQuiverPanel()` | `computeDailyScan()`, `computeExternalMarketIntelligence()` |
| `jarvis` | `renderJarvisPrivatePanel()`, `renderExecutivePanel()` | `buildJarvisPrivateSummary()`, `buildExecutiveBriefing()` |
| `autopilot` | `renderAutopilotPanel()` | `getAutopilotDatabaseState()`, `computeAutopilotLearning()` |
| `doctor` | `renderCordeliusDoctor()` | `buildSecurityAudit()`, `computeJarvisBrain()` |

> Las 5 funciones anteriores están confirmadas en `dashboard.js` (b0cffa7):
> `renderCordeliusDoctor`, `buildSecurityAudit`, `computeJarvisBrain`, `buildTodayFeed`, `getAutomationState`

---

## 3. Mapa de endpoints

Fuente de verdad: `ENDPOINT_PERMISSIONS` en `dashboard.js`. Clasificaciones verificadas contra ese objeto.

### publicRead — sin auth requerida
```
/login            /logout           /health           /healthz
/api/ui-diagnostics                 /api/security/audit
/whoop/auth       /whoop/callback   /api/whoop/callback
```

### privateRead — requieren sesión o X-Cordelius-Key
```
/api/status                /api/portfolio             /api/intel
/api/quiver                /api/quiver/matches         /api/quiver/trending
/api/executive             /api/executive/score        /api/project/status
/api/project/memory        /api/decisions              /api/decisions/patterns
/api/decisions/playbook    /api/opportunities          /api/research/queue
/api/watchlist/opportunities                           /api/jarvis/memory
/api/jarvis/brain          /api/feed/today             /api/automations
/api/ledger                /api/alerts                 /api/daily-scan
/api/market-radar          /api/intelligence           /api/intelligence/feed
/api/daily-brief           /api/market-intelligence    /api/external-radar
/api/paper/status          /api/morning-report         /api/whoop/status
/api/whoop/profile         /api/whoop/cycle            /api/whoop/today
/api/autopilot/database    /api/autopilot/progress     /api/journal/auto
/api/journal/status        /api/health-readiness       /api/health/behaviors/today
/api/health/snapshot       /api/health/insights        /api/trading/summary
/api/alfredo/context       /api/os-status
```
> Rutas adicionales como `/api/jarvis/private-memory`, `/api/daily/today`, `/api/executive/history` pueden existir como handlers pero no están en `ENDPOINT_PERMISSIONS` — **PENDIENTE DE VERIFICAR**.

### mutateProtected — requieren auth ⚠️
Fuente: `ENDPOINT_PERMISSIONS` — lista exacta:
```
POST /ask                         POST /research
POST /intel                       POST /intel/delete
POST /api/health/behavior         POST /alerts/dismiss
POST /api/opportunities/run       POST /api/research/queue/add
POST /api/research/queue/remove   POST /api/research/queue/run
POST /api/mode/defensive          POST /api/alerts/dry-run
POST /api/autopilot/snapshot
```
> Total confirmado: 13. El invariante `protectedMutationEndpoints ≥ 18` puede incluir rutas no registradas en `ENDPOINT_PERMISSIONS` — **PENDIENTE DE VERIFICAR**.

### mutateLocal — toggles locales de bajo riesgo
```
GET /toggle-thinking    GET /bot/start    GET /bot/pause
```

### dangerous — destructivo, sin posibilidad de deshacer
```
POST /intel/clear    GET /bot/reset
```
> `/whoop/auth`, `/whoop/callback`, `/api/whoop/callback` son `publicRead` según `ENDPOINT_PERMISSIONS` (inician OAuth pero no escriben datos directamente).

---

## 4. Funciones core

### Árbol de dependencias crítico
```
computeJarvisBrain()  ← sirve GET /api/jarvis/brain
  ├─ buildJarvisPrivateSummary()
  │     └─ computeJarvisOperatingMode()
  │           └─ computeHealthReadiness()  ← whoopCache IN-MEMORY
  ├─ portfolioValue() → assetLiveValue() → quotes{}
  ├─ computeDailyScan() / getOpportunityState()
  ├─ loadJSON("data/jarvis_daily_brief.json")   ← fuente de verdad: biologicalState
  └─ loadJSON("data/jarvis_action_plan.json")   ← fuente de verdad: tradingPermission

renderHomePortal(pv, reg)
  ├─ computeDailyNewsletter() → computeIntelligence() → news[] + Quiver
  └─ portfolioValue()

buildSecurityAudit()  ← sirve GET /api/security/audit (publicRead)
  └─ lee ENDPOINT_PERMISSIONS, clasifica por nivel, retorna totales e invariantes
```

### Tabla de funciones por área

| Área | Función | Propósito |
|---|---|---|
| Portfolio | `portfolioValue()` | Totales MXN/USD, ganancias, riesgo |
| Portfolio | `assetScore(a)` | Score 0-100 por activo |
| Portfolio | `alfredoAction(a)` | Señal: MANTENER/BUY DIP/VIGILAR/etc |
| Portfolio | `indicators(a)` | RSI, MACD, momentum (deterministicos) |
| Salud | `computeHealthReadiness()` | Scores numéricos desde `whoopCache` in-memory |
| Salud | `refreshWhoopCache()` | Llama WHOOP API, actualiza `whoopCache` |
| Salud | `computeJarvisOperatingMode(w,c)` | ÓPTIMO/MODERADO/DEFENSIVO/DESCANSO |
| Inteligencia | `computeDailyScan()` | Scan diario: scores, oportunidades |
| Inteligencia | `computeIntelligence()` | Consolidado: portfolio + external + Quiver |
| Inteligencia | `computeDailyNewsletter()` | Newsletter con bullets de acción |
| Inteligencia | `classifyNews(n)` | mood, tickers afectados, tags |
| Jarvis | `buildJarvisPrivateSummary()` | Estado fisiológico + modo operativo |
| Jarvis | `buildJarvisContext()` | Contexto completo para prompt Claude |
| Jarvis | `buildExecutiveBriefing()` | Briefing ejecutivo AI |
| Jarvis | `readPrivateJarvisMemory()` | Perfil privado, reglas, preguntas diarias |
| Doctor | `computeJarvisBrain()` | Fused context: health + portfolio + oportunidades |
| Doctor | `buildTodayFeed()` | Feed del día: noticias + intel + alertas |
| Doctor | `getAutomationState()` | Estado de automations + reglas disparadas |
| Doctor | `buildSecurityAudit()` | Auditoría de endpoints vs ENDPOINT_PERMISSIONS |
| Doctor | `renderCordeliusDoctor()` | Panel Doctor con diagnóstico en vivo |
| Autopilot | `getAutopilotDatabaseState()` | Estado completo autopilot |
| Autopilot | `analyzeDecisionPatterns()` | Patrones estadísticos de decisiones |
| Autopilot | `buildPersonalPlaybook(patterns)` | Playbook desde patterns |
| Sistema | `loadJSON(file, fallback)` | Lectura segura JSON |
| Sistema | `writeJSONAtomic(file, data)` | Escritura atómica en `data/` |
| Sistema | `render()` | Genera HTML completo del dashboard |
| Sistema | `boot()` | Arranca server + intervals + refreshes |
| Intel | `intelHash(text)` | Fingerprint para deduplicación |
| Intel | `analyzeIntelText(text)` | Clasifica texto: mood, tickers, tags |

> ⚠️ **CRÍTICO WHOOP:** `whoop_today_cache.json` guarda objetos API crudos `{records:[...]}`, NO números.
> Siempre usar `computeHealthReadiness()` para valores numéricos. Nunca leer el archivo directamente para scores.

> ⚠️ **CRÍTICO ESTADO:** Confiar en `jarvis_daily_brief.json → biologicalState` antes de recomputar desde WHOOP.
> Confiar en `jarvis_action_plan.json → tradingPermission` antes de recomputar trading mode.

---

## 5. Archivos de datos

> ⚠️ Todos en `.gitignore`. NUNCA commitear ninguno.

### Root — cargados al boot
| Archivo | Variable | Propósito |
|---|---|---|
| `bot_state.json` | `BOT_FILE` | Estado bot ficticio |
| `portfolio_history.json` | `HISTORY_FILE` | Historial de valuaciones |
| `alfredo_chat_history.json` | `CHAT_FILE` | Historial chat AI |
| `cordelius_settings.json` | `SETTINGS_FILE` | Config usuario |
| `cordelius_intel.json` | `INTEL_FILE` | Items Intel manual |
| `cordelius_journal.json` | `JOURNAL_FILE` | Entradas del diario |
| `whoop_today_cache.json` | *(inline)* | Cache raw WHOOP (objetos, NO números) |
| `whoop_tokens.json` | `WHOOP_TOKEN_FILE` | **SECRETO — NUNCA leer ni mencionar contenido** |

### data/ — escritura atómica en runtime
```
health_snapshots.json           portfolio_snapshots.json
trading_decisions.json          autopilot_memory.json
cordelius_progress.json         decision_outcomes.json
daily_learning.json             market_daily_snapshots.json
user_daily_checkins.json        cordelius_patterns.json
daily_intelligence_summary.json cordelius_alerts.json
cordelius_portfolio.json        market_brain.json
market_brain_history.json       market_watchlist.json
project_memory.json             build_log.json
cordelius_roadmap.json          executive_briefing.json
executive_briefing_history.json decision_journal.json
decision_patterns.json          personal_playbook.json
jarvis_private_profile.json     jarvis_health_rules.json
jarvis_daily_questions.json     jarvis_risk_rules.json
jarvis_checkins.json
jarvis_daily_brief.json         ← fuente de verdad: biologicalState
jarvis_action_plan.json         ← fuente de verdad: tradingPermission
```

### In-memory (no persisten entre reinicios)
```
whoopCache    quotes{}    news[]    intelItems[]    chatHistory[]    bot{}
```

---

## 6. Security invariants

| Invariante | Valor requerido |
|---|---|
| `dashboardProtected` | `true` — login wall en `GET /` |
| `privateReadProtected` | `true` — API reads requieren auth |
| `accessKeyConfigured` | `true` — `CORDELIUS_ACCESS_KEY` en env |
| `protectedMutationEndpoints` | ≥ 18 |
| `unprotectedMutationEndpoints` | 0 — cero mutaciones sin auth |

`buildSecurityAudit()` calcula estos valores dinámicamente desde `ENDPOINT_PERMISSIONS`.
Verificar en vivo: `curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool`

### Variables de entorno (solo nombres, sin valores)
```
ANTHROPIC_API_KEY   TELEGRAM_BOT_TOKEN   FINNHUB_API_KEY
USD_MXN             PORT                 CLAUDE_MODEL
CLAUDE_MODEL_BOT    QUIVER_API_KEY       TELEGRAM_CHAT_ID
CORDELIUS_ACCESS_KEY  WHOOP_CLIENT_ID      WHOOP_CLIENT_SECRET
```
Siempre via `process.env.VAR || "default_seguro"`. Nunca hardcodeados.

### Modelos Claude correctos
```
dashboard.js → process.env.CLAUDE_MODEL     || "claude-sonnet-4-6"
bot.js       → process.env.CLAUDE_MODEL_BOT || "claude-haiku-4-5-20251001"
```
Obsoletos a reemplazar: `claude-3-5-*`, `claude-sonnet-4-5`, `claude-haiku-4-5` (sin sufijo fecha).

---

## 7. Flujo de runtime en Termux

```bash
# 1. Pull (nunca desde main)
git -C ~/corde-bot pull origin jarvis-ui-overhaul

# 2. Backup antes de tocar dashboard.js
cp dashboard.js dashboard_backup_$(date +%Y%m%d_%H%M%S).js

# 3. Aplicar cambio

# 4. Syntax check — obligatorio antes de reiniciar
node --check dashboard.js

# 5. Reiniciar
tmux kill-session -t cordelius 2>/dev/null || true
sleep 2
# Guardia: si /healthz sigue respondiendo, hay proceso huérfano fuera de tmux.
# NO arrancar un segundo proceso. Diagnóstico: ps aux | grep "node dashboard.js" | grep -v grep
# Intervención manual (no default): pkill -f "node dashboard.js"
curl -sf http://127.0.0.1:3000/healthz && echo "PROCESO HUERFANO — limpiar manualmente antes de continuar" && exit 1 || true
TERMUX_HOME=/data/data/com.termux/files/home
tmux new -d -s cordelius "cd ${TERMUX_HOME}/corde-bot && set -a && . ./.env && set +a && APP_DIR=\"\$(pwd)\" node dashboard.js"
sleep 4

# 6. Health check
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool

# 7. Security audit (verifica invariantes)
curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool

# 8. Commit solo después de confirmación visual
git add dashboard.js && git commit -m "feat/fix: descripción"
git push origin jarvis-ui-overhaul
```

---

## 8. Reglas para futuros agentes

| Regla | Detalle |
|---|---|
| Flujo obligatorio | Backup → patch → `node --check` → restart → curl → commit |
| WHOOP numérico | Usar `computeHealthReadiness()`, nunca `loadJSON("whoop_today_cache.json")` |
| Estado del día | Leer `jarvis_daily_brief.json → biologicalState` antes de recomputar |
| Trading mode | Leer `jarvis_action_plan.json → tradingPermission` antes de recomputar |
| Anchors de patch | Usar nombres de función, no números de línea (cambian cada commit) |
| Sin secretos | NUNCA leer `whoop_tokens.json`, NUNCA hardcodear keys |
| Sin trading real | Todo es simulado/educativo |
| Sin merge de ramas rotas | `jarvis-private-memory` tiene UI rota — no mergear |

### Congelado — no tocar sin permiso explícito
```
showMod(name)              — navegación frontend
renderHomePortal(pv, reg)  — home module
<meta http-equiv="refresh"> — eliminada (Android hash-drop bug)
main branch  — nunca pushear directo
```

### Patrón seguro de patch script
```javascript
if (src.includes(NEW_MARKER))    { console.log("SKIP: ya aplicado"); process.exit(0); }
if (!src.includes(OLD_ANCHOR))   { console.error("ERROR: anchor no encontrado"); process.exit(1); }
fs.copyFileSync(DASHBOARD, bak); // backup
src = src.replace(OLD_ANCHOR, NEW_ANCHOR);
fs.writeFileSync(DASHBOARD, src);
execSync("node --check " + DASHBOARD); // si falla → restore bak
```

---

## 9. Backlog técnico

| ID | Descripción | Estado |
|---|---|---|
| F3a | Quiver Quant live — congressional/insider/govcontracts endpoints | PENDIENTE |
| F3b | Alertas push Telegram — `notifyTelegram()` + `TELEGRAM_CHAT_ID` | PENDIENTE |
| F3c | Portfolio editable runtime — `POST /portfolio/update` ya existe | PARCIAL |
| B1 | NaN en Recovery — `fix-brain-patch.js` pendiente de aplicar en tablet | PENDIENTE |
| B2 | State mismatch brain vs daily-brief — `fix-brain-patch.js` | PENDIENTE |
| #11 | CODEMAP workflow + evaluación knowledge graph tools | EN PROGRESO |

### Evaluación pendiente (issue #11)
Herramientas a evaluar para siguiente fase:
- MCP memory-server (Anthropic) — ¿funciona sin npm extra en Termux?
- Graphify / codebase-memory
- Context7 para docs de librerías
- CLAUDE.md + CODEMAP.md estático (enfoque actual)

---

## 10. Qué NO tocar

```
# Código congelado
showMod()               renderHomePortal()      render()      boot()

# Rutas OAuth (tokens reales)
/whoop/auth             /whoop/callback         /api/whoop/callback

# Archivos — nunca en git
.env                    whoop_tokens.json       data/*.json
*.log                   dashboard_backup_*.js

# Branch protegida
main                    (nunca pushear directo)

# Branch a no mergear
jarvis-private-memory   (UI rota — endpoints OK, nav rota)

# Invariantes que no deben bajar
protectedMutationEndpoints ≥ 18
unprotectedMutationEndpoints = 0
```

---

## 11. Cómo usar este CODEMAP en futuras sesiones

### Para Claude / ChatGPT / Codex al iniciar sesión

```
Contexto del proyecto: pega el contenido de CODEMAP.md
Luego di: "Eres un agente trabajando en Cordelius Personal OS.
Lee el CODEMAP y confirma que entendiste la arquitectura antes de proponer cambios."
```

### Preguntas de orientación rápida para el agente

| Si necesitas... | Consulta |
|---|---|
| Lista de endpoints | Sección 3 |
| Dónde vive una función | Sección 4, tabla de funciones |
| Qué archivo guarda X dato | Sección 5 |
| Si puedes tocar algo | Sección 10 |
| Secuencia de deploy | Sección 7 |
| Reglas de seguridad | Secciones 6 y 8 |

### Comandos de diagnóstico rápido

```bash
# Ver módulos frontend
grep -n "^function render" dashboard.js

# Ver clasificación real de endpoints
grep -n "ENDPOINT_PERMISSIONS" dashboard.js

# Verificar modelos Claude (no deben ser obsoletos)
grep -n "claude-3-5\|claude-sonnet-4-5\b\|claude-haiku-4-5\b" dashboard.js bot.js

# Estado del sistema
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# Security audit (invariantes en vivo)
curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool
```

### Cuándo actualizar este CODEMAP

- Después de cada Mega-feature
- Al agregar o eliminar endpoints
- Al agregar funciones core nuevas
- Al cambiar archivos de datos o su propósito
- Al resolver un item de backlog
- Al verificar una sección marcada "PENDIENTE DE VERIFICAR"

---

*CODEMAP.md v1 | 2026-06-14 | branch `jarvis-ui-overhaul` | commit base `b0cffa7`*
*Secciones marcadas "PENDIENTE DE VERIFICAR" requieren confirmación en el tablet.*
